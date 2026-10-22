package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/remote"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
What the apps are told between releases (remote.go).

Every one of these faults is silent, because the app on the other end keeps the
last answer it had and says nothing when the next is wrong. An answer that a
browser can read is the address turned into a page. An answer that fails is
every app keeping yesterday's notice. A rule applied to the wrong platform, or
to a version just outside its bounds, is a feature missing from somebody's
phone with nothing on any screen to say why. And a revision that changes
between two identical answers is a 304 that never comes, which costs every app
the whole file on every check and looks exactly like working.
*/

// The apps' user agents, as the core sends them (core/protocol/src/api/agent.rs).
const (
	androidAt = "Tomoshibi/%s (Android; Android 16; samsung SM-F956B)"
	iphoneAt  = "Tomoshibi/%s (iPhone; iOS 27.0.1; iPhone17,1)"
	ipadAt    = "Tomoshibi/%s (iPad; iPadOS 27.0; iPad16,3)"
	macAt     = "Tomoshibi/%s (Mac; macOS 27.0; Mac16,10)"
	windowsAt = "Tomoshibi/%s (Windows; Windows 11; x64)"
)

// told is what an app is answered, read back.
type told struct {
	Revision string                       `json:"revision"`
	Phrases  map[string]map[string]string `json:"phrases"`
	Off      []string                     `json:"off"`
	Params   map[string]float64           `json:"params"`
	Notice   *remote.Notice               `json:"notice"`
}

// remoteRig is the router over an apps directory holding a remote.json, with
// the clock held still.
func remoteRig(t *testing.T, contents string) (http.Handler, *App, string) {
	t.Helper()

	dir := t.TempDir()
	if contents != "" {
		if err := os.WriteFile(filepath.Join(dir, remote.Name), []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	_, _, app := controlWithStore(t, config.PickProbe)
	app.apps = desk(t, nil, dir)
	app.clock = func() time.Time { return time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC) }

	return app.Handler(), app, dir
}

func askRemote(t *testing.T, mux http.Handler, agent string, header ...string) *httptest.ResponseRecorder {
	t.Helper()

	return appsGet(mux, "/api/apps/remote", nil, append([]string{"User-Agent", agent}, header...)...)
}

func tellOf(t *testing.T, recorder *httptest.ResponseRecorder) told {
	t.Helper()

	if recorder.Code != http.StatusOK {
		t.Fatalf("answered %d %s", recorder.Code, recorder.Body.String())
	}

	var answer told
	if err := json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil {
		t.Fatalf("the answer is not the apps' remote settings: %v\n%s", err, recorder.Body.String())
	}

	return answer
}

func TestTheRemoteSettingsAnswerTheAppsAloneAndNeedNoAccount(t *testing.T) {
	mux, _, _ := remoteRig(t, `{"notice": {"id": "n", "text": {"en": "Hello"}}}`)

	if got := askRemote(t, mux, fmt.Sprintf(androidAt, "0.1.4")); got.Code != http.StatusOK {
		t.Errorf("the app with no session was answered %d %s", got.Code, got.Body.String())
	}

	for _, agent := range []string{browserAgent, "", "curl/8.7.1", "tomoshibi/0.1.4 (Android; Android 16; x)"} {
		got := askRemote(t, mux, agent)
		if got.Code != http.StatusForbidden || refusalOf(t, got) != reasonNotTheApp {
			t.Errorf("%q was answered %d %q; the address pasted into a browser must not be a page",
				agent, got.Code, refusalOf(t, got))
		}
	}
}

// Nothing to say is still an answer, and an answer of the same shape: every
// field there, empty, so that an app replacing its cache with it is not left
// holding half of the last one.
func TestNoFileOrABrokenOneIsAnAnswerWithNothingInIt(t *testing.T) {
	empty := map[string]any{"phrases": map[string]any{}, "off": []any{}, "params": map[string]any{}, "notice": nil}

	for name, contents := range map[string]string{
		"no file":         "",
		"not JSON":        `{"notice": {"id": "n", "text": {"en": "half`,
		"not an object":   `[{"feature": "music", "off": true}]`,
		"every part null": `{"phrases": null, "switches": null, "params": null, "notice": null}`,
	} {
		t.Run(name, func(t *testing.T) {
			mux, _, _ := remoteRig(t, contents)

			got := askRemote(t, mux, fmt.Sprintf(androidAt, "0.1.4"))
			if got.Code != http.StatusOK {
				t.Fatalf("answered %d %s; an app refused keeps what it had, notice and all", got.Code, got.Body.String())
			}

			var answer map[string]any
			if err := json.Unmarshal(got.Body.Bytes(), &answer); err != nil {
				t.Fatal(err)
			}

			if revision, _ := answer["revision"].(string); len(revision) != 16 {
				t.Errorf("the revision is %q, want sixteen hex digits", answer["revision"])
			}

			delete(answer, "revision")

			if !reflect.DeepEqual(answer, empty) {
				t.Errorf("answered %v, want %v", answer, empty)
			}
		})
	}

	// And a deployment with no apps directory at all.
	_, app, _ := remoteRig(t, "")
	app.apps = desk(t, nil, "")

	if got := tellOf(t, askRemote(t, app.Handler(), fmt.Sprintf(androidAt, "0.1.4"))); got.Notice != nil || len(got.Off) != 0 {
		t.Errorf("no directory told %+v", got)
	}
}

func TestOneSectionWrittenWronglyCostsOnlyItself(t *testing.T) {
	mux, _, _ := remoteRig(t, `{
		"phrases":  {"Join": {"zh-Hans": "加入"}},
		"switches": {"feature": "music", "off": true},
		"params":   [{"name": "screen_share_max_fps", "value": 30}],
		"notice":   {"id": "n", "text": {"en": "Maintenance tonight"}}
	}`)

	got := tellOf(t, askRemote(t, mux, fmt.Sprintf(androidAt, "0.1.4")))

	if got.Phrases["Join"]["zh-Hans"] != "加入" || got.Params["screen_share_max_fps"] != 30 ||
		got.Notice == nil || got.Notice.Text["en"] != "Maintenance tonight" {
		t.Errorf("told %+v; switches written wrongly took the rest with them", got)
	}

	if len(got.Off) != 0 {
		t.Errorf("switches that are not a list turned off %v", got.Off)
	}
}

func TestARuleIsForThePlatformsItNames(t *testing.T) {
	mux, _, _ := remoteRig(t, `{"switches": [
		{"feature": "screen-share", "off": true, "platforms": ["android"]},
		{"feature": "background-blur", "off": true, "platforms": ["ios"]},
		{"feature": "music", "off": true, "platforms": ["mac", "windows"]},
		{"feature": "app-updates", "off": true}
	]}`)

	for agent, want := range map[string][]string{
		androidAt: {"app-updates", "screen-share"},
		iphoneAt:  {"app-updates", "background-blur"},
		ipadAt:    {"app-updates", "background-blur"},
		macAt:     {"app-updates", "music"},
		windowsAt: {"app-updates", "music"},
		// One of the apps that did not say which: told only what holds for
		// every platform, never what holds for one it might be.
		"Tomoshibi/%s":                       {"app-updates"},
		"Tomoshibi/%s (Linux; Debian 13; x)": {"app-updates"},
	} {
		got := tellOf(t, askRemote(t, mux, fmt.Sprintf(agent, "0.1.4")))
		if !reflect.DeepEqual(got.Off, want) {
			t.Errorf("%s is told %v is off, want %v", fmt.Sprintf(agent, "0.1.4"), got.Off, want)
		}
	}
}

/*
The bounds, at their edges. 0.1.4.2 is the second build of 0.1.4 and is from
0.1.4 and below 0.1.5, as the update check orders them; 0.1.5 is not below
itself; and an app that says no version is told nothing a version decides.
*/
func TestARuleIsForTheVersionsItNames(t *testing.T) {
	mux, _, _ := remoteRig(t, `{"switches": [
		{"feature": "screen-share", "off": true, "from": "0.1.4", "below": "0.1.5"},
		{"feature": "music", "off": true, "below": "0.1.4.2"},
		{"feature": "watch-together", "off": true, "from": "0.1.5"}
	]}`)

	for version, want := range map[string][]string{
		"0.1.3":   {"music"},
		"0.1.4":   {"music", "screen-share"},
		"0.1.4.1": {"music", "screen-share"},
		"0.1.4.2": {"screen-share"},
		"0.1.4.9": {"screen-share"},
		"0.1.5":   {"watch-together"},
		"0.1.10":  {"watch-together"},
	} {
		got := tellOf(t, askRemote(t, mux, fmt.Sprintf(androidAt, version)))
		if !reflect.DeepEqual(got.Off, want) {
			t.Errorf("%s is told %v is off, want %v", version, got.Off, want)
		}
	}

	if got := tellOf(t, askRemote(t, mux, "Tomoshibi/")); len(got.Off) != 0 {
		t.Errorf("an app that says no version is told %v is off", got.Off)
	}
}

func TestALaterRuleOverridesAnEarlierOne(t *testing.T) {
	mux, _, _ := remoteRig(t, `{"switches": [
		{"feature": "screen-share", "off": true, "platforms": ["android"]},
		{"feature": "screen-share", "off": false, "platforms": ["android"], "from": "0.1.5"},
		{"feature": "music", "off": false},
		{"feature": "music", "off": true, "platforms": ["ios"]}
	], "params": [
		{"name": "screen_share_max_fps", "value": 30},
		{"name": "screen_share_max_fps", "value": 15, "platforms": ["android"]},
		{"name": "screen_share_max_fps", "value": 24, "platforms": ["android"], "from": "0.1.5"},
		{"name": "screen_share_hot_fps", "value": 0}
	]}`)

	for _, c := range []struct {
		agent  string
		off    []string
		fps    float64
		hotFPS bool
	}{
		{fmt.Sprintf(androidAt, "0.1.4"), []string{"screen-share"}, 15, true},
		// Turned back on, by a narrower rule further down.
		{fmt.Sprintf(androidAt, "0.1.5"), []string{}, 24, true},
		{fmt.Sprintf(iphoneAt, "0.1.4"), []string{"music"}, 30, true},
	} {
		got := tellOf(t, askRemote(t, mux, c.agent))

		if !reflect.DeepEqual(got.Off, c.off) {
			t.Errorf("%s is told %v is off, want %v", c.agent, got.Off, c.off)
		}

		if got.Params["screen_share_max_fps"] != c.fps {
			t.Errorf("%s is told a frame rate of %v, want %v", c.agent, got.Params["screen_share_max_fps"], c.fps)
		}

		// Nought is a value, and is said rather than left out.
		if value, said := got.Params["screen_share_hot_fps"]; !said || value != 0 {
			t.Errorf("%s is told the hot frame rate is %v (said: %v), want 0", c.agent, value, said)
		}
	}
}

func TestANoticeIsSentUntilItsEnd(t *testing.T) {
	// The rig's clock stands at noon on the 22nd.
	for until, sent := range map[string]bool{
		"":                          true,
		"2026-10-22T12:00:01Z":      true,
		"2026-10-22T12:00:00Z":      false,
		"2026-10-22T19:59:59+08:00": false,
		"2026-10-21T00:00:00Z":      false,
	} {
		end := ""
		if until != "" {
			end = `, "until": "` + until + `"`
		}

		mux, _, _ := remoteRig(t, `{"notice": {"id": "n", "level": "warning", "text": {"en": "Tonight"}`+end+`}}`)
		got := tellOf(t, askRemote(t, mux, fmt.Sprintf(iphoneAt, "0.1.4")))

		if (got.Notice != nil) != sent {
			t.Errorf("a notice ending %q was sent: %v, want %v", until, got.Notice != nil, sent)
		}

		if sent && (got.Notice.Level != remote.Warning || got.Notice.Until != until || got.Notice.ID != "n") {
			t.Errorf("the notice was sent as %+v", got.Notice)
		}
	}
}

func TestANoticeWithoutAnIDIsNotSent(t *testing.T) {
	mux, _, _ := remoteRig(t, `{"notice": {"level": "info", "text": {"en": "Tonight"}}}`)

	if got := tellOf(t, askRemote(t, mux, fmt.Sprintf(iphoneAt, "0.1.4"))); got.Notice != nil {
		t.Errorf("a notice with no id was sent as %+v; no app could remember having closed it", got.Notice)
	}
}

func TestWhatIsTooLongIsPassedOverAndTheRestSent(t *testing.T) {
	phrases := make([]string, 0, remote.MaxPhrases+1)
	for at := range remote.MaxPhrases + 1 {
		phrases = append(phrases, fmt.Sprintf(`"phrase %d": {"ja": "訳"}`, at))
	}

	long := strings.Repeat("字", remote.PhraseLength+1)
	phrases = append(phrases, `"phrase 0": {"ja": "`+long+`", "zh-Hans": "短"}`)

	mux, _, _ := remoteRig(t, `{
		"phrases": {`+strings.Join(phrases, ",")+`},
		"notice": {"id": "n", "text": {"en": "`+strings.Repeat("a", remote.NoticeLength+1)+`", "ja": "今夜"}}
	}`)

	got := tellOf(t, askRemote(t, mux, fmt.Sprintf(androidAt, "0.1.4")))

	if len(got.Phrases) != remote.MaxPhrases {
		t.Errorf("%d phrases were sent, want %d", len(got.Phrases), remote.MaxPhrases)
	}

	if _, sent := got.Phrases[fmt.Sprintf("phrase %d", remote.MaxPhrases)]; sent {
		t.Error("the phrase past the limit was sent")
	}

	if said := got.Phrases["phrase 0"]; !reflect.DeepEqual(said, map[string]string{"zh-Hans": "短"}) {
		t.Errorf("a phrase with one translation too long was sent as %v", keysOf(said))
	}

	if got.Notice == nil || !reflect.DeepEqual(got.Notice.Text, map[string]string{"ja": "今夜"}) {
		t.Errorf("a notice with one language too long was sent as %+v", got.Notice)
	}
}

func TestATranslationWithOtherPlaceholdersIsNotSent(t *testing.T) {
	mux, _, _ := remoteRig(t, `{"phrases": {"Tomoshibi {version} is available": {
		"zh-Hans": "Tomoshibi {version} 已可更新", "ja": "Tomoshibi {バージョン} が利用可能です"}}}`)

	got := tellOf(t, askRemote(t, mux, fmt.Sprintf(androidAt, "0.1.4")))

	if said := got.Phrases["Tomoshibi {version} is available"]; !reflect.DeepEqual(said,
		map[string]string{"zh-Hans": "Tomoshibi {version} 已可更新"}) {
		t.Errorf("the phrase was sent as %v; a translation naming another placeholder shows its braces", said)
	}
}

func keysOf(said map[string]string) []string {
	var keys []string
	for tag, text := range said {
		keys = append(keys, fmt.Sprintf("%s:%d", tag, len([]rune(text))))
	}
	return keys
}

/*
The revision, which the apps send back to be told nothing has changed.

It has to be the same for the same answer every time, which a list built from
a map or an object written in whichever order a map is visited would not be;
and it has to be what it says it is, the hash of the rest of the answer with
every object's keys in order, so that it changes exactly when the answer does.
*/
func TestTheRevisionIsTheAnswersOwnHashAndItsETag(t *testing.T) {
	contents := `{
		"phrases": {"Join": {"zh-Hans": "加入", "ja": "参加", "en": "Join", "zh-Hant": "加入"}, "Leave": {"ja": "退出"}},
		"switches": [
			{"feature": "screen-share", "off": true}, {"feature": "music", "off": true},
			{"feature": "watch-together", "off": true}, {"feature": "background-blur", "off": true},
			{"feature": "app-updates", "off": true}
		],
		"params": [{"name": "screen_share_max_fps", "value": 30}, {"name": "update_check_hours", "value": 6},
			{"name": "screen_share_hot_fps", "value": 0}, {"name": "screen_share_max_height", "value": 1080}],
		"notice": {"id": "n", "level": "warning", "until": "2026-10-23T00:00:00Z", "text": {"en": "<Tonight> & after", "ja": "今夜"}}
	}`

	mux, _, dir := remoteRig(t, contents)
	agent := fmt.Sprintf(androidAt, "0.1.4")

	first := askRemote(t, mux, agent)
	answer := tellOf(t, first)

	if first.Header().Get("Cache-Control") != "no-store" || first.Header().Get("Vary") != "User-Agent" {
		t.Errorf("headers %v; a CDN that kept this would go on sending a notice taken down", first.Header())
	}

	if tag := first.Header().Get("ETag"); tag != `"`+answer.Revision+`"` {
		t.Errorf("the ETag is %s and the revision %s", tag, answer.Revision)
	}

	var rest map[string]any
	if err := json.Unmarshal(first.Body.Bytes(), &rest); err != nil {
		t.Fatal(err)
	}
	delete(rest, "revision")

	// Through maps, which encoding/json writes in the order of their keys at
	// every level: the canonical form, worked out without the code under test.
	canonical, err := json.Marshal(rest)
	if err != nil {
		t.Fatal(err)
	}

	sum := sha256.Sum256(canonical)
	if want := hex.EncodeToString(sum[:])[:16]; answer.Revision != want {
		t.Errorf("the revision is %s; the hash of the rest of the answer is %s", answer.Revision, want)
	}

	for range 20 {
		if again := tellOf(t, askRemote(t, mux, agent)); again.Revision != answer.Revision {
			t.Fatalf("the same answer came with revisions %s and %s; no app would ever be told 304",
				answer.Revision, again.Revision)
		}
	}

	for _, sent := range []string{`"` + answer.Revision + `"`, `W/"` + answer.Revision + `"`, `"other", "` + answer.Revision + `"`, "*"} {
		unchanged := askRemote(t, mux, agent, "If-None-Match", sent)

		if unchanged.Code != http.StatusNotModified || unchanged.Body.Len() != 0 {
			t.Errorf("If-None-Match %s was answered %d with %d bytes, want 304 and nothing",
				sent, unchanged.Code, unchanged.Body.Len())
		}

		if unchanged.Header().Get("ETag") != first.Header().Get("ETag") || unchanged.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("the 304 for %s came with %v", sent, unchanged.Header())
		}
	}

	if got := askRemote(t, mux, agent, "If-None-Match", `"0000000000000000"`); got.Code != http.StatusOK {
		t.Errorf("a revision that is not this one was answered %d", got.Code)
	}

	// Another app told the same thing is given the same revision: it is the
	// answer that is hashed, not who asked for it.
	if other := tellOf(t, askRemote(t, mux, fmt.Sprintf(androidAt, "0.1.5"))); other.Revision != answer.Revision {
		t.Errorf("two apps told the same thing were given revisions %s and %s", answer.Revision, other.Revision)
	}

	// The file changed is a new answer.
	if err := os.WriteFile(filepath.Join(dir, remote.Name), []byte(strings.Replace(contents, `"value": 30`, `"value": 24`, 1)), 0o644); err != nil {
		t.Fatal(err)
	}

	changed := askRemote(t, mux, agent, "If-None-Match", `"`+answer.Revision+`"`)
	if changed.Code != http.StatusOK || tellOf(t, changed).Revision == answer.Revision {
		t.Errorf("a changed file was answered %d with the old revision", changed.Code)
	}
}

func TestADifferentAnswerIsADifferentRevision(t *testing.T) {
	mux, _, _ := remoteRig(t, `{"switches": [{"feature": "screen-share", "off": true, "platforms": ["android"]}]}`)

	android := tellOf(t, askRemote(t, mux, fmt.Sprintf(androidAt, "0.1.4")))
	iphone := tellOf(t, askRemote(t, mux, fmt.Sprintf(iphoneAt, "0.1.4")))

	if android.Revision == iphone.Revision {
		t.Errorf("an Android app told %v and an iPhone told %v were given one revision, %s; "+
			"the iPhone would be told 304 for Android's answer", android.Off, iphone.Off, android.Revision)
	}
}

// The two halves meet at the file: what the management pages publish is what
// the apps are told, on a deployment assembled the way New assembles one.
func TestWhatThePagesPublishIsWhatTheAppsAreTold(t *testing.T) {
	dir := t.TempDir()

	_, st, app := controlWithStore(t, config.PickProbe)
	app.conf.Meet.Apps.MacDir = dir
	app.admin = admin.New(app.conf, nil, st, tripKey)
	app.apps = newAppsDesk(app.conf)

	trip := room.Trip(tripKey, "the owner's passphrase")
	if err := st.AddAdmin(store.Admin{Trip: trip, Name: "owner", Can: []string{config.ManageSettings}}); err != nil {
		t.Fatal(err)
	}

	mux := app.Handler()

	signed := ask(mux, asking(http.MethodPost, "/api/admin/session", "",
		`{"name":"owner","passphrase":"the owner's passphrase"}`))
	if signed.Code != http.StatusOK {
		t.Fatalf("signing in answered %d", signed.Code)
	}

	put := func(path, body string) {
		t.Helper()

		request := asking(http.MethodPut, path, "", body)
		for _, cookie := range signed.Result().Cookies() {
			request.AddCookie(cookie)
		}

		if got := ask(mux, request); got.Code != http.StatusOK {
			t.Fatalf("PUT %s answered %d %s", path, got.Code, got.Body.String())
		}
	}

	put("/api/admin/remote/notice", `{"id": "2026-10-22-120000", "level": "warning", "text": {"zh-Hans": "今晚维护"}}`)
	put("/api/admin/remote/switches", `{"switches": [{"feature": "screen-share", "off": true, "platforms": ["android"], "below": "0.1.5"}]}`)

	got := tellOf(t, askRemote(t, mux, fmt.Sprintf(androidAt, "0.1.4")))

	if got.Notice == nil || got.Notice.ID != "2026-10-22-120000" || got.Notice.Text["zh-Hans"] != "今晚维护" {
		t.Errorf("the published notice reached the app as %+v", got.Notice)
	}

	if !reflect.DeepEqual(got.Off, []string{"screen-share"}) {
		t.Errorf("the saved switch reached the app as %v", got.Off)
	}

	put("/api/admin/remote/notice", ``)

	if got := tellOf(t, askRemote(t, mux, fmt.Sprintf(androidAt, "0.1.4"))); got.Notice != nil {
		t.Errorf("a notice taken down is still sent as %+v", got.Notice)
	}
}
