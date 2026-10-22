package rtc

import (
	"testing"

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
