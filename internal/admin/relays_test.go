package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
What these guard is the difference between asking one machine and asking all of
them, which nothing else can see.

The management page draws a row per relay and every row carries whether that
machine answered. Both readings are true, both are drawn the same way, and a
button that measured the whole fleet instead of its own row looked exactly like
one that did not — until a fleet grew to eleven, one of them went down, and
every press on any row sat for the three seconds that machine's timeout takes.

A wrong answer would have been noticed. Extra work that produces the right
answer is what this counts, because counting is the only way to see it.
*/

// listed is a relay list that answers from memory.
type listed struct {
	relays []store.Relay
	err    error
}

func (l *listed) Relays() ([]store.Relay, error) {
	if l.err != nil {
		return nil, l.err
	}

	return l.relays, nil
}

func (l *listed) AddRelay(store.Relay) error    { return errors.New("not for these tests") }
func (l *listed) UpdateRelay(store.Relay) error { return errors.New("not for these tests") }
func (l *listed) RemoveRelay(string) error      { return errors.New("not for these tests") }
func (l *listed) RenameRelay(string, string) error {
	return errors.New("not for these tests")
}

func (l *listed) ReorderRelays(names []string) error {
	ordered := make([]store.Relay, 0, len(l.relays))

	for _, name := range names {
		for _, relay := range l.relays {
			if relay.Name == name {
				ordered = append(ordered, relay)
			}
		}
	}

	if len(ordered) != len(l.relays) {
		return errors.New("that is not this list in another order")
	}

	l.relays = ordered

	return nil
}

// dialled records every address it was asked about.
//
// Under a mutex because the list endpoint checks its relays in parallel, which
// is the whole reason it is bearable on a fleet at all.
type dialled struct {
	mu    sync.Mutex
	asked []string
}

func (d *dialled) Check(_ context.Context, url string) (bool, time.Duration, string) {
	d.mu.Lock()
	defer d.mu.Unlock()

	d.asked = append(d.asked, url)

	return true, 12 * time.Millisecond, ""
}

func (d *dialled) count() []string {
	d.mu.Lock()
	defer d.mu.Unlock()

	return append([]string(nil), d.asked...)
}

// fleet mounts three relays behind a session that may read them.
func fleetOf(t *testing.T) (*listed, *dialled, http.Handler, string) {
	t.Helper()

	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "watcher"), Name: "watcher"}})

	relays := &listed{relays: []store.Relay{
		{Name: "alpha", URL: "wss://alpha.invalid", Enabled: true},
		{Name: "bravo", URL: "wss://bravo.invalid", Enabled: true},
		{Name: "charlie", URL: "wss://charlie.invalid", Enabled: true},
	}}
	probe := &dialled{}

	api.relays = relays
	api.probe = probe

	_, token, ok := api.sessions.Open("", "watcher")
	if !ok {
		t.Fatal("the configured passphrase was refused")
	}

	return relays, probe, mux, token
}

func ask(t *testing.T, mux http.Handler, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(method, path, nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder
}

// The one that matters: a row's button dials its own machine and no other.
func TestCheckingOneRelayAsksOneRelay(t *testing.T) {
	_, probe, mux, token := fleetOf(t)

	recorder := ask(t, mux, http.MethodGet, "/api/admin/relays/bravo/check", token)
	if recorder.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: %s", recorder.Code, recorder.Body.String())
	}

	asked := probe.count()
	if len(asked) != 1 || asked[0] != "wss://bravo.invalid" {
		t.Fatalf("dialled %v, want only bravo: measuring the fleet to answer for one "+
			"row is the fault this endpoint exists to end", asked)
	}

	var view relayView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatalf("the reply did not parse: %v", err)
	}

	if view.Name != "bravo" || !view.Reachable || view.LatencyMS != 12 {
		t.Errorf("read back %+v, want bravo answering in 12 ms", view)
	}
}

// The counterpart, so that satisfying the test above by having the row's button
// call the list endpoint would fail rather than pass.
func TestDrawingTheListAsksEveryRelay(t *testing.T) {
	_, probe, mux, token := fleetOf(t)

	if recorder := ask(t, mux, http.MethodGet, "/api/admin/relays", token); recorder.Code != http.StatusOK {
		t.Fatalf("the list answered %d, want 200", recorder.Code)
	}

	if asked := probe.count(); len(asked) != 3 {
		t.Errorf("the list dialled %d relays, want all 3: a page whose rows are drawn "+
			"from a stale reading says a machine is up long after it went away", len(asked))
	}
}

func TestCheckingARelayNobodyHasHeardOf(t *testing.T) {
	_, probe, mux, token := fleetOf(t)

	recorder := ask(t, mux, http.MethodGet, "/api/admin/relays/delta/check", token)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("answered %d for a relay that is not listed, want 404", recorder.Code)
	}

	if asked := probe.count(); len(asked) != 0 {
		t.Errorf("dialled %v for a name nothing in the list holds", asked)
	}
}

/*
 * Which relay addresses name something a DNS record can be made for.
 *
 * This decides whether a record is created when a relay is enrolled and removed
 * when it is dropped, so a wrong answer in one direction leaves a record behind
 * pointing at a machine that is gone, and in the other goes looking to make one
 * for something that is not a name.
 *
 * The IPv6 case was wrong. The host was taken by cutting at the first colon or
 * slash, and an IPv6 literal is written in brackets and is full of colons — so
 * "wss://[2001:db8::1]:443" gave "[2001", which net.ParseIP does not recognise,
 * so it was taken for a hostname. No relay in this deployment is dialled that
 * way, which is the only reason it never happened.
 */
func TestWhichAddressesNameAHost(t *testing.T) {
	for _, one := range []struct {
		url  string
		host string
	}{
		// Names, which have records.
		{"wss://hk.relays.example", "hk.relays.example"},
		{"wss://hk.relays.example:443", "hk.relays.example"},
		{"wss://hk.relays.example:39217/rtc", "hk.relays.example"},
		{"https://relay.example", "relay.example"},
		{"hk.relays.example:39217", "hk.relays.example"},

		// Addresses, which have none. Two relays here are dialled this way,
		// because the path filters the name in the handshake.
		{"wss://198.51.100.31", ""},
		{"wss://198.51.100.31:39217", ""},
		{"wss://[2001:db8::1]", ""},
		{"wss://[2001:db8::1]:443", ""},
		{"wss://::1", ""},

		// Nothing at all.
		{"", ""},
		{"wss://", ""},
	} {
		if got := hostOf(one.url); got != one.host {
			t.Errorf("hostOf(%q) = %q, want %q", one.url, got, one.host)
		}
	}
}
