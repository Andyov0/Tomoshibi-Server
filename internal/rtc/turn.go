package rtc

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/jxskiss/base62"
)

/*
Credentials for a relay's TURN server, minted here rather than by the relay.

The problem this solves is the one where somebody picks a server and it makes no
difference. A meeting lives on exactly one node — the media server binds a room
to whichever node opened it, and everybody who joins afterwards is forwarded
there. So the second person's choice of server decided nothing: their signalling
was forwarded, their media went straight past the machine they picked, and the
machine they picked carried nothing at all. On a fleet bought for the domestic
routes into it, that is the whole point of the fleet not working.

Media can be made to follow the choice, and the mechanism is TURN: the client is
given the relay it picked as its only candidate route, allocates there, and the
relay forwards the packets on to the node holding the room. One extra hop, paid
deliberately, in exchange for the call entering the country where the person is.

What makes this cheap is the media server's own credential scheme. A TURN
username is base62 of `key|participant|expiry` and the password is base62 of
SHA-256 over `secret|participant|expiry` — no database, no lookup, and nothing
about the participant is checked. Every node in this deployment verifies tokens
with the same key and secret, so credentials minted here are accepted by the TURN
server on any relay. That is what removes the second piece of software: there is
no coturn to install, configure, keep up to date, or leave running with a
password somebody has to rotate.

Read from the media server's source rather than its documentation, which
describes neither the scheme nor the fact that the expiry gates only the first
allocation. That last detail matters: a refresh an hour into a call is
authenticated but not re-checked against the clock, so a long meeting does not
drop when the credential behind it ages out.
*/

// How long a minted credential may be used to open a new allocation.
//
// Only the first allocation is checked against this; a call already up keeps
// refreshing past it. So this is not the length of a meeting, it is how long a
// join response stays useful — long enough for somebody to open the link they
// were sent and go and make coffee, short enough that a response copied out of a
// browser's network log is not a standing invitation to relay traffic.
const turnFor = 12 * time.Hour

// Forwarding is what a client needs in order to reach a room through a relay
// that is not holding it.
type Forwarding struct {
	// URL is the TURN server, as a browser wants it written.
	URL string `json:"url"`
	// Username and Credential are what the relay's own auth handler recomputes.
	Username   string `json:"username"`
	Credential string `json:"credential"`
}

// Forward mints credentials for the TURN server listening at address.
//
// The address is a relay's, and is written into the URL untouched: it may be a
// hostname or a bare IP, and on the machines that lost a hostname to a
// blacklist it is deliberately the latter.
func Forward(address, key, secret string) (Forwarding, error) {
	if address == "" || key == "" || secret == "" {
		return Forwarding{}, fmt.Errorf("forward through %q: nothing to mint from", address)
	}

	// Any value the relay has not seen before. It is not looked up anywhere —
	// the auth handler parses it, recomputes a password from it, and compares —
	// so what it must be is unguessable and distinct, and what it must not be is
	// anything about the person: this string is written into the relay's logs on
	// every allocation.
	who, err := opaque()
	if err != nil {
		return Forwarding{}, err
	}

	expiry := time.Now().Add(turnFor).Unix()

	username := base62.EncodeToString(fmt.Appendf(nil, "%s|%s|%d", key, who, expiry))
	sum := sha256.Sum256(fmt.Appendf(nil, "%s|%s|%d", secret, who, expiry))

	return Forwarding{
		// Over UDP and said so. Left unqualified a browser will also try the
		// same address over TCP, which is a connection that will not answer and
		// several seconds of gathering spent finding that out.
		URL:        "turn:" + address + "?transport=udp",
		Username:   username,
		Credential: base62.EncodeToString(sum[:]),
	}, nil
}

func opaque() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("draw a participant name: %w", err)
	}

	// No pipe in the alphabet, which matters: the relay splits the decoded
	// username on that character and expects exactly three parts.
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
