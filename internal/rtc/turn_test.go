package rtc

import (
	"net"
	"testing"
	"time"

	livekitconf "github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/service"
	"github.com/livekit/protocol/auth"
	"github.com/pion/stun/v3"
	"github.com/pion/turn/v5"
)

/*
Whether a relay will actually accept what this mints.

The claim being tested is about somebody else's software, so it is tested
against somebody else's software: the credentials go to the media server's own
TURN auth handler, the one every relay in this fleet is running, and it either
takes them or it does not. Anything less than that is a test of this file's
opinion about a format, which is exactly the opinion that would be wrong.

The reason this can work at all — and the reason there is no coturn here — is
that the handler recomputes the password from the API secret and the name in the
username, and looks nothing up. Every node verifies tokens with the same secret,
so a credential minted on the control node opens an allocation on any relay. If a
future version of the media server starts checking that the participant exists,
this test is where that shows up, and it will fail on the day the dependency is
bumped rather than in a call three weeks later.
*/

func TestARelayAcceptsCredentialsMintedHere(t *testing.T) {
	const key, secret = "APIabcdefghij", "an-api-secret-of-a-realistic-length"

	forward, err := Forward("shct.example:39219", key, secret)
	if err != nil {
		t.Fatal(err)
	}

	handler := service.NewTURNAuthHandler(auth.NewSimpleKeyProvider(key, secret))

	_, want, ok := handler.HandleAuth(&turn.RequestAttributes{
		Username: forward.Username,
		Realm:    service.LivekitRealm,
		Method:   stun.MethodAllocate,
	})
	if !ok {
		t.Fatal("a relay refused a credential minted here; media would not be forwarded at all")
	}

	// What the relay derives has to equal what a browser will derive from the
	// password it was handed. The handler returns the key rather than the
	// password, so the comparison is made in the same terms.
	got := turn.GenerateAuthKey(forward.Username, service.LivekitRealm, forward.Credential)

	if string(got) != string(want) {
		t.Error("the relay computed a different key from the password sent to the browser; " +
			"every allocation would be refused")
	}
}

func TestARelayRefusesACredentialFromAnotherDeployment(t *testing.T) {
	forward, err := Forward("shct.example:39219", "APIabcdefghij", "the-secret-of-some-other-fleet")
	if err != nil {
		t.Fatal(err)
	}

	handler := service.NewTURNAuthHandler(
		auth.NewSimpleKeyProvider("APIabcdefghij", "an-api-secret-of-a-realistic-length"),
	)

	_, want, ok := handler.HandleAuth(&turn.RequestAttributes{
		Username: forward.Username,
		Realm:    service.LivekitRealm,
		Method:   stun.MethodAllocate,
	})

	// The username carries no secret, so it parses; what must not match is the
	// key. A relay that accepted this would forward traffic for anybody who had
	// read the format off this file.
	got := turn.GenerateAuthKey(forward.Username, service.LivekitRealm, forward.Credential)

	if ok && string(got) == string(want) {
		t.Error("a relay accepted a credential signed with a secret it does not have")
	}
}

func TestForwardingRefusesToMintFromNothing(t *testing.T) {
	for _, missing := range []struct {
		what                 string
		address, key, secret string
	}{
		{"an address", "", "APIabc", "secret"},
		{"a key", "shct.example:39219", "", "secret"},
		{"a secret", "shct.example:39219", "APIabc", ""},
	} {
		if _, err := Forward(missing.address, missing.key, missing.secret); err == nil {
			t.Errorf("minted a credential with no %s; the browser would be sent a "+
				"TURN server it can never authenticate to, and would gather no "+
				"candidates at all", missing.what)
		}
	}
}

// Only the listed relays, and everything else denied, read the way the media
// server reads its two lists: a private peer is refused unless the private
// allow list has it, and any peer in a denied range is refused.
func TestATurnServerForwardsOnlyToTheFleet(t *testing.T) {
	conf := &livekitconf.Config{}
	conf.TURN.Enabled = true

	if err := RestrictTurnPeers(conf, []string{"198.51.100.7", "203.0.113.0/28", "10.8.0.2", "2001:db8::5"}); err != nil {
		t.Fatal(err)
	}

	permitted := func(peer string) bool {
		ip := net.ParseIP(peer)

		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			allowed := false
			for _, cidr := range conf.TURN.AllowRestrictedPeerCIDRs {
				if _, n, err := net.ParseCIDR(cidr); err == nil && n.Contains(ip) {
					allowed = true
				}
			}
			if !allowed {
				return false
			}
		}

		for _, cidr := range conf.TURN.DenyPeerCIDRs {
			if _, n, err := net.ParseCIDR(cidr); err == nil && n.Contains(ip) {
				return false
			}
		}

		return true
	}

	for peer, want := range map[string]bool{
		"198.51.100.7": true, "203.0.113.0": true, "203.0.113.15": true, "10.8.0.2": true, "2001:db8::5": true,
		"198.51.100.6": false, "198.51.100.8": false, "203.0.113.16": false, "8.8.8.8": false,
		"1.1.1.1": false, "10.8.0.3": false, "127.0.0.1": false, "2001:db8::6": false, "2606:4700::1111": false,
		"255.255.255.255": false, "0.0.0.1": false,
	} {
		if got := permitted(peer); got != want {
			t.Errorf("peer %s permitted %v, want %v", peer, got, want)
		}
	}

	if len(conf.TURN.DenyPeerCIDRs) > 400 {
		t.Errorf("%d ranges denied for four peers; the media server parses each on every permission", len(conf.TURN.DenyPeerCIDRs))
	}
}

func TestAPeerThatCannotBeReadStopsTheRelay(t *testing.T) {
	if err := RestrictTurnPeers(&livekitconf.Config{}, []string{"198.51.100.7", "relay-two"}); err == nil {
		t.Error("a peer list with a name in it was accepted, so the relay it meant would be denied")
	}
}

// Twelve hours: the browser opens every allocation of the call with the
// credential it was given at the join, so one that expired mid-meeting was a
// forwarded call that did not come back after a network change. The open-proxy
// risk a short life was meant to bound is closed by meet.turn_peers instead.
func TestAForwardingCredentialOutlivesALongMeeting(t *testing.T) {
	forward, err := Forward("relay.example:39219", "APIabcdefghij", "an-api-secret-of-a-realistic-length")
	if err != nil {
		t.Fatal(err)
	}

	handler := service.NewTURNAuthHandler(auth.NewSimpleKeyProvider("APIabcdefghij", "an-api-secret-of-a-realistic-length"))

	_, _, expiry, err := handler.ParseUsername(forward.Username)
	if err != nil {
		t.Fatal(err)
	}

	if left := time.Until(time.Unix(expiry, 0)); left > 12*time.Hour+time.Minute || left < 12*time.Hour-time.Minute {
		t.Errorf("a forwarding credential opens allocations for %s, want twelve hours", left.Round(time.Minute))
	}
}
