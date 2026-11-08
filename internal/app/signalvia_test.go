package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
 * A relay that no TLS handshake reaches carries the media and nothing else.
 *
 * The mainland providers intercept TLS to a machine without an ICP filing, by
 * name or by bare IP, while UDP and other TCP pass. So a relay that names one
 * to signal through is never the address a client opens a socket to; the
 * room is still held on it, so the media goes there; and a call held
 * elsewhere still forwards through its TURN, which is UDP. The failures this
 * guards are silent ones: a client handed the media relay's address anyway is
 * a call the network resets, and a room left to be created by the machine
 * that received the signalling is a call held across the border from where
 * everybody chose.
 */

// through makes a relay signal through another, with the probe address such a
// relay is required to have (store.Relay.Valid).
func through(relay store.Relay, via string) store.Relay {
	relay.SignalVia = via
	if relay.Probe == "" {
		relay.Probe = relay.Name + ".example.invalid:39218"
	}
	return relay
}

func mediaOnly(t *testing.T, list ...store.Relay) (http.Handler, *pinning, *store.Store) {
	t.Helper()

	mux, st, app := controlWithStore(t, config.PickProbe, list...)

	pins := &pinning{}
	fleet := &fleetSaying{nodes: map[string]string{}}
	for _, relay := range list {
		fleet.nodes[relay.URL] = "ND_" + relay.Name
	}

	app.control = pins
	app.fleet = fleet

	return mux, pins, st
}

func TestAMediaOnlyRelaySignalsThroughTheOneItNamesAndHoldsTheRoom(t *testing.T) {
	mux, pins, _ := mediaOnly(t,
		through(forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"), "hongkong"),
		forwarder("hongkong", "wss://hk.example.invalid", "hk.example.invalid:39219"),
	)

	answer := joinVia(t, mux, "standup", "guangzhou")

	if answer.URL != "wss://hk.example.invalid" {
		t.Errorf("signalling sent to %q; a relay no TLS reaches must never be the address opened", answer.URL)
	}
	if answer.Relay == "" || !strings.Contains(strings.ToLower(answer.Relay), "guangzhou") {
		t.Errorf("the join says the call is on %q; it is on the relay chosen", answer.Relay)
	}
	if answer.Forward != nil {
		t.Errorf("a call held on the relay chosen was told to forward through %q", answer.Forward.URL)
	}
	if held := pins.pinned(); len(held) != 1 || held[0] != "standup on ND_guangzhou" {
		t.Errorf("the room was pinned as %v; left alone it is created where the signalling lands, across the border", held)
	}
}

func TestAMediaOnlyRelayStillForwardsACallHeldElsewhere(t *testing.T) {
	mux, _, st := mediaOnly(t,
		through(forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"), "hongkong"),
		forwarder("hongkong", "wss://hk.example.invalid", "hk.example.invalid:39219"),
		forwarder("tokyo", "wss://jp.example.invalid", "jp.example.invalid:39219"),
	)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}
	if err := st.PlaceRoom("standup", "tokyo"); err != nil {
		t.Fatal(err)
	}

	answer := joinVia(t, mux, "standup", "guangzhou")

	if answer.URL != "wss://hk.example.invalid" {
		t.Errorf("signalling sent to %q, want the relay guangzhou signals through", answer.URL)
	}
	if answer.Forward == nil || !strings.Contains(answer.Forward.URL, "gz.example.invalid") {
		t.Errorf("a call held in tokyo was not forwarded through guangzhou's TURN: %+v", answer.Forward)
	}
}

func TestARelayNamedThatCannotSignalIsPassedOver(t *testing.T) {
	mux, _, _ := mediaOnly(t,
		through(forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"), "atlantis"),
		forwarder("hongkong", "wss://hk.example.invalid", "hk.example.invalid:39219"),
	)

	if answer := joinVia(t, mux, "standup", "guangzhou"); answer.URL != "wss://hk.example.invalid" {
		t.Errorf("signalling sent to %q through a relay that does not exist; want another that signals for itself", answer.URL)
	}
}

func TestARelayThatSignalsThroughOneNotAnsweringUsesTheNearestThatIs(t *testing.T) {
	gz := through(forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"), "hongkong")
	hk := forwarder("hongkong", "wss://hk.example.invalid", "hk.example.invalid:39219")
	reserved := forwarder("internal", "wss://in.example.invalid", "in.example.invalid:39219")
	reserved.AdminOnly = true
	sg := forwarder("singapore", "wss://sg.example.invalid", "sg.example.invalid:39219")
	hk2 := forwarder("tsuenwan", "wss://tw.example.invalid", "tw.example.invalid:39219")
	// Another that carries media only, there so that at least half the fleet
	// answers: a sweep in which most of it does not is read as this machine's
	// own outage and changes nothing (reach.look).
	wh := through(forwarder("wuhan", "wss://wh.example.invalid", "wh.example.invalid:39219"), "hongkong")
	list := []store.Relay{gz, hk, reserved, sg, hk2, wh}

	// Up or not, and how long each takes to answer the control node.
	settle := func(app *App, took map[string]time.Duration) {
		app.relays.reach = newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
			if d, ok := took[url]; ok {
				return true, d, ""
			}
			return false, 0, "refused"
		})
		for i := 0; i < withdrawAfter; i++ {
			app.relays.reach.look(context.Background(), list)
		}
	}

	mux, _, app := controlWithStore(t, config.PickProbe, list...)

	// Hong Kong is down. Singapore comes first, by name and by order added, and
	// the other Hong Kong machine answers sooner; the reserved one sooner
	// still, and is not for everybody.
	settle(app, map[string]time.Duration{
		gz.URL: 40 * time.Millisecond, reserved.URL: time.Millisecond,
		sg.URL: 35 * time.Millisecond, hk2.URL: 3 * time.Millisecond,
		wh.URL: 30 * time.Millisecond,
	})
	if answer := joinVia(t, mux, "standup", "guangzhou"); answer.URL != hk2.URL {
		t.Errorf("with hongkong not answering, signalling went to %q; want tsuenwan, "+
			"the nearest that answers and is not reserved", answer.URL)
	}

	// Nothing that signals for itself answers, except the one kept for
	// administrators. Guangzhou is then stranded, and so is Wuhan: neither is
	// chosen, and the join goes to a relay that signals for itself even
	// though this node cannot reach it — never to a mainland machine's own
	// address, which used to be the answer here.
	settle(app, map[string]time.Duration{
		gz.URL: 40 * time.Millisecond, reserved.URL: time.Millisecond, wh.URL: 30 * time.Millisecond,
	})
	answer := joinVia(t, mux, "standup", "guangzhou")
	if answer.URL == gz.URL || answer.URL == wh.URL || answer.URL == reserved.URL || answer.URL == "" {
		t.Errorf("with nothing to signal through, signalling went to %q; a client must never be handed a "+
			"mainland machine's own address, and not the reserved relay either", answer.URL)
	}
	if strings.Contains(strings.ToLower(answer.Relay), "guangzhou") || strings.Contains(strings.ToLower(answer.Relay), "wuhan") {
		t.Errorf("the join chose %q, a relay nothing can carry the signalling of", answer.Relay)
	}
}

/*
A meeting held on a mainland relay that nothing can carry the signalling of.

The room is placed on Guangzhou, the relay that signals for it is not
answering, and the one other relay cannot forward to it — so the only way into
the meeting would be to signal to Guangzhou itself. The join used to answer
with Guangzhou's own address; now it is refused with a code that says why, and
the address is nowhere in the answer. (Where the other relay can forward, the
join goes through it and is not refused: the client signals there and its
media is carried to Guangzhou over UDP.)
*/
func TestAJoinThatWouldNeedAStrandedRelayIsRefused(t *testing.T) {
	gz := through(forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"), "hongkong")
	hk := store.Relay{Name: "hongkong", URL: "wss://hk.example.invalid", Region: "CN-East"}

	mux, st, app := controlWithStore(t, config.PickProbe, gz, hk)

	app.relays.reach = newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		if url == gz.URL {
			return true, 10 * time.Millisecond, ""
		}
		return false, 0, "refused"
	})
	for i := 0; i < withdrawAfter; i++ {
		app.relays.reach.look(context.Background(), []store.Relay{gz, hk})
	}

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}
	if err := st.PlaceRoom("standup", "guangzhou"); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
		strings.NewReader(`{"name":"somebody","relay":"guangzhou"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := ask(mux, request)

	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "no_signalling") {
		t.Errorf("a join into a meeting held on a stranded relay answered %d %s; want 503 no_signalling",
			recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "gz.example.invalid") {
		t.Error("the refusal carried the mainland relay's address")
	}

	// And the relay is greyed in the list everybody measures from, so nothing
	// offers it as a choice.
	var listed relayListResponse
	_ = json.Unmarshal(ask(mux, httptest.NewRequest(http.MethodGet, "/api/relays", nil)).Body.Bytes(), &listed)
	for _, relay := range listed.Relays {
		if relay.Name == "guangzhou" && !relay.Maintenance {
			t.Error("a stranded relay is offered to clients as a choice")
		}
		if relay.Name == "guangzhou" && relay.URL != "" {
			t.Errorf("a stranded relay's address is in the list: %s", relay.URL)
		}
	}

	// Hong Kong back, the same join goes through it.
	app.relays.reach = newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		return true, 10 * time.Millisecond, ""
	})
	app.relays.reach.look(context.Background(), []store.Relay{gz, hk})

	if answer := joinVia(t, mux, "standup", "guangzhou"); answer.URL != hk.URL {
		t.Errorf("with hongkong answering again, signalling went to %q", answer.URL)
	}
}

// With nothing anybody may use left, the join is refused rather than handed
// this node's own address, which holds no media.
func TestAFleetOfStrandedRelaysRefusesTheJoin(t *testing.T) {
	gz := through(forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"), "hongkong")
	hk := forwarder("hongkong", "wss://hk.example.invalid", "hk.example.invalid:39219")
	hk.AdminOnly = true

	mux, _, app := controlWithStore(t, config.PickProbe, gz, hk)
	app.relays.reach = newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		if url == gz.URL {
			return true, 10 * time.Millisecond, ""
		}
		return false, 0, "refused"
	})
	for i := 0; i < withdrawAfter; i++ {
		app.relays.reach.look(context.Background(), []store.Relay{gz, hk})
	}

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
		strings.NewReader(`{"name":"somebody"}`))
	request.Header.Set("Content-Type", "application/json")

	if recorder := ask(mux, request); recorder.Code != http.StatusServiceUnavailable {
		t.Errorf("with only a stranded relay for anybody, the join answered %d %s; want 503",
			recorder.Code, recorder.Body.String())
	}
}

// Disabling is how an operator is told to take a machine away gently, and the
// usual next step is switching it off. The relays that signal through it go on
// naming it, and signalling asks whether it is answering — so the sweep has to
// keep asking it, or the reading stays at whatever it was the moment it was
// disabled, and every client of guangzhou is handed a socket to a machine that
// is not there.
func TestARelayDisabledAndSwitchedOffIsNotHandedOutToSignalThrough(t *testing.T) {
	gz := through(forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"), "hongkong")
	hk := forwarder("hongkong", "wss://hk.example.invalid", "hk.example.invalid:39219")
	sg := forwarder("singapore", "wss://sg.example.invalid", "sg.example.invalid:39219")
	wh := through(forwarder("wuhan", "wss://wh.example.invalid", "wh.example.invalid:39219"), "hongkong")

	mux, st, app := controlWithStore(t, config.PickProbe, gz, hk, sg, wh)

	var mu sync.Mutex
	off := map[string]bool{}
	app.reach = newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		mu.Lock()
		defer mu.Unlock()
		if off[url] {
			return false, 0, "refused"
		}
		return true, 10 * time.Millisecond, ""
	})
	app.relays.reach = app.reach

	app.lookAround(context.Background())
	if answer := joinVia(t, mux, "standup", "guangzhou"); answer.URL != hk.URL {
		t.Fatalf("with everything answering, signalling went to %q; want hongkong", answer.URL)
	}

	// Taken out of service, then switched off.
	hk.Enabled = false
	if err := st.UpdateRelay(hk); err != nil {
		t.Fatal(err)
	}
	app.relays.forget()
	mu.Lock()
	off[hk.URL] = true
	mu.Unlock()

	for i := 0; i < withdrawAfter+1; i++ {
		app.lookAround(context.Background())
	}

	if answer := joinVia(t, mux, "standup-2", "guangzhou"); answer.URL != sg.URL {
		t.Errorf("with hongkong disabled and not answering, signalling went to %q; want singapore, "+
			"the one other relay that signals for itself and answers", answer.URL)
	}

	// And back: switched on again while still disabled, it is the path again,
	// rather than kept as down from a reading taken before.
	mu.Lock()
	off[hk.URL] = false
	mu.Unlock()
	app.lookAround(context.Background())

	if answer := joinVia(t, mux, "standup-3", "guangzhou"); answer.URL != hk.URL {
		t.Errorf("with hongkong answering again, signalling went to %q; want hongkong, the one named", answer.URL)
	}
}

// A relay out of service that nothing signals through is not asked: a machine
// disabled because it is gone would otherwise be a failed check every half
// minute, and enough of them read as this node's own outage.
func TestOnlyADisabledRelaySomebodySignalsThroughIsWatched(t *testing.T) {
	gz := through(forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"), "hongkong")
	hk := forwarder("hongkong", "wss://hk.example.invalid", "hk.example.invalid:39219")
	gone := forwarder("osaka", "wss://os.example.invalid", "os.example.invalid:39219")

	_, st, app := controlWithStore(t, config.PickProbe, gz, hk, gone)

	for _, relay := range []store.Relay{hk, gone} {
		relay.Enabled = false
		if err := st.UpdateRelay(relay); err != nil {
			t.Fatal(err)
		}
	}
	app.relays.forget()

	var names []string
	for _, relay := range app.relays.watched() {
		names = append(names, relay.Name)
	}
	if got := strings.Join(names, ","); got != "guangzhou,hongkong" {
		t.Errorf("watched %s; want guangzhou and the disabled relay it signals through, and not osaka", got)
	}
}
