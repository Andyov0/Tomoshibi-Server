package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

/*
 * A room somebody placed is held where they placed it, and nothing else decides.
 *
 * The placement used to settle almost nothing. Signalling goes to the relay the
 * client dialled, and where the room does not exist yet that relay's node
 * creates it — wherever the cluster's selector says. So the placement arranged
 * forwarding towards a machine the meeting was not on and put that machine's
 * name on the page: the record and the screen agreed with each other and
 * disagreed with the call. That is somebody reading Nanjing off a panel while
 * the meeting is in Hong Kong.
 *
 * These are the three ways the choice used to be quietly overruled, and the one
 * way it may still fail — loudly, on a relay that has stopped answering.
 */

// A fleet that says which node each relay is, and counts being asked.
type fleetSaying struct {
	mu     sync.Mutex
	nodes  map[string]string
	failed bool
}

func (f *fleetSaying) AskStats(_ context.Context, relay string) (rtc.Stats, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failed {
		return rtc.Stats{}, errors.New("this relay is not answering")
	}

	node, ok := f.nodes[relay]
	if !ok {
		return rtc.Stats{}, errors.New("no such relay")
	}

	return rtc.Stats{Node: node}, nil
}

// A control that records where rooms were pinned.
//
// The interface is embedded and left nil: this exercises one method of it, and
// anything else the join path started calling would panic here rather than
// quietly returning a zero value and passing.
type pinning struct {
	admin.Control

	mu   sync.Mutex
	held []string
}

func (p *pinning) Hold(_ context.Context, room, node string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.held = append(p.held, room+" on "+node)

	return nil
}

func (p *pinning) pinned() []string {
	p.mu.Lock()
	defer p.mu.Unlock()

	return append([]string(nil), p.held...)
}

func placedOn(t *testing.T, relayName string, list ...store.Relay) (*pinning, *fleetSaying, func(string), *store.Store) {
	t.Helper()

	mux, st, app := controlWithStore(t, config.PickProbe, list...)

	pins := &pinning{}
	fleet := &fleetSaying{nodes: map[string]string{}}
	for _, relay := range list {
		fleet.nodes[relay.URL] = "ND_" + relay.Name
	}

	app.control = pins
	app.fleet = fleet

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	if err := st.PlaceRoom("standup", relayName); err != nil {
		t.Fatal(err)
	}

	return pins, fleet, func(via string) { joinVia(t, mux, "standup", via) }, st
}

// outOfService takes a relay out of the list calls are chosen from, which is
// what the page's "stop sending here" does.
func outOfService(t *testing.T, st *store.Store, name string) {
	t.Helper()

	list, err := st.Relays()
	if err != nil {
		t.Fatal(err)
	}

	for _, relay := range list {
		if relay.Name != name {
			continue
		}

		relay.Enabled = false
		if err := st.UpdateRelay(relay); err != nil {
			t.Fatal(err)
		}

		return
	}

	t.Fatalf("no relay called %q to take out of service", name)
}

func TestAPlacedRoomIsPutOnTheMachineItWasPlacedOn(t *testing.T) {
	pins, _, join, _ := placedOn(t, "shanghai",
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	// Dialled through the other machine, which is the case that matters: the
	// relay somebody's browser measured as nearest is not the relay the room
	// was placed on, and the room goes where it was placed.
	join("guangzhou")

	held := pins.pinned()
	if len(held) != 1 || held[0] != "standup on ND_shanghai" {
		t.Fatalf("a placed room was pinned as %v, want it held on shanghai's node — "+
			"otherwise the first person through any door decides where the meeting is", held)
	}
}

func TestAPlacementBeatsARelayBeingOutOfService(t *testing.T) {
	pins, _, join, st := placedOn(t, "shanghai",
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	// Taken out of service after the room was placed on it, which is the order
	// this happens in: somebody pins a room, and weeks later somebody stops
	// sending calls to that machine and does not remember the pin. Read through
	// the ordinary lookup the relay is simply not there, and the room quietly
	// goes wherever the policy says.
	outOfService(t, st, "shanghai")

	join("guangzhou")

	if held := pins.pinned(); len(held) != 1 || !strings.Contains(held[0], "ND_shanghai") {
		t.Fatalf("a placed room went to %v; an operator's choice is not overruled by "+
			"anything this server works out on its own", held)
	}
}

func TestAPlacementThatCannotBePinnedDoesNotStopTheJoin(t *testing.T) {
	pins, fleet, join, _ := placedOn(t, "shanghai",
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	fleet.mu.Lock()
	fleet.failed = true
	fleet.mu.Unlock()

	// The join still works. A relay that has stopped answering costs somebody a
	// moment, not their call — the placement is written, the forwarding is
	// arranged, and the room goes where the cluster puts it, which is where it
	// went before any of this existed.
	join("guangzhou")

	if held := pins.pinned(); len(held) != 0 {
		t.Errorf("a room was pinned to %v against a relay that said nothing; the node "+
			"identifier would have been invented, and a room pinned to a node that does "+
			"not exist is one nobody can join at all", held)
	}
}
