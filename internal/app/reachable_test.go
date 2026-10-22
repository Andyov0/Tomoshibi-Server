package app

import (
	"context"
	"fmt"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
What these guard is a relay winning a race by being broken.

The browser measures every relay it is offered and names the fastest, and it
cannot tell a relay that refused from one that was never reachable: both arrive
as an error event carrying nothing, by design. That would be tolerable if the
two took similar amounts of time. They do not. A relay that refuses an untokened
upgrade completes a TLS handshake and answers an HTTP request first; a relay
whose connection is reset answers in one round trip. The broken one is measured
as nearest, is chosen, and the call fails.

So the control node opens a connection of its own and keeps the ones that
answer, and what is asserted here is both halves of that: a relay that does not
answer is not offered, and a deployment where nothing answers still holds calls.
The second is the one that would be quietly wrong — it only shows up on the day
the control node's own network is having trouble, which is the worst possible
day to also stop naming any relay at all.
*/

func fixed(up map[string]bool) Check {
	return func(_ context.Context, url string) (bool, time.Duration, string) {
		if up[url] {
			return true, 5 * time.Millisecond, ""
		}

		return false, 0, "refused"
	}
}

var (
	near = store.Relay{Name: "guangzhou", URL: "wss://gz.example:1", Enabled: true}
	far  = store.Relay{Name: "tokyo", URL: "wss://jp.example:1", Enabled: true}
	held = store.Relay{Name: "hongkong", URL: "wss://hk.example:1", Enabled: true, Fallback: true}
)

func withReach(t *testing.T, list []store.Relay, up map[string]bool) *relays {
	t.Helper()

	conf := &config.Config{}
	conf.Meet.RelayPolicy = config.PickSticky

	chosen := newRelays(conf, &listed{relays: list})
	chosen.reach = newReach(fixed(up))

	// Swept until it has settled rather than once. A relay is withdrawn after
	// withdrawAfter failures in a row, so a single sweep leaves a relay that is
	// down still being offered — which is the behaviour being tested elsewhere
	// and is not what any caller of this helper is asking for. What they want
	// is a fleet in the state the map describes.
	for i := 0; i < withdrawAfter; i++ {
		chosen.reach.look(context.Background(), list)
	}

	return chosen
}

func TestARelayThatDoesNotAnswerIsNotOffered(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, far}, map[string]bool{far.URL: true})

	offered := chosen.offered()
	if len(offered) != 1 || offered[0].Name != "tokyo" {
		t.Fatalf("offered %v; a relay the control node cannot open a connection to must "+
			"not be measured, because the browser cannot tell it from a slow one and it "+
			"answers sooner than a working relay does", names(offered))
	}
}

func TestARelayThatDoesNotAnswerIsNotChosen(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, far}, map[string]bool{far.URL: true})

	// Named by the client, which is the path that trusts a measurement. Even
	// asked for outright, a relay known not to answer is not where a call goes.
	for _, room := range []string{"standup", "retro", "one-to-one", "all-hands"} {
		if got := chosen.pick(room, "", nil, false, false); got.Name != "tokyo" {
			t.Fatalf("room %q went to %q; only one relay answered", room, got.Name)
		}
	}
}

// The one that fails on the worst possible day. A control node that has lost its
// own network sees every relay as gone, and must not conclude there is nowhere
// to hold a call.
func TestNothingAnsweringIsNotAnOutage(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, far}, map[string]bool{})

	if got := len(chosen.offered()); got != 2 {
		t.Errorf("offered %d relays when none answered, wanted all %d: a control node that "+
			"has lost its own network sees exactly this, and naming no relay turns its bad "+
			"minute into everybody's", got, 2)
	}

	if got := chosen.pick("standup", "", nil, false, false); got.Name == "" {
		t.Error("no relay was chosen when none answered; a call has to be held somewhere")
	}
}

// Reachability is asked before the reserve, not after. A working relay held back
// for emergencies is still the answer when the ordinary one has gone.
func TestTheReserveIsUsedWhenTheOrdinaryOneIsUnreachable(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, held}, map[string]bool{held.URL: true})

	if got := chosen.pick("standup", "", nil, false, false); got.Name != "hongkong" {
		t.Fatalf("chose %q; the only relay answering was the reserve, and a reserve exists "+
			"for exactly this", got.Name)
	}
}

// And not before that. A reserve is a relay whose cost is paid in distance, so
// while anything else is answering it stays where it is.
func TestTheReserveIsLeftAloneWhileTheOrdinaryOneAnswers(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, held}, map[string]bool{near.URL: true, held.URL: true})

	for _, room := range []string{"standup", "retro", "one-to-one", "all-hands"} {
		if got := chosen.pick(room, "", nil, false, false); got.Name != "guangzhou" {
			t.Fatalf("room %q went to the reserve while the ordinary relay was answering", room)
		}
	}
}

func TestARelayNobodyHasLookedAtYetIsOffered(t *testing.T) {
	conf := &config.Config{}
	conf.Meet.RelayPolicy = config.PickSticky

	chosen := newRelays(conf, &listed{relays: []store.Relay{near, far}})
	chosen.reach = newReach(fixed(map[string]bool{}))

	// Nothing has been checked. A relay added a moment ago has not been looked
	// at, and hiding it until a ticker comes round looks like a broken save to
	// whoever just added it.
	if got := len(chosen.offered()); got != 2 {
		t.Errorf("offered %d of 2 relays before any had been checked", got)
	}
}

func names(list []store.Relay) []string {
	out := make([]string, 0, len(list))
	for _, relay := range list {
		out = append(out, relay.Name)
	}

	return out
}

/*
What a total blackout means, and what it does not.

This deployment's control node lost the network thirty-two times in one week,
for twenty to forty seconds each, and every time it did the reachability sweep
marked all eleven relays unreachable —
machines in mainland China, Hong Kong, Singapore, Japan and Los Angeles, which
share no path with each other but the last one into this house. The relays were
fine. The list every client is offered went empty anyway, so a twenty-second
blip on somebody's home connection became a deployment with nowhere to hold a
call, and the log said eleven relays had failed.

The rule these guard is that a sweep in which nothing answered is a measurement
of this end. The asymmetry decides it: wrongly keeping a dead fleet listed costs
a client one failed connection and a retry, which it would have paid anyway;
wrongly dropping a live one costs everybody the ability to call at all.
*/

func TestNothingAnsweringIsReadAsThisMachineAndNotTheFleet(t *testing.T) {
	fleet := []store.Relay{
		{Name: "tokyo", URL: "wss://jp.invalid", Enabled: true},
		{Name: "hongkong", URL: "wss://hk.invalid", Enabled: true},
		{Name: "losangeles", URL: "wss://lax.invalid", Enabled: true},
	}

	answering := true
	watch := newReach(func(context.Context, string) (bool, time.Duration, string) {
		return answering, time.Millisecond, "timed out"
	})

	watch.look(context.Background(), fleet)

	if got := len(watch.only(fleet)); got != 3 {
		t.Fatalf("%d relays answering while everything answered, want 3", got)
	}

	// The line goes out.
	answering = false
	watch.look(context.Background(), fleet)

	// only(), not keep(). keep() has long returned everything when nothing is
	// left, which is what stopped a blackout from emptying the list clients are
	// offered — so asserting on keep() here would pass with this rule removed
	// and prove nothing. What was wrong is one layer down: the readings
	// themselves were being overwritten, so the picker's own view went empty
	// and every relay was logged as having failed.
	if got := len(watch.only(fleet)); got != 3 {
		t.Errorf("%d relays recorded as answering after a sweep that reached none of them, "+
			"want 3: three machines on three continents did not fail together, and writing "+
			"that down makes the log say eleven relays died every time this house loses its "+
			"line", got)
	}

	// And a real failure, of one machine, is still believed.
	answering = true
	watch.look(context.Background(), fleet)

	one := 0
	watch2 := newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		one++
		return url != "wss://hk.invalid", time.Millisecond, "timed out"
	})
	// Twice, because one failed check no longer withdraws anything: the check
	// measures this node's own path and that path has bad minutes, so a single
	// reading is a suspicion rather than a finding. Two in a row is a finding,
	// and this test is about a machine that is genuinely down.
	watch2.look(context.Background(), fleet)
	watch2.look(context.Background(), fleet)

	kept := watch2.only(fleet)
	if len(kept) != 2 {
		t.Errorf("%d relays kept when one of three was down, want 2: the rule is about "+
			"everything failing at once, not about any failure", len(kept))
	}

	for _, relay := range kept {
		if relay.Name == "hongkong" {
			t.Error("the relay that was actually down is still offered")
		}
	}
}

// And the readings come back by themselves, without needing a restart.
func TestReadingsResumeWhenTheLineComesBack(t *testing.T) {
	fleet := []store.Relay{
		{Name: "tokyo", URL: "wss://jp.invalid", Enabled: true},
		{Name: "hongkong", URL: "wss://hk.invalid", Enabled: true},
		{Name: "singapore", URL: "wss://sg.invalid", Enabled: true},
	}

	answering := false
	watch := newReach(func(context.Context, string) (bool, time.Duration, string) {
		return answering, time.Millisecond, "timed out"
	})

	// Out for a while, which must not accumulate into anything.
	for range 5 {
		watch.look(context.Background(), fleet)
	}

	if watch.blind != 5 {
		t.Errorf("counted %d blind sweeps, want 5", watch.blind)
	}

	answering = true
	watch.look(context.Background(), fleet)

	if watch.blind != 0 {
		t.Error("the count did not clear when the line came back, so the next outage would " +
			"be reported as part of this one")
	}

	if got := len(watch.only(fleet)); got != 3 {
		t.Errorf("%d relays recorded as answering after the line came back, want 3", got)
	}
}

// The shape the readings actually have, which is not the shape this was first
// written for.
//
// A sweep is sequential — eleven relays at a three-second timeout is up to
// thirty-three seconds of walking — and these outages last twenty to forty. So
// the sweep straddles the outage and some relays are checked while the line is
// up. Fourteen hours of production readings hold ten sweeps where eight of
// eleven failed together and not one where all eleven did, so a rule asking for
// all of them would never have fired once.
func TestMostOfTheFleetFailingIsAlsoReadAsThisMachine(t *testing.T) {
	fleet := make([]store.Relay, 0, 11)
	for i := range 11 {
		fleet = append(fleet, store.Relay{
			Name:    fmt.Sprintf("relay%02d", i),
			URL:     fmt.Sprintf("wss://r%02d.invalid", i),
			Enabled: true,
		})
	}

	// Eight of eleven, which is what the log says one of these looks like.
	failing := map[string]bool{}
	for _, relay := range fleet[:8] {
		failing[relay.URL] = true
	}

	watch := newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		return !failing[url], time.Millisecond, "timed out"
	})

	// Everything up first, so there is a reading to keep.
	all := map[string]bool{}
	settled := newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		return !all[url], time.Millisecond, ""
	})
	settled.look(context.Background(), fleet)

	if got := len(settled.only(fleet)); got != 11 {
		t.Fatalf("%d answering before anything went wrong, want 11", got)
	}

	watch.look(context.Background(), fleet)

	if got := len(watch.only(fleet)); got != 11 {
		t.Errorf("%d relays recorded as answering after eight of eleven failed at once, want "+
			"11: eleven machines in five places on three continents do not lose eight of "+
			"themselves in the same half minute, and writing that down empties the picker "+
			"for whoever is nearest the three that happened to be checked early", got)
	}

	// And a minority failing is still believed, because that is a relay.
	only := map[string]bool{fleet[0].URL: true}
	one := newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		return !only[url], time.Millisecond, "timed out"
	})
	one.look(context.Background(), fleet)
	one.look(context.Background(), fleet)

	if got := len(one.only(fleet)); got != 10 {
		t.Errorf("%d answering when one of eleven was down, want 10: the rule is about most "+
			"of them failing together, not about any failure", got)
	}
}

/*
 * One bad check is a suspicion; two in a row is a finding.
 *
 * This check measures the path from this node, and offers the answer to clients
 * whose paths are different. For a relay in Los Angeles and a caller in
 * California that is not merely a different path, it is a different ocean.
 *
 * Withdrawing on one reading cost this deployment its American relay
 * thirty-nine times in one day, all of it in the evening, when the line out of
 * here is congested and a handshake that normally takes three hundred
 * milliseconds does not finish inside four seconds. The measurements: ten
 * outages, eight of twenty-six to twenty-nine seconds — one failed check, at a
 * check every thirty — and two of about a minute.
 *
 * So two, and the fifth of them that are real are still caught thirty seconds
 * later. Coming back is not symmetrical: a relay that answers is offered again
 * at once, because the cost of being slow about that is a caller sent further
 * away for no reason.
 */
func TestARelayIsNotWithdrawnOnOneFailedCheck(t *testing.T) {
	fleet := []store.Relay{
		{Name: "tokyo", URL: "wss://jp.invalid", Enabled: true},
		{Name: "losangeles", URL: "wss://lax.invalid", Enabled: true},
		{Name: "hongkong", URL: "wss://hk.invalid", Enabled: true},
	}

	lax := true
	watch := newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		if url == "wss://lax.invalid" {
			return lax, time.Millisecond, "timed out"
		}

		return true, time.Millisecond, ""
	})

	watch.look(context.Background(), fleet)

	// One bad minute on our own line.
	lax = false
	watch.look(context.Background(), fleet)

	if got := len(watch.only(fleet)); got != 3 {
		t.Fatalf("%d relays offered after one failed check, want 3: a single reading from "+
			"one vantage point is not enough to take a machine away from everybody", got)
	}

	// It answers again, and the count starts over.
	lax = true
	watch.look(context.Background(), fleet)

	lax = false
	watch.look(context.Background(), fleet)

	if got := len(watch.only(fleet)); got != 3 {
		t.Errorf("%d relays offered, want 3: a failure, a success and a failure is two bad "+
			"minutes rather than a machine that has gone, and counting them together would "+
			"withdraw a relay that answered in between", got)
	}

	// Twice in a row, which is the finding.
	watch.look(context.Background(), fleet)

	kept := watch.only(fleet)
	if len(kept) != 2 {
		t.Fatalf("%d relays offered after two failed checks in a row, want 2: a relay that "+
			"has gone has to be taken out of the list or every call is sent to it", len(kept))
	}

	for _, relay := range kept {
		if relay.Name == "losangeles" {
			t.Error("the relay that failed twice is still offered")
		}
	}

	// And back at once on the first success, without waiting for a second.
	lax = true
	watch.look(context.Background(), fleet)

	if got := len(watch.only(fleet)); got != 3 {
		t.Errorf("%d relays offered after the failed one answered again, want 3: waiting for "+
			"a second good check sends somebody further away for another half minute, and "+
			"there is nothing to be careful about in a machine that is working", got)
	}
}

/*
 * A relay reached through a forwarder on this machine is not measured from here.
 *
 * One relay on this fleet is on a network this node cannot route to. It is
 * reached through a TCP proxy on loopback, named in the machine's hosts file, so
 * the address the deployment holds for it resolves to 127.0.0.0/8 here and to
 * the real machine everywhere else.
 *
 * The media check sends a UDP probe to that address. The proxy carries TCP, so
 * the probe goes to this machine, finds nothing listening, and reports the
 * relay's media port as unreachable — thirteen times in a day with no recovery
 * between them, about a relay that answers the same probe in three hundred
 * milliseconds when it is asked from anywhere else. Every one of those was a
 * message to a person about a machine that was working.
 *
 * The rule reads itself: an address that points back here describes the
 * forwarder, not the relay.
 */
func TestAProbeThatPointsAtThisMachineIsNotAMeasurement(t *testing.T) {
	for _, probe := range []string{
		"127.0.0.2:39218",
		"127.0.0.1:39218",
		"localhost:39218",
		"[::1]:39218",
	} {
		if !forwardedLocally(probe) {
			t.Errorf("%q was measured, and it points at this machine", probe)
		}
	}

	for _, probe := range []string{
		"198.51.100.9:39218",
		"shct.api.example:39218",
		"",
	} {
		if forwardedLocally(probe) {
			t.Errorf("%q was treated as a local forwarder, so a relay this node genuinely "+
				"cannot reach on UDP would never be reported at all", probe)
		}
	}
}

// And the rule is actually consulted, which the test above does not show: it
// exercises the function, and deleting the one line that calls it leaves that
// test green. This one drives the check itself.
//
// A probe pointing at this machine, and nothing listening on it — which is
// exactly the deployment's own case. Without the guard the probe is sent, fails
// as it always would, and the relay is recorded as having lost its media port.
func TestTheMediaCheckSkipsARelayReachedThroughThisMachine(t *testing.T) {
	watch := newReach(fixed(map[string]bool{}))

	relay := store.Relay{
		Name: "shanghai", URL: "wss://shct.example:39217",
		Enabled: true, Probe: "127.0.0.2:39218",
	}

	watch.carrying(context.Background(), relay, true)

	watch.mu.RLock()
	recorded, seen := watch.silent[relay.URL]
	watch.mu.RUnlock()

	if seen && recorded {
		t.Error("a relay reached through a forwarder on this machine was recorded as having " +
			"lost its media port; that is thirteen messages a day about a machine that is " +
			"carrying calls, and it never recovers because there is nothing there to recover")
	}
}
