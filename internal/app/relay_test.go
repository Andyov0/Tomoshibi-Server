package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

// listed is a relay list somebody wrote down, standing in for the store.
type listed struct {
	relays []store.Relay
	err    error
	// reads counts how often the list was asked for, so the cache can be
	// tested for doing what it claims.
	reads int
}

func (l *listed) Relays() ([]store.Relay, error) {
	l.reads++
	if l.err != nil {
		return nil, l.err
	}
	return l.relays, nil
}

func relaysOf(policy string, list ...store.Relay) *relays {
	return &relays{source: &listed{relays: list}, policy: policy}
}

var (
	sh = store.Relay{Name: "shanghai", URL: "wss://sh.example.com", Region: "cn-east", Enabled: true}
	hk = store.Relay{Name: "hongkong", URL: "wss://hk.example.com", Region: "hk", Enabled: true}
	jp = store.Relay{Name: "tokyo", URL: "wss://jp.example.com", Region: "jp", Enabled: true}
)

// The property the whole sticky policy exists for: everybody who names the same
// room is sent to the same relay. Get this wrong and a meeting is split across
// machines that, without redis, cannot hear each other — and the symptom is two
// people in "the same" room staring at empty tiles.
func TestStickyKeepsARoomTogether(t *testing.T) {
	r := relaysOf(config.PickSticky, sh, hk, jp)

	for _, name := range []string{"standup", "one-on-one", "退屈", "a"} {
		first := r.pick(name, "", nil, false, false)

		for i := 0; i < 50; i++ {
			if got := r.pick(name, "", nil, false, false); got.URL != first.URL {
				t.Fatalf("room %q went to %s then %s: a meeting cannot be split",
					name, first.URL, got.URL)
			}
		}
	}
}

// Stability across processes, which is what lets two control nodes stand behind
// one address and what lets one be restarted in the middle of a meeting.
//
// Written against fixed numbers rather than by comparing two instances, because
// comparing instances does not test this. A seeded hash is seeded once per
// process, so two instances inside one test agree with each other perfectly and
// disagree with the next process — which is precisely the fault, and it passes.
// That version of this test was written first and caught nothing: swapping FNV
// for maphash left it green.
//
// These are FNV-1a/64 of the name. If a change here is deliberate, every
// deployment running more than one control node has to be restarted together,
// because until they are the two halves of a meeting will be sent to different
// relays.
func TestStickyIsStableAcrossProcesses(t *testing.T) {
	for _, tc := range []struct {
		room string
		want uint64
	}{
		{"standup", 785736587849392022},
		{"retro", 1602353422691474863},
		{"1", 12638134423997487868},
		{"zzzzzzzz", 1790959236010823653},
		{"", 14695981039346656037},
		{"退屈", 9797011586680834698},
	} {
		if got := hashRoom(tc.room); got != tc.want {
			t.Errorf("hashRoom(%q) = %d, wanted %d. Rooms will move between relays "+
				"across a restart", tc.room, got, tc.want)
		}
	}
}

// Different rooms should not all pile onto one relay. Not a guarantee the hash
// can make for any particular pair, so this asks the weaker thing that actually
// matters: over many names, every relay is used.
func TestStickySpreadsRoomsAcrossRelays(t *testing.T) {
	r := relaysOf(config.PickSticky, sh, hk, jp)

	used := map[string]int{}
	for _, name := range []string{
		"alpha", "bravo", "charlie", "delta", "echo", "foxtrot",
		"golf", "hotel", "india", "juliet", "kilo", "lima",
	} {
		used[r.pick(name, "", nil, false, false).URL]++
	}

	if len(used) != 3 {
		t.Fatalf("twelve rooms reached %d of 3 relays: %v", len(used), used)
	}
}

func TestNearestPrefersAMatchingRegion(t *testing.T) {
	r := relaysOf(config.PickNearest, sh, hk, jp)

	for _, tc := range []struct{ region, want string }{
		{"hk", hk.URL},
		{"jp", jp.URL},
		{"cn-east", sh.URL},
		// Case is a label somebody typed in two places; it should not decide
		// which continent a client is sent to.
		{"HK", hk.URL},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/rooms/x/join", nil)
		req.Header.Set(headerRegion, tc.region)

		if got := r.pick("x", "", req, true, false); got.URL != tc.want {
			t.Errorf("region %q went to %s, wanted %s", tc.region, got.URL, tc.want)
		}
	}
}

// An unknown region must fall back to sticky rather than to the first entry.
// Falling to the first would quietly gather every unlabelled client onto one
// relay, which is both a hotspot and a meeting split from the labelled half.
func TestNearestFallsBackToSticky(t *testing.T) {
	r := relaysOf(config.PickNearest, sh, hk, jp)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms/x/join", nil)
	req.Header.Set(headerRegion, "antarctica")

	sticky := relaysOf(config.PickSticky, sh, hk, jp)

	for _, name := range []string{"standup", "retro", "alpha"} {
		if got, want := r.pick(name, "", req, true, false), sticky.pick(name, "", nil, false, false); got.URL != want.URL {
			t.Errorf("room %q with an unknown region went to %s, wanted the sticky choice %s",
				name, got.URL, want.URL)
		}
	}
}

// The region header is a claim, and an unproxied deployment has nobody to
// overwrite it. Believing it there would make the setting mean one thing behind
// a proxy and another in front of one.
func TestRegionIsIgnoredWithoutTrustProxy(t *testing.T) {
	r := relaysOf(config.PickNearest, sh, hk, jp)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms/x/join", nil)
	req.Header.Set(headerRegion, "jp")

	sticky := relaysOf(config.PickSticky, sh, hk, jp)

	if got, want := r.pick("standup", "", req, false, false), sticky.pick("standup", "", nil, false, false); got.URL != want.URL {
		t.Fatalf("an untrusted region header chose %s; without trust_proxy it should be "+
			"ignored and give the sticky choice %s", got.URL, want.URL)
	}
}

func TestCloudflareCountryIsAccepted(t *testing.T) {
	r := relaysOf(config.PickNearest, sh, hk, jp)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms/x/join", nil)
	req.Header.Set(headerCountry, "jp")

	if got := r.pick("x", "", req, true, false); got.URL != jp.URL {
		t.Fatalf("CF-IPCountry jp went to %s, wanted %s", got.URL, jp.URL)
	}
}

func TestRoundRobinVisitsEveryRelayInTurn(t *testing.T) {
	r := relaysOf(config.PickRoundRobin, sh, hk, jp)

	seen := map[string]int{}
	for i := 0; i < 9; i++ {
		seen[r.pick("same-room-every-time", "", nil, false, false).URL]++
	}

	for _, relay := range []store.Relay{sh, hk, jp} {
		if seen[relay.URL] != 3 {
			t.Errorf("%s was chosen %d times in nine turns, wanted 3: %v",
				relay.Name, seen[relay.URL], seen)
		}
	}
}

func TestProbeHonoursWhatTheClientMeasured(t *testing.T) {
	r := relaysOf(config.PickProbe, sh, hk, jp)

	for _, relay := range []store.Relay{sh, hk, jp} {
		if got := r.pick("standup", relay.Name, nil, false, false); got.URL != relay.URL {
			t.Errorf("client measured %s as fastest and was sent to %s", relay.Name, got.URL)
		}
	}
}

// The trust boundary. A client sends a name, and a name that is not one of ours
// buys nothing: not an address of the caller's choosing, and not an error either
// — they land on the room's own relay like anybody who did not measure.
//
// The addresses below are what an attacker would try if the field were ever
// read as a URL, which is exactly why it is not.
func TestProbeIgnoresARelayWeDoNotHave(t *testing.T) {
	r := relaysOf(config.PickProbe, sh, hk, jp)
	sticky := relaysOf(config.PickSticky, sh, hk, jp)

	for _, claimed := range []string{
		"wss://attacker.example.com",
		"ws://127.0.0.1:7880",
		"osaka",
		"SHANGHAI",
		"shanghai ",
		"",
	} {
		want := sticky.pick("standup", "", nil, false, false)

		if got := r.pick("standup", claimed, nil, false, false); got.URL != want.URL {
			t.Errorf("a client claiming relay %q was sent to %s, wanted the sticky choice %s",
				claimed, got.URL, want.URL)
		}
	}
}

// A measurement is only listened to under probe. Under the others it is a field
// the client filled in that the deployment has decided not to act on, and
// honouring it would quietly defeat whichever policy was configured.
func TestOtherPoliciesIgnoreAMeasurement(t *testing.T) {
	for _, policy := range []string{config.PickSticky, config.PickNearest} {
		r := relaysOf(policy, sh, hk, jp)
		sticky := relaysOf(config.PickSticky, sh, hk, jp)

		want := sticky.pick("standup", "", nil, false, false)

		// Naming the relay the sticky hash did not choose, so that a policy
		// which wrongly honoured it would visibly differ.
		other := hk.Name
		if want.Name == hk.Name {
			other = jp.Name
		}

		if got := r.pick("standup", other, nil, false, false); got.URL != want.URL {
			t.Errorf("policy %q honoured a measurement naming %s and chose %s, wanted %s",
				policy, other, got.URL, want.URL)
		}
	}
}

// One relay is not a choice, whatever the policy says. This is the case a
// deployment starts in, and every policy has to survive it.
func TestASingleRelayIsAlwaysChosen(t *testing.T) {
	for _, policy := range []string{config.PickSticky, config.PickNearest, config.PickRoundRobin, config.PickProbe} {
		r := relaysOf(policy, sh)

		if got := r.pick("anything", "", nil, false, false); got.URL != sh.URL {
			t.Errorf("policy %q with one relay chose %s", policy, got.URL)
		}
	}
}

func TestNoRelaysMeansNothingToChoose(t *testing.T) {
	if relaysOf(config.PickSticky).any() {
		t.Error("an empty list reported that it had relays")
	}

	if (*relays)(nil).any() {
		t.Error("a nil relays reported that it had relays")
	}
}

// A relay taken out of service must stop receiving clients, and must do so
// without the list being emptied: the calls already on it keep running, and an
// operator who disabled one and saw new callers still arriving would reasonably
// conclude the switch did nothing.
/*
A relay out of service is shown and not used, which are two different things.

It has to be shown, because one that vanishes from the list looks deleted:
somebody who used it yesterday and cannot find it today has no way to tell a
machine taken down for an hour from a machine taken away, and asks. It is sent
with a flag saying what it is, and a picker draws it greyed.

It must never be used, and that includes being asked for by name — a client
measured it before it went down and will send that name at the next join.
*/

func TestARelayOutOfServiceIsShownButNeverUsed(t *testing.T) {
	off := jp
	off.Enabled = false

	r := &relays{source: &listed{relays: []store.Relay{sh, hk, off}}, policy: config.PickProbe}

	if got := r.pick("standup", "tokyo", nil, false, false); got.URL == jp.URL {
		t.Error("a client that measured a relay taken out of service was sent there anyway")
	}

	shown := false
	for _, relay := range r.offered() {
		if relay.Name == "tokyo" {
			shown = true

			if relay.Enabled {
				t.Error("a relay out of service was offered as though it were in it")
			}
		}
	}

	if !shown {
		t.Error("a relay out of service was hidden rather than shown as out of service; " +
			"one that vanishes is indistinguishable from one that was deleted")
	}
}

// The list is cached so that a join is not a database read, and dropped the
// moment the management pages change it. Without the drop, a relay added on a
// page would not be used until the cache expired, and whoever added it would be
// looking at a page saying it is there beside a join that does not use it.
func TestTheListIsCachedAndDroppedOnChange(t *testing.T) {
	source := &listed{relays: []store.Relay{sh, hk}}
	r := &relays{source: source, policy: config.PickSticky}

	r.pick("standup", "", nil, false, false)
	afterFirst := source.reads

	for i := 0; i < 20; i++ {
		r.pick("standup", "", nil, false, false)
	}

	if source.reads != afterFirst {
		t.Errorf("twenty joins read the store %d times; the cache is not holding",
			source.reads-afterFirst+1)
	}

	source.relays = append(source.relays, jp)
	r.forget()

	found := false
	for _, relay := range r.offered() {
		if relay.Name == "tokyo" {
			found = true
		}
	}

	if !found {
		t.Error("a relay added after the cache was dropped was still not offered")
	}
}

// A store that will not answer must not empty the list. Every relay would
// vanish at once, every join would be told there is nowhere to hold a call, and
// the deployment would go dark over a database that is briefly busy.
func TestAFailingStoreKeepsTheLastList(t *testing.T) {
	source := &listed{relays: []store.Relay{sh, hk}}
	r := &relays{source: source, policy: config.PickSticky}

	first := r.pick("standup", "", nil, false, false)
	if first.URL == "" {
		t.Fatal("nothing was chosen from a working store")
	}

	source.err = errors.New("the database is busy")
	r.forget()

	if got := r.pick("standup", "", nil, false, false); got.URL != first.URL {
		t.Errorf("a failing store changed the choice from %s to %q; the last known list "+
			"should stand", first.URL, got.URL)
	}
}

/*
A relay kept for administrators has to be kept from everybody else in both of
the places it could leak: the list that is published, and the choosing.

Hiding it from the list stops it being picked by accident. Refusing it at the
choice is what stops it being picked on purpose by somebody who read the name off
a colleague's screen — and the second is the one that would be quietly missing,
because with the list filtered nothing on any screen would ever show it working.
*/

// The list shows everything to everybody, and says what each one is. Nothing is
// protected by leaving a name out — a relay reserved for administrators is kept
// by the refusal at the join, which is where somebody actually asks to come in
// and which works whether or not they read the name off a colleague's screen.
func TestEveryRelayIsShownToEverybody(t *testing.T) {
	conf := &config.Config{}
	conf.Meet.RelayPolicy = config.PickProbe

	open := store.Relay{Name: "public", URL: "wss://a.example:1", Enabled: true}
	kept := store.Relay{Name: "private", URL: "wss://b.example:1", Enabled: true, AdminOnly: true}

	chosen := newRelays(conf, &listed{relays: []store.Relay{open, kept}})

	for _, admin := range []bool{false, true} {
		if got := len(chosen.offered()); got != 2 {
			t.Errorf("offered %d of 2 relays with admin=%v", got, admin)
		}
	}
}

func TestARelayForAdministratorsCannotBeAskedForByName(t *testing.T) {
	conf := &config.Config{}
	conf.Meet.RelayPolicy = config.PickProbe

	open := store.Relay{Name: "public", URL: "wss://a.example:1", Enabled: true}
	kept := store.Relay{Name: "private", URL: "wss://b.example:1", Enabled: true, AdminOnly: true}

	chosen := newRelays(conf, &listed{relays: []store.Relay{open, kept}})

	// Named outright, which is the case filtering the list does nothing about.
	if got := chosen.pick("standup", "private", nil, false, false); got.Name != "public" {
		t.Errorf("a relay reserved for administrators was handed to %q, which asked for it "+
			"by name", got.Name)
	}

	if got := chosen.pick("standup", "private", nil, false, true); got.Name != "private" {
		t.Errorf("an administrator asking for their own reserved relay got %q", got.Name)
	}
}

// Asked for by somebody who may not use it, a reserved relay is refused rather
// than swapped. Falling back silently leaves somebody looking at a call held
// somewhere they did not pick, with no way to tell that from the picker having
// worked.
func TestAReservedRelayIsRefusedByNameAndNotSwapped(t *testing.T) {
	conf := &config.Config{}
	conf.Meet.RelayPolicy = config.PickProbe

	open := store.Relay{Name: "public", URL: "wss://a.example:1", Enabled: true}
	kept := store.Relay{Name: "private", URL: "wss://b.example:1", Enabled: true, AdminOnly: true}

	chosen := newRelays(conf, &listed{relays: []store.Relay{open, kept}})

	if !chosen.reserved("private") {
		t.Error("a relay kept for administrators was not recognised as reserved")
	}

	if chosen.reserved("public") {
		t.Error("an ordinary relay was treated as reserved")
	}

	// A name nobody has is a different case and must stay one: it is ignored,
	// and the caller gets whichever relay the policy chooses.
	if chosen.reserved("a-relay-that-was-removed") {
		t.Error("a name nobody has was refused rather than ignored")
	}

	if chosen.reserved("") {
		t.Error("asking for nothing was treated as asking for something reserved")
	}
}

// A deployment that holds its own media has no relay list, and asking it to
// choose must be an answer rather than a crash.
//
// It became one when the join started asking for the chosen relay by name as
// well as by address: the call moved out from behind the guard that had always
// stood in front of it, and a nil list met a method that assumed one. The test
// that caught it was a join on an ordinary single-machine deployment, which is
// the commonest way this program is run.
func TestChoosingWithNoRelaysIsAnAnswerAndNotACrash(t *testing.T) {
	var none *relays

	got := none.pick("standup", "", nil, false, false)

	if got.URL != "" || got.Name != "" {
		t.Errorf("a deployment with no relays chose %+v", got)
	}
}
