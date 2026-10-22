package store

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

/*
A rule that names a machine, and what happens to it when the machine's name
changes.

Apart is the only place one relay refers to another, and it refers by name. That
makes renaming and removing a relay into edits of every rule written about it,
which is not how either used to behave: both changed the relay and left the
rules alone. Neither produced an error, because a rule naming something that is
not there is not an error — it is a rule that answers "no" to every question and
therefore stops applying.

What those rules do on this deployment is keep two machines from being asked to
carry for each other over a path that does not exist. Switching one off silently
is the worst available outcome: the rule is still on the page, the operator
still believes it holds, and the calls it was written to prevent are now made.
*/

func TestRenamingARelayRewritesTheRulesThatNameIt(t *testing.T) {
	store := open(t)

	for _, relay := range []Relay{
		{Name: "shanghai", URL: "wss://sh.invalid", Enabled: true},
		{Name: "hongkong", URL: "wss://hk.invalid", Enabled: true, Apart: []string{"shanghai"}},
		{Name: "tokyo", URL: "wss://jp.invalid", Enabled: true, Apart: []string{"osaka", "shanghai"}},
	} {
		if err := store.AddRelay(relay); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.RenameRelay("shanghai", "shanghai-telecom"); err != nil {
		t.Fatal(err)
	}

	list, err := store.Relays()
	if err != nil {
		t.Fatal(err)
	}

	for _, relay := range list {
		for _, named := range relay.Apart {
			if named == "shanghai" {
				t.Errorf("%s is still kept apart from \"shanghai\", which no longer exists: the "+
					"rule reads as though it holds and matches nothing", relay.Name)
			}
		}
	}

	var found int
	for _, relay := range list {
		for _, named := range relay.Apart {
			if named == "shanghai-telecom" {
				found++
			}
		}
	}

	if found != 2 {
		t.Errorf("%d rules follow the rename, want 2: %+v", found, list)
	}

	// And nothing else in the lists was disturbed.
	for _, relay := range list {
		if relay.Name != "tokyo" {
			continue
		}

		if len(relay.Apart) != 2 || relay.Apart[0] != "osaka" {
			t.Errorf("tokyo's other rule was lost: %v", relay.Apart)
		}
	}
}

func TestRemovingARelayTakesTheRulesThatNameItWithIt(t *testing.T) {
	store := open(t)

	for _, relay := range []Relay{
		{Name: "shanghai", URL: "wss://sh.invalid", Enabled: true},
		{Name: "hongkong", URL: "wss://hk.invalid", Enabled: true, Apart: []string{"shanghai", "osaka"}},
	} {
		if err := store.AddRelay(relay); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.RemoveRelay("shanghai"); err != nil {
		t.Fatal(err)
	}

	list, err := store.Relays()
	if err != nil {
		t.Fatal(err)
	}

	for _, relay := range list {
		for _, named := range relay.Apart {
			if named == "shanghai" {
				t.Error("a rule about a removed relay was left behind. It matches nothing " +
					"today, and it comes back to life the day something is enrolled under " +
					"that name again — against a machine nobody wrote it about")
			}
		}

		if relay.Name == "hongkong" && len(relay.Apart) != 1 {
			t.Errorf("hongkong's remaining rules are %v, want just osaka", relay.Apart)
		}
	}
}

// SignalVia is the other place one relay names another. Renamed, the relays
// that signal through it follow; removed while one still does, the removal is
// refused, because clearing the setting sends that relay's clients back to a
// handshake their networks reset, and leaving it names a machine that is gone
// until something else is enrolled under the name.
func TestARelaySignalledThroughKeepsThoseThatNameIt(t *testing.T) {
	store := open(t)

	for _, relay := range []Relay{
		{Name: "hongkong", URL: "wss://hk.invalid", Enabled: true},
		{Name: "guangzhou", URL: "wss://gz.invalid", Enabled: true, SignalVia: "hongkong"},
		{Name: "wuhan", URL: "wss://wh.invalid", Enabled: true, SignalVia: "hongkong"},
		{Name: "tokyo", URL: "wss://jp.invalid", Enabled: true},
	} {
		if err := store.AddRelay(relay); err != nil {
			t.Fatal(err)
		}
	}

	via := func() map[string]string {
		list, err := store.Relays()
		if err != nil {
			t.Fatal(err)
		}
		found := map[string]string{}
		for _, relay := range list {
			found[relay.Name] = relay.SignalVia
		}
		return found
	}

	if err := store.RenameRelay("hongkong", "HK Main"); err != nil {
		t.Fatal(err)
	}
	if got := via(); got["guangzhou"] != "HK Main" || got["wuhan"] != "HK Main" || got["tokyo"] != "" {
		t.Errorf("after the rename the relays signal through %v; want guangzhou and wuhan through HK Main", got)
	}

	if err := store.RemoveRelay("HK Main"); !errors.Is(err, ErrRelaySignalledThrough) {
		t.Errorf("removing a relay two others signal through answered %v, want ErrRelaySignalledThrough", err)
	}
	if got := via(); got["guangzhou"] != "HK Main" {
		t.Errorf("a refused removal changed what guangzhou signals through: %v", got)
	}
	if _, still := via()["HK Main"]; !still {
		t.Error("a refused removal removed the relay")
	}

	// Pointed elsewhere, it goes.
	for _, name := range []string{"guangzhou", "wuhan"} {
		relay := Relay{Name: name, URL: "wss://" + name + ".invalid", Enabled: true, SignalVia: "tokyo"}
		if err := store.UpdateRelay(relay); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.RemoveRelay("HK Main"); err != nil {
		t.Errorf("removing a relay nothing signals through any more answered %v", err)
	}
}

/*
Who a room answers to when two people open it together.

This was two statements — is there a host, and if not become one — with a gap
between them wide enough for both of two simultaneous openers to pass the first
before either reached the second. The room then answered to whichever write the
store finished last, which is not the person who opened it.

Run with -race and enough goroutines that the gap, if it comes back, is found
rather than argued about.
*/
func TestOnlyOnePersonBecomesTheHostOfARoomOpenedAtOnce(t *testing.T) {
	store := open(t)

	if _, err := store.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	const racers = 32

	var (
		ready sync.WaitGroup
		start = make(chan struct{})
		won   atomic.Int32
	)

	ready.Add(racers)

	for i := range racers {
		go func() {
			defer ready.Done()
			<-start

			if claimed, err := store.ClaimHost("standup", fmt.Sprintf("mark%02d", i)); err == nil && claimed {
				won.Add(1)
			}
		}()
	}

	close(start)
	ready.Wait()

	if got := won.Load(); got != 1 {
		t.Errorf("%d of %d openers were told they had the room, want exactly 1: a room that "+
			"answers to two people answers to whichever of them the store wrote last", got, racers)
	}

	if host := store.HostOf("standup"); host == "" {
		t.Error("nobody holds the room, and somebody opened it")
	}
}
