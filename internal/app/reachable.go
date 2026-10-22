package app

import (
	"context"
	"log/slog"
	"net"
	"sync"
	"time"

	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

/*
Keeping a relay nobody can reach out of the choosing.

The browser measures every relay it is offered and names the fastest, and that
measurement cannot tell a relay that is there and refusing from one that is not
there at all. Both arrive as an error event with nothing readable on it —
deliberately, because a page that could tell the difference could map a network
it was never given. So the two are indistinguishable from the one place that
would most like to know.

Which would be a curiosity, except that it inverts. A relay refusing an
untokened upgrade has to complete a TLS handshake and answer an HTTP request
before it can refuse; a relay whose connection is reset answers in one round
trip and answers sooner. The broken one wins the measurement, wins the room, and
the call fails — and it wins by more the more thoroughly it is broken.

The control node has the answer the browser cannot get: it opens a TCP
connection to each relay and sees whether it completes. So the two are split.
This decides which relays are worth offering, and the browser decides which of
those is nearest.

Checked here on a ticker and not per request. Answering a join must not wait on
a network round trip to a machine in another country, and a list read by every
client on every join would otherwise become one connection per relay per join —
which is how the last measurement got a relay blocked.
*/

// How often each relay is looked at.
//
// Slower than it could be. What this catches is a machine that has gone away,
// and a machine that goes away stays away for longer than this; what it costs
// is a connection per relay, which is the thing to be sparing with. Half a
// minute of sending clients to a relay that has just died is a worse experience
// than none, and a great deal better than the reverse mistake.
const reachEvery = 30 * time.Second

// How long a check may take before the relay counts as unreachable.
//
// Generously long compared to any real answer — a TCP handshake across the
// Pacific is under half a second — because the cost of being wrong is
// asymmetric. Calling a slow relay dead removes it from the rotation; waiting
// four seconds to find out costs a background goroutine four seconds.
const reachWithin = 4 * time.Second

// Check is what the control node uses to see whether a relay is there.
//
// The signature [rtc.Cluster.Check] already has. An interface of one function
// rather than the concrete type, so that the choosing can be tested against a
// relay that is up or down by saying so, rather than by binding a port.
type Check func(ctx context.Context, url string) (bool, time.Duration, string)

// reach remembers which relays answered the last time they were asked.
type reach struct {
	check Check

	mu   sync.RWMutex
	down map[string]bool
	// Which relays answer signalling but not media. Kept apart from [down]
	// because it is reported and not acted on: a relay in this map is still
	// offered, still chosen, and still the only machine in its country.
	silent map[string]bool
	// How many sweeps in a row found nothing at all, which is a count of this
	// machine's own outages rather than of anybody else's.
	blind int

	// missed counts consecutive failed checks per relay, and is what stops one
	// of them withdrawing a relay. See withdrawAfter.
	missed map[string]int

	// took is how long each relay took to answer when it last did, which is
	// a distance from here. See quickest.
	took map[string]time.Duration
}

// How many checks in a row a relay has to fail before it stops being offered.
//
// One was enough for a while and cost this deployment its American relay for
// half a minute at a time, thirty-nine times in a day — all of them during the
// evening, and all but two of them a single failed check with the next one
// answering normally. The path from this node to Los Angeles is congested at
// those hours; the path a caller in California takes to the same machine is not
// the same path and is nobody's business here. Withdrawing on one reading meant
// a suspicion about our own line deciding what everybody else was offered.
//
// Measured before it was changed: ten outages, eight of them twenty-six to
// twenty-nine seconds — which at a check every thirty seconds is exactly one
// failure — and two of about a minute. So two in a row removes four fifths of
// the wrong answers, and the price is thirty seconds more exposure to a relay
// that has genuinely died, against a timeout that is already thirteen times a
// normal handshake.
//
// Restored on the first success, not on two: the asymmetry runs the other way
// coming back. A relay that is answering should be offered again at once.
const withdrawAfter = 2

func newReach(check Check) *reach {
	return &reach{
		check: check, down: map[string]bool{},
		silent: map[string]bool{}, missed: map[string]int{},
		took: map[string]time.Duration{},
	}
}

// up reports whether a relay is worth offering.
//
// Unknown counts as up, which is the important half. A relay added a moment ago
// has not been looked at yet, and a deployment that hid every new relay until a
// ticker came round would look broken to whoever just added one.
func (r *reach) up(url string) bool {
	if r == nil {
		return true
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	return !r.down[url]
}

// quickest returns the relay that answered this node fastest, out of the ones
// given, or the first where none has been timed.
//
// Used to choose a relay to carry signalling for one that cannot (relays
// signalling), where what matters is being near the one named, which is out
// of reach. The control node is in Hong Kong with the machine it stands in for,
// so nearest to here is nearest to that: by list order a fallback for Hong
// Kong was Singapore, ahead of the other Hong Kong relay. A relay not yet timed
// sorts last rather than first, being the one nothing is known about.
func (r *reach) quickest(list []store.Relay) (store.Relay, bool) {
	if len(list) == 0 {
		return store.Relay{}, false
	}
	if r == nil {
		return list[0], true
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	best, bestTook := list[0], time.Duration(-1)
	for _, relay := range list {
		took, timed := r.took[relay.URL]
		if !timed {
			continue
		}
		if bestTook < 0 || took < bestTook {
			best, bestTook = relay, took
		}
	}

	return best, true
}

// only returns the relays that answered, which may be none of them.
func (r *reach) only(list []store.Relay) []store.Relay {
	if r == nil {
		return list
	}

	live := make([]store.Relay, 0, len(list))
	for _, relay := range list {
		if r.up(relay.URL) {
			live = append(live, relay)
		}
	}

	return live
}

// keep returns the relays worth offering, out of the ones given.
//
// Everything, when nothing answered. A deployment whose relays have all gone
// quiet is more likely to be one whose control node lost its own network than
// one where every machine died at once, and refusing to name any relay turns a
// suspicion into an outage. The client will find out soon enough, from the only
// vantage point that counts.
func (r *reach) keep(list []store.Relay) []store.Relay {
	live := r.only(list)
	if len(live) == 0 {
		return list
	}

	return live
}

// look asks each relay once.
func (r *reach) look(ctx context.Context, list []store.Relay) {
	type finding struct {
		relay  store.Relay
		ok     bool
		took   time.Duration
		detail string
	}

	found := make([]finding, 0, len(list))
	answered := 0

	for _, relay := range list {
		asking, cancel := context.WithTimeout(ctx, reachWithin)
		ok, took, detail := r.check(asking, relay.URL)
		cancel()

		if ok {
			answered++
		}

		found = append(found, finding{relay, ok, took, detail})
	}

	// A sweep in which nothing answered measured this machine, not the fleet.
	//
	// These relays are in five places on three continents and share no path but
	// the last one, which is this node's own. When every one of them goes quiet
	// inside the same half minute, the reading to take is that the line here is
	// out — and the worst thing to do with that reading is to act on it, because
	// acting on it empties the list every client is offered and turns twenty
	// seconds of nothing into a deployment with nowhere to hold a call.
	//
	// The asymmetry is what decides this. Wrongly keeping a dead fleet listed
	// costs a client one failed connection and a retry, which is what it would
	// have paid anyway. Wrongly dropping a live one costs everybody the ability
	// to start a call at all, and does it at exactly the moment the operator is
	// least able to see why.
	//
	// Most of them rather than all of them, which is what the readings say the
	// shape actually is.
	//
	// This was written as "nothing answered", on the assumption that a link
	// going down makes every check fail. It does not, because the sweep is
	// sequential: eleven relays at a three-second timeout is up to thirty-three
	// seconds of walking, and these outages last twenty to forty. So the sweep
	// starts before the outage or ends after it, and some relays are checked
	// while the line is up. Fourteen hours of readings have ten sweeps where
	// eight of eleven failed together and none at all where every one did — so
	// the rule as written was never going to fire.
	//
	// Half is the line. More than half of a fleet in Hong Kong, Singapore,
	// Tokyo, Los Angeles and four places in mainland China does not stop
	// answering at the same moment for any reason that is about them.
	//
	// Three or more, because with two a single machine going away is half of
	// them and is the ordinary case rather than a sign.
	if len(found) >= 3 && answered*2 < len(found) {
		r.mu.Lock()
		r.blind++
		blind := r.blind
		r.mu.Unlock()

		if blind == 1 {
			slog.Warn("most of the fleet did not answer this sweep, so the readings are being "+
				"kept as they were: these relays share no path but this machine's own, and "+
				"most of them failing at once is a statement about this end",
				"relays", len(found), "answered", answered)
		}

		return
	}

	r.mu.Lock()
	blind := r.blind
	r.blind = 0
	r.mu.Unlock()

	if blind > 0 {
		slog.Info("relays are answering again after this machine could reach none of them",
			"sweeps", blind, "for", (time.Duration(blind) * reachEvery).String())
	}

	for _, one := range found {
		r.mu.Lock()
		was := r.down[one.relay.URL]

		if one.ok {
			r.missed[one.relay.URL] = 0
			r.down[one.relay.URL] = false
			r.took[one.relay.URL] = one.took
		} else {
			r.missed[one.relay.URL]++
			r.down[one.relay.URL] = r.missed[one.relay.URL] >= withdrawAfter
		}

		now := r.down[one.relay.URL]
		r.mu.Unlock()

		// And whether media can reach it, which is a different question from
		// whether it is switched on and is the one these break on.
		//
		// Signalling is TCP and media is UDP on another port, and the two are
		// let through by different rules: a host firewall, a provider's security
		// group, an nftables mapping that did not survive a reboot. When the UDP
		// port stops being reachable and the TCP one does not, the check above
		// answers in eleven milliseconds, the relay shows green, and every call
		// sent to it fails to get any media at all.
		//
		// Said, not acted on. A relay whose media port has gone is still the
		// relay somebody chose by hand and still the only one in its country,
		// and dropping it from the list on a reading this node takes from one
		// vantage point would turn a reported fault into a fleet with nowhere to
		// hold a call. The same asymmetry as above, for the same reason.
		//
		// And only where signalling answered, which is what the warning says.
		// A relay this node cannot reach at all is already reported by the line
		// above it, and reporting the media port as well would be two warnings
		// about one machine saying the same thing twice.
		r.carrying(ctx, one.relay, one.ok)

		// Said once on the change rather than every half minute, so that a relay
		// which has been down all night is one line in the log and not two
		// thousand.
		switch {
		case now && !was:
			slog.Warn("a relay stopped answering and is no longer offered to clients",
				"relay", one.relay.Name, "url", one.relay.URL, "detail", one.detail)
		case !now && was:
			slog.Info("a relay is answering again",
				"relay", one.relay.Name, "url", one.relay.URL, "took", one.took)
		}
	}
}

// carrying says when a relay's media port stops answering, and when it comes
// back.
//
// Only where the deployment gave the relay a probe port. Most have not, and a
// check that reported those as unreachable would fill the log with a setting
// nobody had filled in.
func (r *reach) carrying(ctx context.Context, relay store.Relay, signalling bool) {
	// Nothing to say about the media path of a machine this node could not
	// reach at all: the sweep above already said so, and the interesting case is
	// precisely the one where the two disagree.
	if !signalling {
		return
	}

	// Nor about one this node only reaches through something local.
	//
	// A relay this network cannot route to at all is reached here through a
	// forwarder on loopback, put in front of it by hand and named in this
	// machine's hosts file — so the address below resolves to 127.0.0.0/8 and
	// the probe is sent to this machine. The forwarder carries the signalling
	// port and nothing else, because it is a TCP proxy and the probe is UDP, so
	// what the check measures is whether a second forwarder exists. It does not,
	// and never will, and the reading was therefore always the same one.
	//
	// Thirteen warnings in a day and not one recovery, for a relay that answers
	// this probe in three hundred milliseconds when it is asked from anywhere
	// else. A permanent alert about a machine that is working is how somebody
	// learns to ignore the alerts that matter.
	if forwardedLocally(relay.Probe) {
		return
	}

	asked, ok, took := rtc.Carrying(ctx, relay.Probe)
	if !asked {
		return
	}

	r.mu.Lock()
	was := r.silent[relay.URL]
	r.silent[relay.URL] = !ok
	r.mu.Unlock()

	switch {
	case !ok && !was:
		// Said as a disagreement rather than as a verdict, because it is one
		// vantage point.
		//
		// This node's own path to a relay is not every client's. One relay here
		// answers signalling from everywhere and answers UDP from this node not
		// at all — the same one-directional path the cross-border routing exists
		// to work around — and it carries calls perfectly for the people who use
		// it. Reading the first version of this as "the relay is broken" would
		// have sent somebody to look at a machine that is fine.
		slog.Warn("this node reaches a relay's signalling port but not its media port: either "+
			"what is allowed through to that port changed, or the path from here does not "+
			"carry UDP. Ask from somewhere else before touching the machine",
			"relay", relay.Name, "probe", relay.Probe)
	case ok && was:
		slog.Info("a relay's media port is answering again", "relay", relay.Name, "took", took)
	}
}

// watching keeps the reading current until the deployment stops.
func (a *App) watching() {
	ticker := time.NewTicker(reachEvery)
	defer ticker.Stop()

	for {
		a.lookAround(context.Background())

		select {
		case <-a.stop:
			return
		case <-ticker.C:
		}
	}
}

// lookAround asks every relay worth a reading once: see relays.watched for which.
func (a *App) lookAround(ctx context.Context) {
	a.reach.look(ctx, a.relays.watched())
}

// forwardedLocally reports whether an address this node was given points back at
// this node.
//
// Which means somebody put a forwarder in front of a machine this network
// cannot reach directly, and that anything measured against the address
// describes the forwarder rather than the machine.
//
// Resolution failure is not local: a name that does not resolve is a fault
// worth reporting through the ordinary path, and swallowing it here would hide
// it.
func forwardedLocally(probe string) bool {
	if probe == "" {
		return false
	}

	host, _, err := net.SplitHostPort(probe)
	if err != nil {
		host = probe
	}

	if address := net.ParseIP(host); address != nil {
		return address.IsLoopback()
	}

	found, err := net.LookupIP(host)
	if err != nil || len(found) == 0 {
		return false
	}

	// All of them, not any. A name answering with one loopback address and one
	// real one is a hosts file half removed, and the real address is still worth
	// asking.
	for _, address := range found {
		if !address.IsLoopback() {
			return false
		}
	}

	return true
}
