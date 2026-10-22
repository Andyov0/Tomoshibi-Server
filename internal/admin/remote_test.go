package admin

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/remote"
	"tomoshibi/internal/room"
)

/*
The lobby's notice and the feature switches, from the management pages
(remote.go).

Both reach every app at its next check, so what these guard is that only
somebody holding the settings may change them, that what is refused leaves the
file exactly as it was, and that what is accepted changes its own section and
nothing else in a file somebody else looks after. And that each change is in
the log against whoever made it, in words that answer "who turned this off".

The table in api_test.go holds the four routes to their capabilities with every
other; these go further, into what is written.
*/

// remoteMounted is the pages over an apps directory holding contents as its
// remote.json, with an observer and a keeper of the settings to sign in as.
func remoteMounted(t *testing.T, contents string) (*API, http.Handler, *kept, string) {
	t.Helper()

	api, mux, written := mountAudited(t, []config.Admin{
		{Trip: room.Trip(key, "watcher"), Name: "wes"},
		{Trip: room.Trip(key, "keeper"), Name: "kit", Can: []string{config.ManageSettings}},
	})

	dir := t.TempDir()
	if contents != "" {
		if err := os.WriteFile(filepath.Join(dir, remote.Name), []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	api.remote = remote.At(dir)

	return api, mux, written, filepath.Join(dir, remote.Name)
}

func fileAt(t *testing.T, path string) string {
	t.Helper()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	return string(raw)
}

const keptByHand = `{
    "phrases": {"Join":  {"zh-Hans": "加入"}},
    "params": [ {"name": "screen_share_max_fps", "value": 30} ]
}
`

// soon is an end that has not come, an hour from whenever the test runs. The
// pages check an end against the wall clock, there being nobody to hold it.
func soon() string {
	return time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
}

func TestOnlyTheSettingsPublishTheAppsNotice(t *testing.T) {
	api, mux, _, path := remoteMounted(t, keptByHand)

	body := `{"id": "2026-10-22-080000", "level": "warning", "until": "` + soon() + `", "text": {"zh-Hans": "今晚维护", "en": "Maintenance tonight"}}`

	if got := call(mux, http.MethodPut, "/api/admin/remote/notice", signIn(t, api, "watcher"), body); got.Code != http.StatusForbidden {
		t.Fatalf("somebody who may only watch published a notice: %d", got.Code)
	}

	if after := fileAt(t, path); after != keptByHand {
		t.Fatalf("a refused notice changed the file:\n%s", after)
	}

	got := call(mux, http.MethodPut, "/api/admin/remote/notice", signIn(t, api, "keeper"), body)
	if got.Code != http.StatusOK {
		t.Fatalf("the keeper of the settings was answered %d %s", got.Code, got.Body.String())
	}

	var read noticeReading
	if err := json.Unmarshal(call(mux, http.MethodGet, "/api/admin/remote/notice", signIn(t, api, "watcher"), "").Body.Bytes(), &read); err != nil {
		t.Fatal(err)
	}

	if !read.Showing || read.Notice == nil || read.Notice.ID != "2026-10-22-080000" ||
		read.Notice.Level != remote.Warning || read.Notice.Text["zh-Hans"] != "今晚维护" {
		t.Errorf("the notice reads back as %+v", read)
	}

	after := fileAt(t, path)
	for _, kept := range []string{`"phrases": {"Join":  {"zh-Hans": "加入"}}`, `"params": [ {"name": "screen_share_max_fps", "value": 30} ]`} {
		if !strings.Contains(after, kept) {
			t.Errorf("publishing a notice rewrote %s:\n%s", kept, after)
		}
	}
}

func TestTakingTheNoticeDownIsAnEmptyBodyOrNull(t *testing.T) {
	for _, body := range []string{"", "null", "  null \n"} {
		api, mux, _, path := remoteMounted(t, `{"notice": {"id": "n", "text": {"en": "Old"}}, "phrases": {}}`)

		got := call(mux, http.MethodPut, "/api/admin/remote/notice", signIn(t, api, "keeper"), body)
		if got.Code != http.StatusOK {
			t.Fatalf("taking down with %q answered %d %s", body, got.Code, got.Body.String())
		}

		var read noticeReading
		_ = json.Unmarshal(got.Body.Bytes(), &read)

		if read.Notice != nil || read.Showing {
			t.Errorf("after taking down with %q the page is told %+v", body, read)
		}

		if after := fileAt(t, path); strings.Contains(after, `"notice"`) || !strings.Contains(after, `"phrases": {}`) {
			t.Errorf("taking down with %q left\n%s", body, after)
		}
	}
}

func TestANoticeThatCannotBeShownIsRefusedAndNothingWritten(t *testing.T) {
	for _, c := range []struct {
		body, reason string
	}{
		{`{"level": "info", "text": {"en": "Hello"}}`, "bad_notice_id"},
		{`{"id": "n", "text": {"en": "   "}}`, "no_notice_text"},
		{`{"id": "n", "text": {"en": "` + strings.Repeat("a", remote.NoticeLength+1) + `"}}`, "notice_too_long"},
		{`{"id": "n", "level": "urgent", "text": {"en": "Hello"}}`, "no_such_level"},
		{`{"id": "n", "text": {"English": "Hello"}}`, "not_a_language"},
		{`{"id": "n", "until": "tonight", "text": {"en": "Hello"}}`, "not_a_time"},
		{`{"id": "n", "until": "2026-01-01T00:00:00Z", "text": {"en": "Hello"}}`, "notice_over"},
		{`{"id": "n", "text": {"en": 5}}`, "unreadable_request"},
		{`[1, 2]`, "unreadable_request"},
	} {
		api, mux, _, path := remoteMounted(t, keptByHand)

		got := call(mux, http.MethodPut, "/api/admin/remote/notice", signIn(t, api, "keeper"), c.body)
		if got.Code != http.StatusBadRequest || refusedFor(got) != c.reason {
			t.Errorf("%s was answered %d %q, want 400 %q", c.body, got.Code, refusedFor(got), c.reason)
		}

		if after := fileAt(t, path); after != keptByHand {
			t.Errorf("%s was refused and still changed the file:\n%s", c.body, after)
		}
	}
}

func TestTheSwitchesAreReplacedWholeAndInTheirOrder(t *testing.T) {
	api, mux, _, path := remoteMounted(t, keptByHand)
	keeper := signIn(t, api, "keeper")

	list := []remote.Switch{
		{Feature: "screen-share", Off: true, Where: remote.Where{Platforms: []string{"android"}, From: "0.1.4", Below: "0.1.5"}, Note: "crashes on the Fold"},
		{Feature: "screen-share", Off: false, Where: remote.Where{Platforms: []string{"android"}, From: "0.1.4.2"}},
		{Feature: "a-feature-from-a-newer-app", Off: true},
	}

	body, _ := json.Marshal(map[string]any{"switches": list})

	got := call(mux, http.MethodPut, "/api/admin/remote/switches", keeper, string(body))
	if got.Code != http.StatusOK {
		t.Fatalf("answered %d %s", got.Code, got.Body.String())
	}

	var read switchesReading
	if err := json.Unmarshal(call(mux, http.MethodGet, "/api/admin/remote/switches", signIn(t, api, "watcher"), "").Body.Bytes(), &read); err != nil {
		t.Fatal(err)
	}

	if !reflect.DeepEqual(read.Switches, list) || read.Unread != 0 {
		t.Errorf("the switches read back as %+v", read)
	}

	if after := fileAt(t, path); !strings.Contains(after, `"params": [ {"name": "screen_share_max_fps", "value": 30} ]`) {
		t.Errorf("saving the switches rewrote the params:\n%s", after)
	}

	// An empty list is every switch taken away, and is read back as a list.
	got = call(mux, http.MethodPut, "/api/admin/remote/switches", keeper, `{"switches": []}`)
	if got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"switches":[]`) {
		t.Errorf("an empty list was answered %d %s", got.Code, got.Body.String())
	}
}

func TestOneBadSwitchWritesNoneOfTheList(t *testing.T) {
	for _, c := range []struct {
		body, reason string
	}{
		{`{"switches": [{"feature": "music", "off": true}, {"feature": "screen-share", "off": true, "platforms": ["andriod"]}]}`, "no_such_platform"},
		{`{"switches": [{"feature": "music", "off": true}, {"feature": "screen-share", "off": true, "below": "next"}]}`, "not_a_version"},
		{`{"switches": [{"feature": "", "off": true}]}`, "bad_feature"},
		{`{"switches": [{"feature": "music", "note": "` + strings.Repeat("n", remote.NoteLength+1) + `"}]}`, "note_too_long"},
		// A field this server would ignore is a rule wider than the page meant.
		{`{"switches": [{"feature": "music", "off": true, "platfroms": ["android"]}]}`, "unreadable_request"},
		{`{"switches": [{"feature": "music", "off": "yes"}]}`, "unreadable_request"},
		{`{}`, "unreadable_request"},
		{`{"switches": [` + strings.Repeat(`{"feature": "music"},`, remote.MaxSwitches) + `{"feature": "music"}]}`, "too_many_switches"},
	} {
		api, mux, _, path := remoteMounted(t, keptByHand)

		got := call(mux, http.MethodPut, "/api/admin/remote/switches", signIn(t, api, "keeper"), c.body)
		if got.Code != http.StatusBadRequest || refusedFor(got) != c.reason {
			short := c.body
			if len(short) > 120 {
				short = short[:120] + "…"
			}
			t.Errorf("%s was answered %d %q, want 400 %q", short, got.Code, refusedFor(got), c.reason)
		}

		if after := fileAt(t, path); after != keptByHand {
			t.Errorf("a refused list still changed the file:\n%s", after)
		}
	}
}

func TestTheSwitchesTheFileCouldNotReadAreCounted(t *testing.T) {
	api, mux, _, _ := remoteMounted(t, `{"switches": [{"feature": "music", "off": true}, {"feature": "music", "platforms": ["andriod"]}]}`)

	var read switchesReading
	if err := json.Unmarshal(call(mux, http.MethodGet, "/api/admin/remote/switches", signIn(t, api, "watcher"), "").Body.Bytes(), &read); err != nil {
		t.Fatal(err)
	}

	if len(read.Switches) != 1 || read.Unread != 1 {
		t.Errorf("the page is told %+v; it must be told that a save would take away a rule it never showed", read)
	}
}

func TestAFileLeftBrokenIsNotWrittenOverFromAPage(t *testing.T) {
	broken := `{"phrases": {"Join": {"zh-Hans": "加入"}`

	api, mux, _, path := remoteMounted(t, broken)
	keeper := signIn(t, api, "keeper")

	for _, write := range []struct{ path, body string }{
		{"/api/admin/remote/notice", `{"id": "n", "text": {"en": "Hello"}}`},
		{"/api/admin/remote/notice", ``},
		{"/api/admin/remote/switches", `{"switches": []}`},
	} {
		got := call(mux, http.MethodPut, write.path, keeper, write.body)
		if got.Code != http.StatusConflict || refusedFor(got) != reasonRemoteUnreadable {
			t.Errorf("PUT %s %s over a broken file answered %d %q", write.path, write.body, got.Code, refusedFor(got))
		}
	}

	if after := fileAt(t, path); after != broken {
		t.Errorf("the broken file was written over with\n%s", after)
	}
}

func TestADeploymentWithNoAppsDirectorySaysSo(t *testing.T) {
	api, mux, _, _ := remoteMounted(t, "")
	api.remote = nil

	for _, method := range []string{http.MethodGet, http.MethodPut} {
		for _, path := range []string{"/api/admin/remote/notice", "/api/admin/remote/switches"} {
			got := call(mux, method, path, signIn(t, api, "keeper"), `{"switches": []}`)
			if got.Code != http.StatusServiceUnavailable || refusedFor(got) != reasonNoAppsDirectory {
				t.Errorf("%s %s with no apps directory answered %d %q", method, path, got.Code, refusedFor(got))
			}
		}
	}
}

func TestTheAppsNoticeAndSwitchesAreRecordedAgainstWhoChangedThem(t *testing.T) {
	api, mux, written, _ := remoteMounted(t, keptByHand)
	keeper := signIn(t, api, "keeper")

	call(mux, http.MethodPut, "/api/admin/remote/notice", keeper,
		`{"id": "2026-10-22-080000", "level": "warning", "until": "2030-01-01T00:00:00Z", "text": {"zh-Hans": "今晚维护", "en": "Tonight"}}`)
	call(mux, http.MethodPut, "/api/admin/remote/switches", keeper,
		`{"switches": [{"feature": "screen-share", "off": true, "platforms": ["android"], "from": "0.1.4", "below": "0.1.5"}, {"feature": "music"}]}`)
	call(mux, http.MethodPut, "/api/admin/remote/notice", keeper, ``)

	want := []Entry{
		{Action: "publish the apps' notice", Trip: room.Trip(key, "keeper"), Name: "kit",
			Target: "2026-10-22-080000", Change: "warning in en,zh-Hans until 2030-01-01T00:00:00Z"},
		{Action: "set the apps' feature switches", Trip: room.Trip(key, "keeper"), Name: "kit",
			Change: "screen-share off android 0.1.4..0.1.5; music on"},
		{Action: "take down the apps' notice", Trip: room.Trip(key, "keeper"), Name: "kit", Target: "2026-10-22-080000"},
	}

	var got []Entry
	for _, entry := range written.recorded() {
		if strings.Contains(entry.Action, "the apps'") {
			got = append(got, entry)
		}
	}

	if !reflect.DeepEqual(got, want) {
		t.Errorf("recorded\n%+v\nwant\n%+v", got, want)
	}
}
