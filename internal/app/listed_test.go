package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
What /api/relays tells somebody who has signed in to nothing.

One request used to list the whole fleet by name — the reserved machines, and
every probe address as it was typed, which is a name under the relay domain —
and the address of a relay that signals through another, which is where a
browser then opened TLS to measure it. These hold that a stranger gets the
relays anybody may use, probes as addresses, and that nobody at all is handed
the address of a relay no TLS is meant to reach.
*/

func strangerList(t *testing.T, mux http.Handler, cookie *http.Cookie) map[string]relayEntry {
	t.Helper()

	request := httptest.NewRequest(http.MethodGet, "/api/relays", nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}

	var body relayListResponse
	if err := json.Unmarshal(ask(mux, request).Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	out := map[string]relayEntry{}
	for _, relay := range body.Relays {
		out[relay.Name] = relay
	}

	return out
}

func TestAStrangerIsToldOnlyWhatMeasuringNeeds(t *testing.T) {
	relays := []store.Relay{
		{Name: "tokyo", URL: "wss://tokyo.relay.example.invalid:13377", Probe: "tokyo.relay.example.invalid:39218"},
		{Name: "lab", URL: "wss://lab.relay.example.invalid:13377", Probe: "198.51.100.40:39218", AdminOnly: true},
		{Name: "gz", URL: "wss://gz.relay.example.invalid:13377", Probe: "gz.relay.example.invalid:39218", SignalVia: "tokyo"},
		{Name: "sg", URL: "wss://sg.relay.example.invalid:13377"},
		{Name: "sh", URL: "wss://sh.relay.example.invalid:13377", Probe: "sh.relay.example.invalid:39218"},
	}

	// Built with an administrator on the roster, so the management side, and
	// with it the session that says who is asking, is mounted at all.
	st, err := storeWithAdmin(t)
	if err != nil {
		t.Fatal(err)
	}

	mux, app := controlOn(t, st, relays...)
	app.probes.lookup = func(_ context.Context, host string) ([]netip.Addr, error) {
		if host == "tokyo.relay.example.invalid" {
			return []netip.Addr{netip.MustParseAddr("198.51.100.10")}, nil
		}
		// What the control node itself resolves a relay it reaches through a
		// local forwarder to: its own loopback, from an /etc/hosts line.
		if host == "sh.relay.example.invalid" {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		}
		return nil, errors.New("no such host")
	}

	stranger := strangerList(t, mux, nil)

	if _, shown := stranger["lab"]; shown {
		t.Error("a relay kept for administrators was listed to a stranger")
	}

	if got := stranger["tokyo"].Probe; got != "198.51.100.10:39218" {
		t.Errorf("a stranger was given tokyo's probe as %q, want its address", got)
	}

	if got := stranger["sh"].Probe; got != "sh.relay.example.invalid:39218" {
		t.Errorf("a probe the control node resolves to loopback was given out as %q, want the name for the browser to resolve", got)
	}

	if got := stranger["gz"].Probe; got != "" {
		t.Errorf("a probe whose name does not resolve was given out as %q", got)
	}

	if got := stranger["gz"].URL; got != "" {
		t.Errorf("a stranger was given the address of a relay that signals through another: %s", got)
	}

	// The one with no probe is still measurable the only way left.
	if got := stranger["sg"].URL; got == "" {
		t.Error("a relay with no probe was given no address, so nothing can measure it")
	}

	// An administrator sees the whole list as it was written — except the
	// address of the relay no TLS is meant to reach, which nobody is given.
	cookie := adminCookie(t, st)
	operator := strangerList(t, mux, cookie)

	if _, shown := operator["lab"]; !shown {
		t.Error("an administrator was not shown the relay kept for administrators")
	}

	if got := operator["tokyo"].Probe; got != "tokyo.relay.example.invalid:39218" {
		t.Errorf("an administrator was given tokyo's probe as %q", got)
	}

	if got := operator["gz"].URL; got != "" {
		t.Errorf("an administrator's browser was given the address of a relay no TLS reaches, and would open TLS to it: %s", got)
	}
}

const operatorPassphrase = "an operator's passphrase"

func storeWithAdmin(t *testing.T) (*store.Store, error) {
	t.Helper()

	st, err := store.Open(t.TempDir() + "/meet.db")
	if err != nil {
		return nil, err
	}
	t.Cleanup(func() { st.Close() })

	return st, st.AddAdmin(store.Admin{
		Trip: room.Trip(tripKey, operatorPassphrase), Name: "olga", Can: []string{config.Moderate},
	})
}

func adminCookie(t *testing.T, st *store.Store) *http.Cookie {
	t.Helper()

	now := time.Now().UTC()
	if err := st.KeepSession("operator-session", store.Session{
		Trip: room.Trip(tripKey, operatorPassphrase), Name: "olga", Can: []string{config.Moderate},
		Kind: "admin", Opened: now, Expires: now.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	return &http.Cookie{Name: "meet-live.admin", Value: "operator-session"}
}
