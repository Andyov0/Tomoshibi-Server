// Cluster is how a control node reaches the media servers it does not run.
//
// A control node starts no media server, so the management pages had nothing to
// ask and answered every question about rooms and participants with a refusal —
// correct, and useless, since those pages exist to answer exactly those
// questions.
//
// What makes this work without a second protocol is the arrangement the split
// already relies on: every relay verifies tokens signed with the deployment's
// one key pair, and a relay's own management API is reachable at the address
// clients already dial. So a control node holding that pair can mint a token
// and ask a relay directly, which is what [Control] does on a full deployment
// over loopback. The only difference here is the distance.
//
// LiveKit routes through redis when relays share one, so a room being held on
// another relay is still listed by the one asked. That is why a single relay
// answers for the cluster and why this does not have to ask each in turn.
package rtc

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
)

// Cluster asks whichever relay is answering.
//
// Not a fixed one. A control node that always asked the first relay in the list
// would show an empty dashboard whenever that particular machine was down, and
// the operator would read it as "no calls" rather than "cannot see".
type Cluster struct {
	// relays returns the addresses to try, newest first read from the store, so
	// that a relay added on a page is asked without a restart.
	relays func() []string

	key    string
	secret string
	client *http.Client

	// dial is the same dialler the client above uses, kept so that the
	// reachability check can use it too.
	//
	// It has to. The check opens a socket and nothing more, so it looked like
	// somewhere a plain dialler would do — and a plain dialler sends a packet
	// to this machine's own public address, which on any NAT never comes back.
	// A control node running a relay beside it then reports that relay as
	// unreachable, stops offering it to clients, and is wrong about the one
	// machine it is sitting on.
	dial *loopback

	// last is the relay that answered most recently. Tried first next time,
	// because the alternative is paying a failed connection to a machine known
	// to be down before every question.
	mu   sync.Mutex
	last string
}

// NewCluster builds one.
func NewCluster(relays func() []string, key, secret string, ownAddresses ...string) *Cluster {
	dial := newLoopback(ownAddresses...)

	return &Cluster{
		relays: relays,
		key:    key,
		secret: secret,
		dial:   dial,
		// Four seconds, not eight. A relay that has not answered in four is one
		// the page should say nothing about rather than one worth waiting
		// longer for: these are drawn several at a time behind a person who is
		// looking at the screen, and the slowest decides how long they wait.
		//
		// The dialler turns a connection to this machine's own address around
		// at the socket. A control node running a relay beside it reaches that
		// relay by its published name, which resolves to the public address —
		// and a packet sent to your own public address usually never comes
		// back, so every call waited out its full timeout. That deployment
		// spent twelve seconds a request and answered 502 on the slowest page.
		client: &http.Client{
			Timeout: 4 * time.Second,
			Transport: &http.Transport{
				DialContext:         dial.DialContext,
				TLSHandshakeTimeout: 3 * time.Second,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

// controlFor builds a [Control] pointed at one relay's management API.
//
// The address a client dials is a WebSocket origin; the management API is the
// same host over plain HTTP, which is what the scheme swap below is. Relays
// serve both from the one listener, so there is no second port to configure and
// no way for the two to drift apart.
func (c *Cluster) controlFor(relay string) *Control {
	upstream := strings.Replace(strings.Replace(relay, "wss://", "https://", 1), "ws://", "http://", 1)

	return &Control{
		client:   c.client,
		upstream: strings.TrimRight(upstream, "/"),
		key:      c.key,
		secret:   c.secret,
	}
}

// ordered returns the relays to try, the last one that answered first.
func (c *Cluster) ordered() []string {
	list := c.relays()

	c.mu.Lock()
	preferred := c.last
	c.mu.Unlock()

	if preferred == "" {
		return list
	}

	ordered := make([]string, 0, len(list))
	for _, relay := range list {
		if relay == preferred {
			ordered = append([]string{relay}, ordered...)
			continue
		}
		ordered = append(ordered, relay)
	}

	return ordered
}

// answered records which relay worked, so it is asked first next time.
func (c *Cluster) answered(relay string) {
	c.mu.Lock()
	c.last = relay
	c.mu.Unlock()
}

// ask runs one question against the relays until one answers.
//
// An error from a relay is not necessarily that relay's fault — a room that
// does not exist is an error too — so only a failure to reach one moves on to
// the next. Distinguishing them by anything finer than "did the request
// complete" would mean parsing the media server's errors, which is a coupling
// worth more than it saves.
func (c *Cluster) ask(ctx context.Context, run func(*Control) error) error {
	list := c.ordered()

	if len(list) == 0 {
		return fmt.Errorf("no relay is configured, so there is nowhere to ask about rooms")
	}

	var reached error

	for _, relay := range list {
		err := run(c.controlFor(relay))
		if err == nil {
			c.answered(relay)
			return nil
		}

		// Reached it and it said no: that is an answer, and asking a different
		// relay the same question would only produce the same one.
		if !unreachable(err) {
			c.answered(relay)
			return err
		}

		reached = err
	}

	return fmt.Errorf("no relay answered: %w", reached)
}

// unreachable says whether an error is a failure to reach a relay rather than
// an answer from one.
//
// The distinction decides whether the next relay is tried. An answer is final —
// asking somebody else the same question produces the same answer — so anything
// classified as an answer stops the walk, and a failure to reach is skipped past.
//
// Which makes a wrong classification expensive in one direction only. A refusal
// read as unreachable costs one extra request; a transport failure read as a
// refusal stops the walk at the first broken machine and returns its error as
// the fleet's answer.
//
// The certificate cases were missing, and they are the ones this deployment
// produces. A relay whose certificate has expired -- which is a thing that
// happens here, because two of them renew from a cron job on the machine itself
// -- refuses the TLS handshake, and that was read as the relay having answered.
// So one machine's certificate running out took every room listing, every
// removal and every close on the whole cluster with it, and the error handed to
// the page was about a certificate on a machine the operator had not asked
// about.
func unreachable(err error) bool {
	if err == nil {
		return false
	}

	text := err.Error()

	for _, sign := range []string{
		"connection refused", "no such host", "timeout", "deadline exceeded",
		"connection reset", "EOF", "network is unreachable", "i/o timeout",

		// Nothing at the far end read the request, so it is not an answer. The
		// prefixes rather than the wordings, because the wordings are the
		// standard library's to change: crypto/tls and crypto/x509 put these in
		// front of every error they raise.
		"tls:", "x509:", "certificate",
		"handshake failure", "protocol version",
	} {
		if strings.Contains(text, sign) {
			return true
		}
	}

	return false
}

// Check says whether a relay is answering, and how quickly.
//
// A TCP connection and nothing else. Not one byte is sent: the socket is opened,
// the time is taken, and it is closed.
//
// It used to be an HTTPS request to a health endpoint, which was the mistake
// this whole file now exists to avoid. A relay in mainland China is probed by
// something that opens its TLS port, sends an ordinary request, and reads the
// answer — a port that replies is a website, and an unregistered one is taken
// off the air. A dashboard checking every relay every fifteen seconds over
// HTTPS is that probe, running against our own machines, forever. The endpoint
// it asked for has been removed and nothing here speaks HTTP any more.
//
// What is lost is the difference between a machine that is up and a relay that
// is working. A TCP handshake proves something is listening, not that it will
// accept a call. That is a fair trade: the thing which does prove it — a client
// opening the signalling socket — happens on every join anyway, and a relay
// broken above the socket shows up as calls failing rather than as a green row,
// which is a fault an operator can see either way.
func (c *Cluster) Check(ctx context.Context, url string) (bool, time.Duration, string) {
	address, err := hostPort(url)
	if err != nil {
		return false, 0, err.Error()
	}

	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	started := time.Now()

	conn, err := c.dial.DialContext(ctx, "tcp", address)
	if err != nil {
		return false, time.Since(started), summarise(err)
	}

	took := time.Since(started)
	_ = conn.Close()

	return true, took, ""
}

// hostPort turns a relay's WebSocket address into something to dial.
//
// The port is explicit in every address this deployment hands out, and where it
// is not, the scheme decides it — the same defaults a browser would use.
func hostPort(url string) (string, error) {
	trimmed := strings.TrimRight(url, "/")

	secure := strings.HasPrefix(trimmed, "wss://") || strings.HasPrefix(trimmed, "https://")

	for _, scheme := range []string{"wss://", "ws://", "https://", "http://"} {
		trimmed = strings.TrimPrefix(trimmed, scheme)
	}

	// Anything after the authority is a path, which a socket has no use for.
	if slash := strings.IndexByte(trimmed, '/'); slash >= 0 {
		trimmed = trimmed[:slash]
	}

	if trimmed == "" {
		return "", fmt.Errorf("%q has no host to dial", url)
	}

	if _, _, err := net.SplitHostPort(trimmed); err == nil {
		return trimmed, nil
	}

	if secure {
		return net.JoinHostPort(trimmed, "443"), nil
	}

	return net.JoinHostPort(trimmed, "80"), nil
}

// summarise reduces a transport error to the part worth showing.
func summarise(err error) string {
	text := err.Error()

	switch {
	case strings.Contains(text, "connection refused"):
		return "connection refused"
	case strings.Contains(text, "no such host"):
		return "name does not resolve"
	case strings.Contains(text, "certificate"):
		return "certificate rejected"
	case strings.Contains(text, "deadline exceeded"), strings.Contains(text, "timeout"):
		return "timed out"
	default:
		if len(text) > 120 {
			return text[:120]
		}
		return text
	}
}

// The five questions the management pages ask, each run against whichever relay
// answers. Together these satisfy the Control interface those pages hold, so a
// control node's pages work exactly as a full deployment's do.

func (c *Cluster) Rooms(ctx context.Context) ([]*livekit.Room, error) {
	var rooms []*livekit.Room

	err := c.ask(ctx, func(control *Control) error {
		found, err := control.Rooms(ctx)
		if err != nil {
			return err
		}
		rooms = found
		return nil
	})

	return rooms, err
}

func (c *Cluster) Participants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	var people []*livekit.ParticipantInfo

	err := c.ask(ctx, func(control *Control) error {
		found, err := control.Participants(ctx, room)
		if err != nil {
			return err
		}
		people = found
		return nil
	})

	return people, err
}

func (c *Cluster) Remove(ctx context.Context, room, identity string) error {
	return c.ask(ctx, func(control *Control) error { return control.Remove(ctx, room, identity) })
}

func (c *Cluster) Mute(ctx context.Context, room, identity, track string) error {
	return c.ask(ctx, func(control *Control) error { return control.Mute(ctx, room, identity, track) })
}

// Announce says something to everybody in a room, through whichever relay
// answers. Any node reaches the whole cluster, so the first answer is the
// answer.
func (c *Cluster) Announce(ctx context.Context, room, topic string, data []byte) error {
	return c.ask(ctx, func(control *Control) error {
		return control.Announce(ctx, room, topic, data)
	})
}

// Tell says something to one person in a room.
func (c *Cluster) Tell(ctx context.Context, room, identity, topic string, data []byte) error {
	return c.ask(ctx, func(control *Control) error {
		return control.Tell(ctx, room, identity, topic, data)
	})
}

// Hold creates a room on one node. See Control.Hold.
func (c *Cluster) Hold(ctx context.Context, room, node string) error {
	return c.ask(ctx, func(control *Control) error {
		return control.Hold(ctx, room, node)
	})
}

func (c *Cluster) Close(ctx context.Context, room string) error {
	return c.ask(ctx, func(control *Control) error { return control.Close(ctx, room) })
}

// Relays is the addresses this cluster knows about, read live.
//
// Exported for the management pages, which read every relay's counters rather
// than asking one of them: rooms are cluster-wide and any relay can answer for
// all, but a load average belongs to one machine and has to be asked of it.
func (c *Cluster) Relays() []string {
	return c.relays()
}
