// Package rtc embeds the media server in this process.
//
// LiveKit ships as a library whose server can be constructed and started
// directly, which is what makes a single binary possible: the token this server
// signs is verified by the same credentials, in the same process, with no second
// service to deploy and no shared secret to distribute.
//
// Its own HTTP listener is kept on the loopback interface. Everything a browser
// talks to arrives at [tomoshibi/internal/app], which forwards the signalling
// paths here. That leaves one port facing the network for TCP, and it is ours.
package rtc

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"time"

	"github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/routing"
	"github.com/livekit/livekit-server/pkg/service"
	"github.com/livekit/livekit-server/pkg/telemetry/prometheus"
	"github.com/livekit/protocol/livekit"
)

// Paths the media server owns. Everything else belongs to the application.
//
// `/rtc` is the signalling WebSocket, `/twirp` the management API the client
// never calls but the SDKs expect to find, and `/rtc/validate` a health check
// clients use before connecting.
var Paths = []string{"/rtc", "/rtc/", "/twirp/"}

// Server is the embedded media server together with a proxy to its listener.
type Server struct {
	inner *service.LivekitServer
	proxy *httputil.ReverseProxy
	node  routing.LocalNode
	// upstream is where this process reaches the media server's own HTTP,
	// which is loopback and nowhere else.
	upstream string

	// The throughput this server has actually moved, measured here rather than
	// read from the media server.
	//
	// Its own figures come as a list of rates over windows it chooses, and the
	// shortest of them — which is the only current one — is noisy where it is
	// not simply empty. What a page wants is one number that means bytes a
	// second and is the same number every time it is asked, so the counters are
	// sampled on a ticker and the difference divided by the time between.
	rate struct {
		mu     sync.Mutex
		in     float64
		out    float64
		window time.Duration

		lastIn  uint64
		lastOut uint64
		lastAt  time.Time
	}
}

// How often the byte counters are sampled.
//
// Five seconds. Short enough that a page redrawn every five reflects what is
// happening now, long enough that a call starting mid-sample does not read as a
// spike ten times its real rate.
const throughputEvery = 5 * time.Second

// Start builds and starts the media server, returning once it is accepting
// connections.
func Start(conf *config.Config) (*Server, error) {
	// The media server logs through its own package rather than the standard
	// library, and left uninitialised it says nothing at all: a session that
	// fails to set up looks exactly like one that never happened.
	config.InitLoggerFromConfig(&conf.Logging)

	node, err := routing.NewLocalNode(conf)
	if err != nil {
		return nil, fmt.Errorf("build a routing node: %w", err)
	}

	// Before the server is built, not after: it installs the hardware-stats
	// collectors the routing layer reads from, and without it the stats worker
	// dereferences a nil pointer within a second of starting.
	if err := prometheus.Init(string(node.NodeID()), node.NodeType()); err != nil {
		return nil, fmt.Errorf("initialise metrics: %w", err)
	}

	inner, err := service.InitializeServer(conf, node)
	if err != nil {
		return nil, fmt.Errorf("build the media server: %w", err)
	}

	failed := make(chan error, 1)
	go func() {
		// Start blocks until the server stops, so a failure to bind shows up
		// here rather than as a server that quietly never came up.
		failed <- inner.Start()
	}()

	if err := await(inner, failed); err != nil {
		return nil, err
	}

	address := fmt.Sprintf("http://127.0.0.1:%d", inner.HTTPPort())

	upstream, err := url.Parse(address)
	if err != nil {
		return nil, fmt.Errorf("address the media server: %w", err)
	}

	server := &Server{
		inner:    inner,
		proxy:    httputil.NewSingleHostReverseProxy(upstream),
		node:     node,
		upstream: address,
	}

	go server.watchThroughput()

	return server, nil
}

// Stats is what the media server knows about its own load.
//
// Read, and only read. Asking the node to refresh on the way out looks like the
// careful thing and is the opposite: refreshing appends to a ring of samples the
// server keeps for working out rates, and a rate is only emitted when that ring
// still holds something ten seconds old. The ring has five places. Filled at the
// server's own pace that is exactly ten seconds; with a page polling as well,
// the oldest sample is never old enough and no rate is ever produced.
//
// So a management page watching the throughput was, by watching it, the reason
// there was none.
//
// What is returned is therefore up to two seconds stale, which is the interval
// the server refreshes on and far inside what anybody can perceive on a figure
// that moves this slowly.
func (s *Server) Stats() *livekit.NodeStats {
	return s.node.Clone().GetStats()
}

// Throughput is what is going in and out, per second.
//
// Not `BytesInPerSec`, which is what it looks like it should be: that field is
// marked deprecated in the protocol and is assigned nowhere in the media
// server, so it reads zero however much is flowing. The rates live in a list
// with one entry per configured measurement window.
//
// The shortest window is taken, because this is drawn on a page somebody is
// watching and the newest answer is the one they mean. Its length is returned
// alongside: ten seconds of mean is not an instantaneous reading, and a figure
// that does not say which it is will be read as the wrong one.
func (s *Server) Throughput() (in, out float64, window time.Duration) {
	s.rate.mu.Lock()
	defer s.rate.mu.Unlock()

	return s.rate.in, s.rate.out, s.rate.window
}

// watchThroughput samples the counters and works out the rate between samples.
//
// Runs for the life of the process. There is no stopping it, and nothing to
// stop: it reads two integers every five seconds and writes two floats, and a
// process on its way down has no use for a shutdown path that could itself go
// wrong.
func (s *Server) watchThroughput() {
	ticker := time.NewTicker(throughputEvery)
	defer ticker.Stop()

	for range ticker.C {
		stats := s.Stats()

		in := stats.GetBytesIn()
		out := stats.GetBytesOut()
		now := time.Now()

		s.rate.mu.Lock()

		// The first sample establishes the baseline and reports nothing, because
		// a rate needs two. Counters that went backwards mean the media server
		// restarted underneath us, which is the same case.
		if !s.rate.lastAt.IsZero() && in >= s.rate.lastIn && out >= s.rate.lastOut {
			seconds := now.Sub(s.rate.lastAt).Seconds()
			if seconds > 0 {
				s.rate.in = float64(in-s.rate.lastIn) / seconds
				s.rate.out = float64(out-s.rate.lastOut) / seconds
				s.rate.window = now.Sub(s.rate.lastAt)
			}
		}

		s.rate.lastIn, s.rate.lastOut, s.rate.lastAt = in, out, now
		s.rate.mu.Unlock()
	}
}

// Node identifies this server, for a page that has to say which one it is
// looking at.
func (s *Server) Node() (id string, ip string) {
	return string(s.node.NodeID()), s.node.NodeIP()
}

// await blocks until the server is running, it fails, or patience runs out.
func await(inner *service.LivekitServer, failed <-chan error) error {
	deadline := time.After(15 * time.Second)

	for {
		select {
		case err := <-failed:
			if err != nil {
				return fmt.Errorf("start the media server: %w", err)
			}
			return fmt.Errorf("the media server stopped before it finished starting")
		case <-deadline:
			return fmt.Errorf("the media server did not start within fifteen seconds")
		default:
			if inner.IsRunning() {
				return nil
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// Handler forwards a request to the media server.
//
// The standard reverse proxy carries a WebSocket upgrade through unchanged,
// which is the only thing signalling needs from it.
func (s *Server) Handler() http.Handler {
	return s.proxy
}

// Stop shuts the media server down, waiting for sessions to drain unless force
// says otherwise.
func (s *Server) Stop(force bool) {
	s.inner.Stop(force)
}
