package admin

import (
	"context"
	"errors"
	"testing"
	"time"

	"tomoshibi/internal/rtc"
)

/*
Summing a fleet has one failure that matters and it is silent.

A relay that does not answer contributes nothing, which is arithmetically
obvious and operationally wrong: the totals fall, the page shows fewer people in
fewer calls, and it reads as a meeting ending rather than as a machine going
away. Somebody watching would conclude the deployment is quiet at exactly the
moment it is broken.

So a reading carries how many relays were asked and how many answered, every
node says whether it was reachable, and the totals are of the ones that spoke.
The tests below are mostly about that distinction.
*/

// fleet is a set of relays that answer whatever they are told to.
type fleet struct {
	urls    []string
	answers map[string]rtc.Stats
	errs    map[string]error
	// slow holds a relay for longer than the reading is prepared to wait.
	slow map[string]time.Duration
}

func (f *fleet) Relays() []string { return f.urls }

func (f *fleet) AskStats(ctx context.Context, relay string) (rtc.Stats, error) {
	if wait, ok := f.slow[relay]; ok {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return rtc.Stats{}, ctx.Err()
		}
	}

	if err, ok := f.errs[relay]; ok {
		return rtc.Stats{}, err
	}

	return f.answers[relay], nil
}

func TestFleetAddsUpWhatAnswered(t *testing.T) {
	f := &fleet{
		urls: []string{"wss://a.invalid", "wss://b.invalid"},
		answers: map[string]rtc.Stats{
			"wss://a.invalid": {Rooms: 2, Clients: 5, BytesOut: 100, OutPerSec: 10, Window: 2, CPUs: 4},
			"wss://b.invalid": {Rooms: 1, Clients: 3, BytesOut: 50, OutPerSec: 5, Window: 10, CPUs: 8},
		},
	}

	got := readFleet(context.Background(), f, map[string]relayLook{
		"wss://a.invalid": {Name: "alpha", Label: "Alpha", Region: "CN-East"},
		"wss://b.invalid": {Name: "bravo", Label: "Bravo", Region: "Oversea/Asia"},
	})

	if got.Answered != 2 || got.Asked != 2 {
		t.Fatalf("asked %d answered %d, wanted 2 and 2", got.Asked, got.Answered)
	}

	if got.Totals.Rooms != 3 || got.Totals.Clients != 8 {
		t.Errorf("totals were %d rooms and %d clients, wanted 3 and 8",
			got.Totals.Rooms, got.Totals.Clients)
	}

	if got.Totals.OutPerSec != 15 {
		t.Errorf("throughput summed to %v, wanted 15", got.Totals.OutPerSec)
	}

	// The widest window, not the sum. Two rates measured over different windows
	// do not make a rate over their total, and a page that said "12 seconds"
	// would be describing a measurement nobody took.
	if got.Totals.Window != 10 {
		t.Errorf("window came out as %v, wanted the widest of the two (10)", got.Totals.Window)
	}
}

// The one that matters. A relay that is down must be visible as down rather
// than as a relay holding no calls, and must not drag the totals with it.
func TestAnUnreachableRelayIsNotAQuietOne(t *testing.T) {
	f := &fleet{
		urls: []string{"wss://up.invalid", "wss://down.invalid"},
		answers: map[string]rtc.Stats{
			"wss://up.invalid": {Rooms: 4, Clients: 9},
		},
		errs: map[string]error{
			"wss://down.invalid": errors.New("connection refused"),
		},
	}

	got := readFleet(context.Background(), f, nil)

	if got.Asked != 2 || got.Answered != 1 {
		t.Fatalf("asked %d answered %d, wanted 2 and 1: a page cannot tell a quiet "+
			"deployment from a broken one without both numbers", got.Asked, got.Answered)
	}

	if got.Totals.Rooms != 4 || got.Totals.Clients != 9 {
		t.Errorf("totals were %d rooms and %d clients; the unreachable relay should "+
			"contribute nothing rather than zeros that look like an answer",
			got.Totals.Rooms, got.Totals.Clients)
	}

	var down *nodeReading
	for i := range got.Nodes {
		if got.Nodes[i].URL == "wss://down.invalid" {
			down = &got.Nodes[i]
		}
	}

	if down == nil {
		t.Fatal("the unreachable relay vanished from the list; it has to be visible to be fixed")
	}

	if down.Reachable {
		t.Error("a relay that refused the connection was reported as reachable")
	}

	if down.Detail == "" {
		t.Error("nothing was said about why it did not answer")
	}
}

// One slow relay must not hold the page. Asked in parallel and bounded, a relay
// that never answers costs the timeout once rather than once per relay behind
// it in a queue.
func TestOneSlowRelayDoesNotHoldTheRest(t *testing.T) {
	f := &fleet{
		urls: []string{"wss://quick.invalid", "wss://stuck.invalid"},
		answers: map[string]rtc.Stats{
			"wss://quick.invalid": {Rooms: 1},
		},
		slow: map[string]time.Duration{"wss://stuck.invalid": time.Minute},
	}

	started := time.Now()
	got := readFleet(context.Background(), f, nil)
	took := time.Since(started)

	if took > 15*time.Second {
		t.Fatalf("reading took %v; one unresponsive relay held the whole page", took)
	}

	if got.Answered != 1 {
		t.Errorf("%d relays answered, wanted 1", got.Answered)
	}
}

// Nodes are sorted so a page redrawn every few seconds does not reorder itself
// under whoever is reading it. Goroutines finish in whatever order the network
// allows, which is not an order anybody wants to watch.
func TestNodesComeBackInAStableOrder(t *testing.T) {
	f := &fleet{
		urls: []string{"wss://c.invalid", "wss://a.invalid", "wss://b.invalid"},
		answers: map[string]rtc.Stats{
			"wss://a.invalid": {}, "wss://b.invalid": {}, "wss://c.invalid": {},
		},
	}

	named := map[string]relayLook{
		"wss://a.invalid": {Name: "alpha"},
		"wss://b.invalid": {Name: "bravo"},
		"wss://c.invalid": {Name: "charlie"},
	}

	for i := 0; i < 5; i++ {
		got := readFleet(context.Background(), f, named)

		if len(got.Nodes) != 3 {
			t.Fatalf("got %d nodes", len(got.Nodes))
		}

		for j, want := range []string{"alpha", "bravo", "charlie"} {
			if got.Nodes[j].Name != want {
				t.Fatalf("node %d was %q, wanted %q", j, got.Nodes[j].Name, want)
			}
		}
	}
}

func TestAFleetWithNoRelaysIsEmptyRatherThanBroken(t *testing.T) {
	got := readFleet(context.Background(), &fleet{}, nil)

	if got.Asked != 0 || got.Answered != 0 || len(got.Nodes) != 0 {
		t.Errorf("an empty fleet read as %+v", got)
	}
}
