package rtc

import (
	"net"
	"strconv"
	"testing"
	"time"

	livekitconf "github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/service"
	"github.com/livekit/protocol/auth"
	"github.com/pion/turn/v5"
)

// The media server's own TURN server, given the peer list, asked by a real
// client to forward to a relay of the fleet and to somewhere else.
//
// The unit test beside this reads the two lists the way the media server's
// source says it reads them; this asks the media server. A permission is only
// a request — nothing is sent to the peers named here.
func TestTheMediaServersTurnRefusesPeersOutsideTheFleet(t *testing.T) {
	const key, secret = "APIabcdefghij", "an-api-secret-of-a-realistic-length"

	free, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Skipf("no udp here: %v", err)
	}
	port := free.LocalAddr().(*net.UDPAddr).Port
	_ = free.Close()

	conf := &livekitconf.Config{}
	conf.TURN.Enabled = true
	conf.TURN.UDPPort = port
	conf.TURN.BindAddresses = []string{"127.0.0.1"}
	// Inside the range this harness keeps to.
	conf.TURN.RelayPortRangeStart = 19560
	conf.TURN.RelayPortRangeEnd = 19599
	conf.RTC.NodeIP.V4 = "127.0.0.1"

	if err := RestrictTurnPeers(conf, []string{"198.51.100.7"}); err != nil {
		t.Fatal(err)
	}

	server, err := service.NewTurnServer(conf, service.NewTURNAuthHandler(auth.NewSimpleKeyProvider(key, secret)).HandleAuth, false)
	if err != nil {
		t.Skipf("the media server's TURN would not start here: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })

	forward, err := Forward(net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), key, secret)
	if err != nil {
		t.Fatal(err)
	}

	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		TURNServerAddr: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		Username:       forward.Username,
		Password:       forward.Credential,
		Realm:          service.LivekitRealm,
		Conn:           conn,
		RTO:            200 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)

	if err := client.Listen(); err != nil {
		t.Fatal(err)
	}

	relayed, err := client.Allocate()
	if err != nil {
		t.Fatalf("an allocation with a credential minted here was refused: %v", err)
	}
	t.Cleanup(func() { _ = relayed.Close() })

	if _, err := relayed.WriteTo([]byte("x"), &net.UDPAddr{IP: net.ParseIP("198.51.100.7"), Port: 9}); err != nil {
		t.Errorf("forwarding to a relay of the fleet was refused: %v", err)
	}

	if _, err := relayed.WriteTo([]byte("x"), &net.UDPAddr{IP: net.ParseIP("192.0.2.200"), Port: 9}); err == nil {
		t.Error("the media server's TURN forwarded to an address outside the fleet")
	}
}
