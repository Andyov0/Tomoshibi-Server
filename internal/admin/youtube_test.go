package admin

import (
	"encoding/json"
	"net/http"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
)

/*
The YouTube relay's switch, as the settings page moves it.

It stands above no grant, so on is YouTube relayed for everybody in mainland
China at once, and the gate that matters is who may press it. Beside that, the
one quiet way it could go wrong is the request: the page sends one switch at a
time, and a body naming only YouTube that also wrote the Emby switch — as off,
because it was not said — would turn every granted film off for the whole
deployment as a side effect of somebody turning YouTube on.
*/

// tubeSpent is a relay that has carried a fixed amount of YouTube and no films.
type tubeSpent uint64

func (s tubeSpent) EmbySpent() map[string]uint64 { return nil }
func (s tubeSpent) YouTubeSpent() uint64         { return uint64(s) }
func (s tubeSpent) BangumiSpent() uint64         { return 0 }
func (s tubeSpent) MoveSpent(string, string)     {}

func TestOnlyTheSettingsCapabilityTurnsTheYouTubeRelayOn(t *testing.T) {
	api, mux, written := mountAudited(t, []config.Admin{
		{Trip: room.Trip(key, "watcher"), Name: "wes"},
		{Trip: room.Trip(key, "clerk"), Name: "cara", Can: []string{config.ManageAccounts}},
		{Trip: room.Trip(key, "keeper"), Name: "kit", Can: []string{config.ManageSettings}},
	})

	board := &switchboard{on: true}
	api.settings = board
	api.conf.Meet.Watch = config.Watch{URL: "http://gateway.invalid", DirectOnly: true}
	api.UseSpent(tubeSpent(5 << 20))

	for _, who := range []string{"watcher", "clerk"} {
		got := call(mux, http.MethodPut, "/api/admin/settings", signIn(t, api, who), `{"youtubeRelay":true}`)

		if got.Code != http.StatusForbidden {
			t.Errorf("%s turned the YouTube relay on: %d", who, got.Code)
		}
	}

	if board.YouTubeRelay() {
		t.Fatal("the YouTube relay was turned on by somebody refused")
	}

	keeper := signIn(t, api, "keeper")

	if got := call(mux, http.MethodPut, "/api/admin/settings", keeper, `{"youtubeRelay":true}`); got.Code != http.StatusOK {
		t.Fatalf("turning the YouTube relay on answered %d", got.Code)
	}

	if !board.YouTubeRelay() {
		t.Fatal("the YouTube relay was not turned on")
	}

	if !board.EmbyRelay() {
		t.Error("turning the YouTube relay on turned the Emby relay off")
	}

	found := false
	for _, entry := range written.recorded() {
		if entry.Action == "set the YouTube relay" && entry.Target == "on" && !entry.Failed {
			found = entry.Trip == room.Trip(key, "keeper")
		}

		if entry.Action == "set the media server relay" {
			t.Errorf("turning the YouTube relay on was recorded as setting the media server relay too: %+v", entry)
		}
	}
	if !found {
		t.Error("turning the YouTube relay on left no record of who did")
	}

	// And the other way: the Emby switch alone leaves YouTube where it is.
	if got := call(mux, http.MethodPut, "/api/admin/settings", keeper, `{"embyRelay":false}`); got.Code != http.StatusOK {
		t.Fatalf("turning the Emby relay off answered %d", got.Code)
	}

	if !board.YouTubeRelay() {
		t.Error("turning the Emby relay off turned the YouTube relay off")
	}

	// Anybody may read it, with what it has cost, and the runtime panel says
	// the same.
	watcher := signIn(t, api, "watcher")

	var read watching
	_ = json.Unmarshal(call(mux, http.MethodGet, "/api/admin/settings", watcher, "").Body.Bytes(), &read)

	want := watching{Configured: true, DirectOnly: true, EmbyRelay: false, YouTubeRelay: true, YouTubeSpent: 5 << 20}
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
