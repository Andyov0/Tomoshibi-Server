package admin

import (
	"encoding/json"
	"net/http"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
)

/*
The bangumi relay's switch, as the settings page moves it.

It starts on and stands above no grant, so the press that matters is the one
that turns it off — every Bilibili series stopped for everybody at once — and
the gate is who may make it. Beside that, as for the YouTube switch, the one
quiet way it could go wrong is the request: a body naming only the bangumi
switch that also wrote the others, as off because they were not said, would
stop every granted film and every relayed YouTube video as a side effect.
*/

// bangumiSpent is a relay that has carried a fixed amount of bangumi and
// nothing else.
type bangumiSpent uint64

func (s bangumiSpent) EmbySpent() map[string]uint64 { return nil }
func (s bangumiSpent) YouTubeSpent() uint64         { return 0 }
func (s bangumiSpent) BangumiSpent() uint64         { return uint64(s) }
func (s bangumiSpent) MoveSpent(string, string)     {}

func TestOnlyTheSettingsCapabilityTurnsTheBangumiRelayOff(t *testing.T) {
	api, mux, written := mountAudited(t, []config.Admin{
		{Trip: room.Trip(key, "watcher"), Name: "wes"},
		{Trip: room.Trip(key, "clerk"), Name: "cara", Can: []string{config.ManageAccounts}},
		{Trip: room.Trip(key, "keeper"), Name: "kit", Can: []string{config.ManageSettings}},
	})

	// As a store that nobody has touched says it: on.
	board := &switchboard{on: true, tube: true, bangumi: true}
	api.settings = board
	api.conf.Meet.Watch = config.Watch{URL: "http://gateway.invalid", DirectOnly: true}
	api.UseSpent(bangumiSpent(7 << 20))

	for _, who := range []string{"watcher", "clerk"} {
		got := call(mux, http.MethodPut, "/api/admin/settings", signIn(t, api, who), `{"bangumiRelay":false}`)

		if got.Code != http.StatusForbidden {
			t.Errorf("%s turned the bangumi relay off: %d", who, got.Code)
		}
	}

	if !board.BangumiRelay() {
		t.Fatal("the bangumi relay was turned off by somebody refused")
	}

	keeper := signIn(t, api, "keeper")

	if got := call(mux, http.MethodPut, "/api/admin/settings", keeper, `{"bangumiRelay":false}`); got.Code != http.StatusOK {
		t.Fatalf("turning the bangumi relay off answered %d", got.Code)
	}

	if board.BangumiRelay() {
		t.Fatal("the bangumi relay was not turned off")
	}

	if !board.EmbyRelay() || !board.YouTubeRelay() {
		t.Error("turning the bangumi relay off turned another relay off")
	}

	found := false
	for _, entry := range written.recorded() {
		if entry.Action == "set the bangumi relay" && entry.Target == "off" && !entry.Failed {
			found = entry.Trip == room.Trip(key, "keeper")
		}

		if entry.Action == "set the media server relay" || entry.Action == "set the YouTube relay" {
			t.Errorf("turning the bangumi relay off was recorded as setting another relay too: %+v", entry)
		}
	}
	if !found {
		t.Error("turning the bangumi relay off left no record of who did")
	}

	// And the other way: another switch alone leaves this one where it is.
	if got := call(mux, http.MethodPut, "/api/admin/settings", keeper, `{"bangumiRelay":true}`); got.Code != http.StatusOK {
		t.Fatalf("turning the bangumi relay back on answered %d", got.Code)
	}

	if got := call(mux, http.MethodPut, "/api/admin/settings", keeper, `{"youtubeRelay":false}`); got.Code != http.StatusOK {
		t.Fatalf("turning the YouTube relay off answered %d", got.Code)
	}

	if !board.BangumiRelay() {
		t.Error("turning the YouTube relay off turned the bangumi relay off")
	}

	// Anybody may read it, with what it has cost, and the runtime panel says
	// the same.
	watcher := signIn(t, api, "watcher")

	var read watching
	_ = json.Unmarshal(call(mux, http.MethodGet, "/api/admin/settings", watcher, "").Body.Bytes(), &read)

	want := watching{Configured: true, DirectOnly: true, EmbyRelay: true, BangumiRelay: true, BangumiSpent: 7 << 20}
	if read != want {
		t.Errorf("the settings read back as %+v, want %+v", read, want)
	}

	var runtime struct {
		Meet struct {
			Watch watching `json:"watch"`
		} `json:"meet"`
	}
	_ = json.Unmarshal(call(mux, http.MethodGet, "/api/admin/runtime", watcher, "").Body.Bytes(), &runtime)

	if runtime.Meet.Watch != read {
		t.Errorf("the runtime panel says %+v about watching", runtime.Meet.Watch)
	}
}
