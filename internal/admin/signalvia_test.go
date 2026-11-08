package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
Which relay a media-only relay signals through, set from the management API.

Refused where it could only ever hand clients an address that completes no
call: a relay naming itself, a relay that is not there, or one that itself
signals through another, which the join would not follow. Accepted and
cleared otherwise.
*/
func TestSignallingThroughAnotherRelayIsSetOnlyToOneThatSignals(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "operator"), Name: "olga", Can: []string{config.ManageRelays}}})

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	for _, name := range []string{"hongkong", "guangzhou", "shanghai"} {
		if err := st.AddRelay(store.Relay{Name: name, URL: "wss://" + name + ".invalid", Enabled: true, Probe: name + ".invalid:39218"}); err != nil {
			t.Fatal(err)
		}
	}
	api.relays = st
	cookie := signIn(t, api, "operator")

	via := func(name string) string {
		list, _ := st.Relays()
		for _, relay := range list {
			if relay.Name == name {
				return relay.SignalVia
			}
		}
		return "?"
	}

	for _, c := range []struct {
		relay, body string
		code        int
		reason      string
	}{
		{"guangzhou", `{"signalVia":"guangzhou"}`, http.StatusBadRequest, "signal_via_itself"},
		{"guangzhou", `{"signalVia":"atlantis"}`, http.StatusBadRequest, "signal_via_unknown"},
		{"guangzhou", `{"signalVia":"hongkong"}`, http.StatusOK, ""},
		{"shanghai", `{"signalVia":"guangzhou"}`, http.StatusBadRequest, "signal_via_chained"},
	} {
		got := call(mux, http.MethodPatch, "/api/admin/relays/"+c.relay, cookie, c.body)
		if got.Code != c.code || (c.reason != "" && reason(got) != c.reason) {
			t.Errorf("%s %s answered %d %q, want %d %q", c.relay, c.body, got.Code, reason(got), c.code, c.reason)
		}
	}

	if got := via("guangzhou"); got != "hongkong" {
		t.Errorf("guangzhou signals through %q, want hongkong", got)
	}
	// And said back to the page that edits it, which otherwise shows the
	// field empty and saves it empty with whatever else is changed.
	if listed := call(mux, http.MethodGet, "/api/admin/relays", cookie, ""); !strings.Contains(listed.Body.String(), `"signalVia":"hongkong"`) {
		t.Errorf("the relay list does not say guangzhou signals through hongkong: %s", listed.Body.String())
	}

	if got := via("shanghai"); got != "" {
		t.Errorf("a refused chain was written: shanghai signals through %q", got)
	}

	if got := call(mux, http.MethodPatch, "/api/admin/relays/guangzhou", cookie, `{"signalVia":""}`); got.Code != http.StatusOK || via("guangzhou") != "" {
		t.Errorf("clearing answered %d and left %q", got.Code, via("guangzhou"))
	}
}

// The relays that signal through one follow it when it is renamed from the
// page, and removing it while they still do is refused with a code the page can
// say. And a relay left naming one that is gone — which a rename or a removal
// used to leave behind — can still have its other settings saved, though the
// page sends the stale name back with every save.
func TestARelaySignalledThroughIsRenamedAndRemovedWithTheRelaysThatNameIt(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "operator"), Name: "olga", Can: []string{config.ManageRelays}}})

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	for _, relay := range []store.Relay{
		{Name: "hongkong", URL: "wss://hongkong.invalid", Enabled: true},
		{Name: "guangzhou", URL: "wss://guangzhou.invalid", Enabled: true, SignalVia: "hongkong", Probe: "guangzhou.invalid:39218"},
		{Name: "wuhan", URL: "wss://wuhan.invalid", Enabled: true, SignalVia: "atlantis", Probe: "wuhan.invalid:39218"},
	} {
		if err := st.AddRelay(relay); err != nil {
			t.Fatal(err)
		}
	}
	api.relays = st
	cookie := signIn(t, api, "operator")

	named := func(name string) (store.Relay, bool) {
		list, _ := st.Relays()
		for _, relay := range list {
			if relay.Name == name {
				return relay, true
			}
		}
		return store.Relay{}, false
	}

	if got := call(mux, http.MethodPatch, "/api/admin/relays/hongkong", cookie, `{"name":"HK Main"}`); got.Code != http.StatusOK {
		t.Fatalf("renaming answered %d %q", got.Code, reason(got))
	}
	if gz, _ := named("guangzhou"); gz.SignalVia != "HK Main" {
		t.Errorf("after the rename guangzhou signals through %q, want HK Main", gz.SignalVia)
	}

	got := call(mux, http.MethodDelete, "/api/admin/relays/HK%20Main", cookie, "")
	if got.Code != http.StatusConflict || reason(got) != "relay_signalled_through" {
		t.Errorf("removing a relay guangzhou signals through answered %d %q, want 409 relay_signalled_through", got.Code, reason(got))
	}
	if _, still := named("HK Main"); !still {
		t.Error("the refused removal removed the relay")
	}

	// The page's save of wuhan, which names a relay that is gone, changing
	// only the label.
	if got := call(mux, http.MethodPatch, "/api/admin/relays/wuhan", cookie, `{"label":"Wuhan","signalVia":"atlantis"}`); got.Code != http.StatusOK {
		t.Errorf("saving wuhan's label with its setting unchanged answered %d %q", got.Code, reason(got))
	}
	if wh, _ := named("wuhan"); wh.Label != "Wuhan" {
		t.Errorf("wuhan's label is %q after the save", wh.Label)
	}
	// While a change to a relay that is not there is still refused.
	if got := call(mux, http.MethodPatch, "/api/admin/relays/wuhan", cookie, `{"signalVia":"lemuria"}`); reason(got) != "signal_via_unknown" {
		t.Errorf("a change to a relay that does not exist answered %d %q", got.Code, reason(got))
	}
}

// reason reads the code a refusal says.
func reason(recorder *httptest.ResponseRecorder) string {
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return body.Error
}

// A relay that signals through another is one no TLS reaches, and a client
// measures a relay with no probe address by opening TLS to it. So the one may
// not be set without the other, and taking the probe away afterwards is
// refused too.
func TestARelayThatSignalsThroughAnotherNeedsAProbe(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "operator"), Name: "olga", Can: []string{config.ManageRelays}}})

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	for _, relay := range []store.Relay{
		{Name: "hongkong", URL: "wss://hongkong.invalid", Enabled: true},
		{Name: "guangzhou", URL: "wss://guangzhou.invalid", Enabled: true},
	} {
		if err := st.AddRelay(relay); err != nil {
			t.Fatal(err)
		}
	}
	api.relays = st
	cookie := signIn(t, api, "operator")

	if got := call(mux, http.MethodPatch, "/api/admin/relays/guangzhou", cookie, `{"signalVia":"hongkong"}`); reason(got) != "relay_needs_probe" {
		t.Errorf("signalling through another without a probe answered %d %q, want relay_needs_probe", got.Code, reason(got))
	}

	if got := call(mux, http.MethodPatch, "/api/admin/relays/guangzhou", cookie, `{"signalVia":"hongkong","probe":"guangzhou.invalid:39218"}`); got.Code != http.StatusOK {
		t.Fatalf("signalling through another with a probe answered %d %q", got.Code, reason(got))
	}

	if got := call(mux, http.MethodPatch, "/api/admin/relays/guangzhou", cookie, `{"probe":""}`); reason(got) != "relay_needs_probe" {
		t.Errorf("taking the probe away answered %d %q, want relay_needs_probe", got.Code, reason(got))
	}
}

// A relay that carries media only, with nothing answering to carry its
// signalling, is offered to nobody; the page says why on its row, because
// otherwise the only sign is that nobody lands there.
func TestTheRelaysPageSaysWhyAStrandedRelayIsOfferedToNobody(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "operator"), Name: "olga", Can: []string{config.ManageRelays}}})

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	for _, relay := range []store.Relay{
		{Name: "hongkong", URL: "wss://hongkong.invalid", Enabled: true},
		{Name: "guangzhou", URL: "wss://guangzhou.invalid", Enabled: true, SignalVia: "hongkong", Probe: "guangzhou.invalid:39218"},
		{Name: "wuhan", URL: "wss://wuhan.invalid", Enabled: false, SignalVia: "hongkong", Probe: "wuhan.invalid:39218"},
	} {
		if err := st.AddRelay(relay); err != nil {
			t.Fatal(err)
		}
	}
	api.relays = st
	api.UseStranded(func(relay store.Relay) bool { return relay.SignalVia != "" })
	cookie := signIn(t, api, "operator")

	var listed struct {
		Relays []relayView `json:"relays"`
	}
	if err := json.Unmarshal(call(mux, http.MethodGet, "/api/admin/relays", cookie, "").Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}

	for _, relay := range listed.Relays {
		want := ""
		if relay.Name == "guangzhou" {
			want = "no_signalling"
		}

		// Wuhan is out of service already, which the row says by itself.
		if relay.Unavailable != want {
			t.Errorf("%s is shown as unavailable %q, want %q", relay.Name, relay.Unavailable, want)
		}
	}
}
