package rtc

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net/netip"
	"strings"
	"time"

	"github.com/jxskiss/base62"
	livekitconf "github.com/livekit/livekit-server/pkg/config"
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
// join response stays useful.
//
// Twelve hours, and kept there on purpose after being cut to half an hour for
// a while. The browser is handed this credential once, at the join, and uses it
// for every allocation for the rest of the call — so when its network changes
// an hour in, the new allocation is opened with this credential, and one that
// had expired was a forwarded call that dropped and did not come back until
// the person joined again. That is a long meeting lost to a phone moving from
// Wi-Fi to mobile data.
//
// What a short life was meant to stop — a credential copied out of a browser's
// network log being a UDP proxy to anywhere — is stopped by meet.turn_peers on
// the relay instead: with it, a credential reaches the fleet's own machines and
// nothing else, however long it lives.
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

// RestrictTurnPeers narrows what this relay's TURN server forwards to.
//
// The media server has a deny list and an allow list for private ranges, and
// nothing that says "only these". So "only these" is written as its complement:
// every IPv4 and IPv6 range that does not contain a listed peer goes on the deny
// list, which the media server consults for every public peer, and a listed
// peer in a private range goes on the private allow list, which it consults
// first. Twenty single addresses come to about six hundred ranges, checked once
// per permission a client asks for rather than per packet.
//
// Refused at startup when a peer cannot be read, because a typo here would
// otherwise deny the one relay it meant to allow.
func RestrictTurnPeers(conf *livekitconf.Config, peers []string) error {
	if len(peers) == 0 {
		if conf.TURN.Enabled {
			slog.Warn("this relay runs a TURN server that forwards to any public address: list the " +
				"other relays under meet.turn_peers, or a forwarding credential is a UDP proxy to anywhere")
		}

		return nil
	}

	var allowed []netip.Prefix

	for _, peer := range peers {
		prefix, err := peerPrefix(peer)
		if err != nil {
			return fmt.Errorf("meet.turn_peers: %q is not an address or a CIDR: %w", peer, err)
		}

		allowed = append(allowed, prefix)

		if addr := prefix.Addr(); addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
			conf.TURN.AllowRestrictedPeerCIDRs = append(conf.TURN.AllowRestrictedPeerCIDRs, prefix.String())
		}
	}

	denied := append(complement(netip.MustParsePrefix("0.0.0.0/0"), allowed),
		complement(netip.MustParsePrefix("::/0"), allowed)...)

	for _, prefix := range denied {
		conf.TURN.DenyPeerCIDRs = append(conf.TURN.DenyPeerCIDRs, prefix.String())
	}

	slog.Info("this relay's TURN server forwards only to the relays listed",
		"peers", len(allowed), "ranges denied", len(denied))

	return nil
}

func peerPrefix(peer string) (netip.Prefix, error) {
	peer = strings.TrimSpace(peer)

	if strings.Contains(peer, "/") {
		prefix, err := netip.ParsePrefix(peer)
		return prefix.Masked(), err
	}

	addr, err := netip.ParseAddr(peer)
	if err != nil {
		return netip.Prefix{}, err
	}

	addr = addr.Unmap()

	return netip.PrefixFrom(addr, addr.BitLen()), nil
}

// complement is every part of within that holds none of allowed, as the fewest
// prefixes that halving finds.
func complement(within netip.Prefix, allowed []netip.Prefix) []netip.Prefix {
	overlapping := false

	for _, prefix := range allowed {
		if prefix.Addr().Is4() != within.Addr().Is4() {
			continue
		}

		// Contained whole: nothing in here is denied.
		if prefix.Bits() <= within.Bits() && prefix.Contains(within.Addr()) {
			return nil
		}

		if within.Contains(prefix.Addr()) {
			overlapping = true
		}
	}

	if !overlapping {
		return []netip.Prefix{within}
	}

	low, high := halves(within)

	return append(complement(low, allowed), complement(high, allowed)...)
}

// halves splits a prefix into its two children.
func halves(prefix netip.Prefix) (netip.Prefix, netip.Prefix) {
	bits := prefix.Bits() + 1
	low := netip.PrefixFrom(prefix.Addr(), bits)

	raw := prefix.Addr().AsSlice()
	raw[prefix.Bits()/8] |= 0x80 >> (prefix.Bits() % 8)

	high, _ := netip.AddrFromSlice(raw)

	return low, netip.PrefixFrom(high, bits)
}
