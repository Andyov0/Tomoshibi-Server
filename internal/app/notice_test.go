package app

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/remote"
)

/*
The two notices the management pages publish reach the web through
/api/deployment, which every page reads first: the sign-in page's to anybody,
and the lobby's to a caller signed in to an account and to nobody else. The
owner published a lobby notice, found it missing in Chrome, then found it on
the sign-in page once the web showed it, and asked for the two to be set apart:
"this one is for people signed in". What is guarded here is that each is told
to the right caller while it is up and not after, that the answer is never kept
by the CDN in front, and that the apps are told the sign-in notice without the
answer every app already holds changing while there is none.
*/

func deploymentSaid(t *testing.T, mux http.Handler, cookie *http.Cookie) (map[string]json.RawMessage, http.Header) {
	t.Helper()

	got := appsGet(mux, "/api/deployment", cookie)
	if got.Code != http.StatusOK {
		t.Fatalf("/api/deployment answered %d", got.Code)
	}

	var said map[string]json.RawMessage
	if err := json.Unmarshal(got.Body.Bytes(), &said); err != nil {
		t.Fatal(err)
	}

	return said, got.Header()
}

func noticeIn(t *testing.T, raw json.RawMessage) *remote.Notice {
	t.Helper()

	if raw == nil {
		return nil
	}

	var told remote.Notice
	if err := json.Unmarshal(raw, &told); err != nil {
		t.Fatalf("a notice nobody can read: %s", raw)
	}

	return &told
}

func noticed(id string) *remote.Notice {
	return &remote.Notice{ID: id, Level: "info", Text: map[string]string{"en": "A notice.", "zh-Hans": "一条公告。"}}
}

func TestEachNoticeIsToldToItsOwnReaders(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{})
	shelves := desk(t, nil, dir)
	mux, _, signedIn := appsApp(t, shelves)

	if said, header := deploymentSaid(t, mux, nil); said["notice"] != nil || said["signInNotice"] != nil {
		t.Errorf("with nothing published the page is told %s and %s", said["notice"], said["signInNotice"])
	} else if header.Get("Cache-Control") != "no-store" {
		t.Errorf("/api/deployment may be kept by a cache: Cache-Control %q", header.Get("Cache-Control"))
	}

	if err := shelves.remote.SetNotice(noticed("lobby-1")); err != nil {
		t.Fatal(err)
	}
	if err := shelves.remote.SetSignInNotice(noticed("signin-1")); err != nil {
		t.Fatal(err)
	}

	// Signed out: the sign-in page's, and not the lobby's.
	said, _ := deploymentSaid(t, mux, nil)
	if told := noticeIn(t, said["signInNotice"]); told == nil || told.ID != "signin-1" || told.Text["zh-Hans"] != "一条公告。" {
		t.Errorf("signed out, the page is told the sign-in notice %s", said["signInNotice"])
	}
	if said["notice"] != nil {
		t.Errorf("signed out, the page is told the lobby's notice, which is for people signed in: %s", said["notice"])
	}

	// Signed in: the lobby's too.
	said, _ = deploymentSaid(t, mux, signedIn)
	if told := noticeIn(t, said["notice"]); told == nil || told.ID != "lobby-1" {
		t.Errorf("signed in, the page is told the lobby notice %s", said["notice"])
	}

	// A session that is not one is nobody signed in.
	forged := &http.Cookie{Name: signedIn.Name, Value: "not-a-session"}
	if said, _ := deploymentSaid(t, mux, forged); said["notice"] != nil {
		t.Errorf("with a cookie that is no session, the page is told the lobby's notice: %s", said["notice"])
	}

	// Each past its end is told to nobody.
	for _, set := range []func(*remote.Notice) error{shelves.remote.SetNotice, shelves.remote.SetSignInNotice} {
		ended := noticed("ended")
		ended.Until = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
		if err := set(ended); err != nil {
			t.Fatal(err)
		}
	}
	if said, _ := deploymentSaid(t, mux, signedIn); said["notice"] != nil || said["signInNotice"] != nil {
		t.Errorf("notices past their end are still told: %s %s", said["notice"], said["signInNotice"])
	}
}

// The apps are told the sign-in notice for the release that shows it, and the
// answer they already hold, and its revision, are the same while there is none.
func TestTheAppsAreToldTheSignInNoticeWithoutTheirAnswerChangingBeforeIt(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{})
	shelves := desk(t, nil, dir)
	mux, _, _ := appsApp(t, shelves)

	if err := shelves.remote.SetNotice(noticed("lobby-1")); err != nil {
		t.Fatal(err)
	}

	before := appsGet(mux, "/api/apps/remote", nil, "User-Agent", updatingLinux)
	var answer map[string]json.RawMessage
	if err := json.Unmarshal(before.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if _, there := answer["signInNotice"]; there {
		t.Errorf("with no sign-in notice the apps' answer names one, which changes every app's revision: %s", before.Body.String())
	}

	if err := shelves.remote.SetSignInNotice(noticed("signin-1")); err != nil {
		t.Fatal(err)
	}

	after := appsGet(mux, "/api/apps/remote", nil, "User-Agent", updatingLinux)
	if err := json.Unmarshal(after.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if told := noticeIn(t, answer["signInNotice"]); told == nil || told.ID != "signin-1" {
		t.Errorf("the apps are told the sign-in notice %s", answer["signInNotice"])
	}
	if before.Header().Get("ETag") == after.Header().Get("ETag") {
		t.Error("publishing a sign-in notice left the apps' revision as it was, so an app holding it would not ask again")
	}
}

// A deployment with no shelves has no notice to tell, and says the rest as before.
func TestADeploymentWithoutShelvesTellsNoNotice(t *testing.T) {
	_, _, app := controlWithStore(t, config.PickProbe)
	app.apps = nil

	said, _ := deploymentSaid(t, app.Handler(), nil)
	if said["notice"] != nil || said["signInNotice"] != nil || said["openedBy"] == nil {
		t.Errorf("without shelves /api/deployment said %v", said)
	}
}
