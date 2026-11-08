package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
A relay of somebody's own, through the router.

The rules are in store/own.go and the reasons with them; what is held here is
that each is enforced where a relay is handed out and not only where the list
is drawn. Every one would fail silently. A list that hid somebody's relay while
the join still handed it out would look right to everybody who looked; a join
that fell back to an ordinary relay when somebody's own were down would look
like the deployment working; and an account that could still be sent to the
ordinary relays would be a machine somebody paid for, used as a suggestion.

ada has a relay of her own, bob has another, cleo has none, and andy is an
administrator.
*/

const (
	adaSays  = "ada's passphrase, long enough"
	bobSays  = "bob's passphrase, long enough"
	cleoSays = "cleo's passphrase, long enough"
	andySays = "andy's passphrase, long enough"
)

func ownFleet(t *testing.T) (http.Handler, *store.Store, *App) {
	t.Helper()

	mux, st, app := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "theirs", URL: "wss://theirs.example.invalid", Turn: "theirs.example.invalid:39218", Forwards: true},
		store.Relay{Name: "public", URL: "wss://public.example.invalid", Turn: "public.example.invalid:39218", Forwards: true},
		store.Relay{Name: "bobs", URL: "wss://bobs.example.invalid", Turn: "bobs.example.invalid:39218", Forwards: true},
		store.Relay{Name: "kept", URL: "wss://kept.example.invalid", AdminOnly: true},
	)

	for _, account := range []store.Account{
		{Name: "ada", Trip: room.Trip(tripKey, adaSays), Relays: []string{"theirs"}},
		{Name: "bob", Trip: room.Trip(tripKey, bobSays), Relays: []string{"bobs"}},
		{Name: "cleo", Trip: room.Trip(tripKey, cleoSays)},
	} {
		if err := st.AddAccount(account); err != nil {
			t.Fatalf("AddAccount %s: %v", account.Name, err)
		}
	}

	if err := st.AddAdmin(store.Admin{Trip: room.Trip(tripKey, andySays), Name: "andy", Can: []string{"moderate"}}); err != nil {
		t.Fatal(err)
	}

	return mux, st, app
}

// place puts a meeting on a relay as the management pages do, which needs the
// name to have been used: a placement is of a room, and a name nobody has said
// is not one yet.
func place(t *testing.T, st *store.Store, name, relay string) {
	t.Helper()

	if _, err := st.OpenRoom(name, true); err != nil {
		t.Fatal(err)
	}

	if err := st.PlaceRoom(name, relay); err != nil {
		t.Fatal(err)
	}

	if held, placed := st.HeldOn(name); held != relay || !placed {
		t.Fatalf("%s is held on %q (placed %v), want placed on %s", name, held, placed, relay)
	}
}

// session signs somebody in at the front and returns the cookie, which is
// what the apps hold.
func ownSession(t *testing.T, mux http.Handler, name, said string) *http.Cookie {
	t.Helper()

	request := httptest.NewRequest(http.MethodPost, "/api/account/session",
		strings.NewReader(`{"name":"`+name+`","passphrase":"`+said+`"}`))
	request.Header.Set("Content-Type", "application/json")

	recorder := ask(mux, request)
	if recorder.Code != http.StatusOK || len(recorder.Result().Cookies()) == 0 {
		t.Fatalf("signing in as %s answered %d: %s", name, recorder.Code, recorder.Body)
	}

	return recorder.Result().Cookies()[0]
}

func listedFor(t *testing.T, mux http.Handler, cookie *http.Cookie) []string {
	t.Helper()

	request := httptest.NewRequest(http.MethodGet, "/api/relays", nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}

	recorder := ask(mux, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("/api/relays answered %d", recorder.Code)
	}

	var body relayListResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	var out []string
	for _, relay := range body.Relays {
		out = append(out, relay.Name)
	}
	sort.Strings(out)

	return out
}

type ownJoin struct {
	code    int
	reason  string
	relay   string
	forward bool
}

func joinOwn(t *testing.T, mux http.Handler, roomName, said, relay string, cookie *http.Cookie) ownJoin {
	t.Helper()

	body := `{"name":"somebody","relay":"` + relay + `"`
	if said != "" {
		body += `,"passphrase":"` + said + `"`
	}
	body += `}`

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/"+roomName+"/join", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Host = "meet.example.com"
	if cookie != nil {
		request.AddCookie(cookie)
	}

	recorder := ask(mux, request)

	var answer struct {
		Error   string          `json:"error"`
		Relay   string          `json:"relay"`
		Forward json.RawMessage `json:"forward"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &answer)

	return ownJoin{
		code: recorder.Code, reason: answer.Error, relay: answer.Relay,
		forward: len(answer.Forward) > 0 && string(answer.Forward) != "null",
	}
}

func TestSomebodyIsShownTheirOwnRelaysAndNobodyElseIsShownThem(t *testing.T) {
	mux, _, _ := ownFleet(t)

	for _, tc := range []struct {
		who    string
		cookie *http.Cookie
		want   string
	}{
		{"a stranger", nil, "public"},
		{"cleo, who has none", ownSession(t, mux, "cleo", cleoSays), "public"},
		{"ada, who has one", ownSession(t, mux, "ada", adaSays), "theirs"},
		{"bob, who has another", ownSession(t, mux, "bob", bobSays), "bobs"},
		// Signed in at the front, as the apps carry an administrator: shown
		// everything, the relay kept for administrators among it.
		{"andy, an administrator in an app", ownSession(t, mux, "andy", andySays), "bobs kept public theirs"},
	} {
		if got := strings.Join(listedFor(t, mux, tc.cookie), " "); got != tc.want {
			t.Errorf("%s was shown [%s], want [%s]", tc.who, got, tc.want)
		}
	}
}

func TestSomebodyWithRelaysOfTheirOwnComesInThroughThem(t *testing.T) {
	mux, _, _ := ownFleet(t)

	// By passphrase, from a page that was not signed in and so was shown the
	// ordinary list and measured public as fastest: the choice is set aside,
	// not refused, and their own relay is used.
	if got := joinOwn(t, mux, "standup", adaSays, "public", nil); got.code != http.StatusOK || got.relay != "theirs" {
		t.Errorf("ada by passphrase asking for public: %d %q on %q, want 200 on theirs", got.code, got.reason, got.relay)
	}

	// By session, asking nothing, as an app does when it has measured nothing.
	ada := ownSession(t, mux, "ada", adaSays)
	for _, name := range []string{"retro", "one-to-one", "all-hands", "planning"} {
		if got := joinOwn(t, mux, name, "", "", ada); got.relay != "theirs" {
			t.Errorf("ada signed in, room %s: landed on %q (%d %q), want theirs", name, got.relay, got.code, got.reason)
		}
	}
}

func TestSomebodysOwnRelayIsRefusedToEverybodyElse(t *testing.T) {
	mux, _, _ := ownFleet(t)

	for i, tc := range []struct {
		who  string
		said string
	}{
		{"a stranger", ""},
		{"cleo", cleoSays},
		{"bob, who has a relay of his own", bobSays},
	} {
		got := joinOwn(t, mux, "standup-"+string(rune('a'+i)), tc.said, "theirs", nil)
		if tc.said == bobSays {
			// Bob asking for ada's relay is somebody with his own asking for
			// one that is not: set aside, and sent through his own.
			if got.relay != "bobs" {
				t.Errorf("bob asking for ada's relay landed on %q (%d %q), want bobs", got.relay, got.code, got.reason)
			}
			continue
		}

		if got.code != http.StatusForbidden || got.reason != reasonRelayNotAllowed {
			t.Errorf("%s asking for ada's relay by name: %d %q on %q, want 403 %s",
				tc.who, got.code, got.reason, got.relay, reasonRelayNotAllowed)
		}
	}

	// And nobody else is sent there without asking, whatever the room.
	for _, name := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"} {
		if got := joinOwn(t, mux, "room-"+name, cleoSays, "", nil); got.relay == "theirs" || got.relay == "bobs" {
			t.Errorf("cleo was sent to %q, which is somebody's own", got.relay)
		}
	}

	// An administrator may use it.
	if got := joinOwn(t, mux, "andys", andySays, "theirs", nil); got.code != http.StatusOK || got.relay != "theirs" {
		t.Errorf("an administrator asking for ada's relay: %d %q on %q, want 200 on theirs", got.code, got.reason, got.relay)
	}
}

// When none of their own can take the call they cannot join, and the name they
// asked for is not written down as used by a join that did not happen.
func TestSomebodyWhoseOwnRelaysAreDownCannotJoin(t *testing.T) {
	mux, st, app := ownFleet(t)

	app.reach = newReach(fixed(map[string]bool{
		"wss://public.example.invalid": true, "wss://bobs.example.invalid": true, "wss://kept.example.invalid": true,
	}))
	app.relays.reach = app.reach
	for range withdrawAfter {
		app.reach.look(context.Background(), app.relays.watched())
	}

	got := joinOwn(t, mux, "while-down", adaSays, "", nil)
	if got.code != http.StatusServiceUnavailable || got.reason != reasonOwnRelayDown {
		t.Errorf("ada with her relay down: %d %q on %q, want 503 %s: sent anywhere else, her "+
			"calls go through a machine she did not choose", got.code, got.reason, got.relay, reasonOwnRelayDown)
	}

	if st.Used("while-down") {
		t.Error("a join refused because nothing could carry it wrote the room down as used")
	}

	if got := listedFor(t, mux, ownSession(t, mux, "ada", adaSays)); len(got) != 0 {
		t.Errorf("ada was shown %v with her own relay down, want nothing: the others are not hers", got)
	}

	// Out of service is the same answer.
	app.reach = nil
	app.relays.reach = nil

	relays, _ := st.Relays()
	for _, relay := range relays {
		if relay.Name == "theirs" {
			relay.Enabled = false
			if err := st.UpdateRelay(relay); err != nil {
				t.Fatal(err)
			}
		}
	}
	app.relays.forget()

	if got := joinOwn(t, mux, "while-off", adaSays, "", nil); got.code != http.StatusServiceUnavailable {
		t.Errorf("ada with her relay out of service: %d %q on %q, want 503", got.code, got.reason, got.relay)
	}
}

// Their relay decides the door, not the meetings behind it.
func TestSomebodyReachesAMeetingHeldElsewhereThroughTheirOwn(t *testing.T) {
	mux, st, app := ownFleet(t)

	place(t, st, "standup", "public")

	got := joinOwn(t, mux, "standup", adaSays, "", nil)
	if got.code != http.StatusOK || got.relay != "theirs" || !got.forward {
		t.Fatalf("ada into a meeting held on public: %d %q on %q forwarded=%v, want 200 through "+
			"theirs, forwarded", got.code, got.reason, got.relay, got.forward)
	}

	// Through a relay that does not forward there is no way in but the holder's
	// own door, which is not hers.
	relays, _ := st.Relays()
	for _, relay := range relays {
		if relay.Name == "theirs" {
			relay.Forwards = false
			if err := st.UpdateRelay(relay); err != nil {
				t.Fatal(err)
			}
		}
	}
	app.relays.forget()

	if got := joinOwn(t, mux, "standup", adaSays, "", nil); got.code != http.StatusServiceUnavailable {
		t.Errorf("ada through a relay that does not forward, into a meeting elsewhere: %d %q on %q, "+
			"want 503 rather than being sent straight to public", got.code, got.reason, got.relay)
	}
}

// A meeting held on somebody's own relay is open to the people invited to it,
// as one on a relay kept for administrators is.
func TestAMeetingOnSomebodysOwnRelayLetsTheInvitedIn(t *testing.T) {
	mux, st, _ := ownFleet(t)

	place(t, st, "adas-call", "theirs")

	if got := joinOwn(t, mux, "adas-call", "", "", nil); got.code != http.StatusOK {
		t.Errorf("a stranger with the link into ada's meeting: %d %q", got.code, got.reason)
	}

	if got := joinOwn(t, mux, "adas-call", cleoSays, "theirs", nil); got.code != http.StatusOK {
		t.Errorf("cleo asking for the relay her meeting is on: %d %q, want 200", got.code, got.reason)
	}
}

// Moving or arranging a meeting onto somebody else's relay is refused; onto
// one's own, or by an administrator, it is not.
func TestOnlyItsHolderMayPutAMeetingOnSomebodysOwnRelay(t *testing.T) {
	_, st, app := ownFleet(t)

	relays, _ := st.Relays()
	var theirs, public store.Relay
	for _, relay := range relays {
		switch relay.Name {
		case "theirs":
			theirs = relay
		case "public":
			public = relay
		}
	}

	request := httptest.NewRequest(http.MethodPost, "/", nil)
	mark := func(said string) room.Signature {
		return room.Signature{Trip: room.Trip(tripKey, said), Proven: true}
	}

	if app.mayHoldOn(request, mark(cleoSays), theirs) {
		t.Error("cleo may put a meeting on ada's relay")
	}

	if !app.mayHoldOn(request, mark(adaSays), theirs) {
		t.Error("ada may not put a meeting on her own relay")
	}

	if !app.mayHoldOn(request, mark(adaSays), public) {
		t.Error("ada may not hold a meeting on an ordinary relay, which she reaches through her own")
	}
}
