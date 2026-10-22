package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
The apps asking for their own next version (updates.go).

Two things here would go wrong without anybody seeing: the address answering a
browser, which turns it into a download link anybody can paste and undoes the
account the download page asks for; and the user agent letting a request past
the page's own endpoints as well, which would undo it the other way. And the
notes, written by hand into the manifest, must never be what takes a build off
the shelf.

The iOS app's list adds two more. A line in it that names a file — a Mac line
pasted into the wrong list is the likely one — must not have that file handed
to a phone, nor its size and hash passed on as if they were a build to
download. And a list written wrongly must be no build for iOS and nothing at
all for the platforms whose apps are files.
*/

const updatingApp = "Tomoshibi/0.1.0.1 (Android; Android 16; samsung SM-F956B)"

// updatingIPhone is the user agent the iOS app sends (core/protocol/src/api/agent.rs).
const updatingIPhone = "Tomoshibi/0.1.0.8 (iPhone; iOS 27.0.1; iPhone17,1)"

const browserAgent = "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36"

func updateOf(t *testing.T, recorder *httptest.ResponseRecorder) updateView {
	t.Helper()

	var view updateView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatalf("the answer is not an update: %v\n%s", err, recorder.Body.String())
	}

	return view
}

func TestAnUpdateIsGivenToTheAppsWithoutAnAccountAndToNothingElse(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"android": {{version: "0.1.0.2", file: "Tomoshibi-0.1.0.2.apk", contents: apk}},
	})
	mux, _, _ := appsApp(t, desk(t, nil, dir))

	for _, path := range []string{"/api/apps/latest/android", "/api/apps/latest/android/file"} {
		if got := appsGet(mux, path, nil, "User-Agent", updatingApp); got.Code != http.StatusOK {
			t.Errorf("%s from the app with no session answered %d %s", path, got.Code, got.Body.String())
		}

		for _, agent := range []string{browserAgent, "", "curl/8.7.1", "tomoshibi/0.1"} {
			got := appsGet(mux, path, nil, "User-Agent", agent)
			if got.Code != http.StatusForbidden || refusalOf(t, got) != reasonNotTheApp {
				t.Errorf("%s from %q answered %d %q; a link pasted into a browser must not hand over the app",
					path, agent, got.Code, refusalOf(t, got))
			}
		}
	}

	// And the page's own download is not opened by saying one is the app.
	if got := appsGet(mux, "/api/apps/android", nil, "User-Agent", updatingApp); got.Code != http.StatusUnauthorized {
		t.Errorf("the page's download answered %d to the app's user agent with no session; "+
			"that is still behind an account or an invitation", got.Code)
	}
}

func TestAnUpdateSaysTheNewestBuildWithTheNotesThatCanBeShown(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"android": {
			{version: "0.1.0.1", file: "Tomoshibi-0.1.0.1.apk", contents: []byte("older")},
			{version: "0.1.0.10", file: "Tomoshibi-0.1.0.10.apk", contents: apk},
		},
	})

	digest := sha256.Sum256(apk)
	sum := hex.EncodeToString(digest[:])

	rewrite(t, dir, "android", fmt.Sprintf(`[
		{"version": "0.1.0.1", "file": "Tomoshibi-0.1.0.1.apk", "size": 5, "sha256": %q},
		{"version": "0.1.0.10", "file": "Tomoshibi-0.1.0.10.apk", "size": %d, "sha256": %q,
		 "notes": {"zh-Hans": "  修好了画中画  ", "en": "Fixed the small window", "ja": 7,
		           "../etc": "not a language", "zh-Hant": ""}}
	]`, hex.EncodeToString(func() []byte { d := sha256.Sum256([]byte("older")); return d[:] }()), len(apk), sum))

	mux, _, _ := appsApp(t, desk(t, nil, dir))

	got := appsGet(mux, "/api/apps/latest/android", nil, "User-Agent", updatingApp)
	if got.Code != http.StatusOK {
		t.Fatalf("answered %d %s", got.Code, got.Body.String())
	}

	view := updateOf(t, got)
	if view.Platform != "android" || view.Version != "0.1.0.10" || view.Size != int64(len(apk)) || view.SHA256 != sum {
		t.Errorf("told %+v; want 0.1.0.10, which is newer than 0.1.0.1 by number and not by text", view)
	}

	want := map[string]string{"zh-Hans": "修好了画中画", "en": "Fixed the small window"}
	if len(view.Notes) != len(want) {
		t.Errorf("notes are %v; want only %v — a note that is not text, under something that is not a "+
			"language, or empty is passed over", view.Notes, want)
	}
	for language, note := range want {
		if view.Notes[language] != note {
			t.Errorf("the %s note is %q, want %q", language, view.Notes[language], note)
		}
	}

	if cache := got.Header().Get("Cache-Control"); cache != "no-store" {
		t.Errorf("Cache-Control is %q; a CDN that kept this would go on offering the build before last", cache)
	}
}

func TestNotesWrittenWronglyDoNotTakeTheBuildAway(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"android": {{version: "0.1.0.2", file: "Tomoshibi-0.1.0.2.apk", contents: apk}},
	})

	digest := sha256.Sum256(apk)
	rewrite(t, dir, "android", fmt.Sprintf(`[{"version": "0.1.0.2", "file": "Tomoshibi-0.1.0.2.apk",
		"size": %d, "sha256": %q, "notes": "Fixed the small window"}]`, len(apk), hex.EncodeToString(digest[:])))

	mux, _, _ := appsApp(t, desk(t, nil, dir))

	got := appsGet(mux, "/api/apps/latest/android", nil, "User-Agent", updatingApp)
	if got.Code != http.StatusOK {
		t.Fatalf("notes written as a string rather than by language took the build away: %d %s", got.Code, got.Body.String())
	}

	if view := updateOf(t, got); view.Version != "0.1.0.2" || view.Notes != nil {
		t.Errorf("told %+v; want the build, with no notes", view)
	}
}

func TestEachPlatformsUpdateStreamsAndResumes(t *testing.T) {
	for _, one := range []struct{ section, suffix, contentType, called string }{
		{"mac", ".dmg", "application/x-apple-diskimage", "Mac"},
		{"android", ".apk", "application/vnd.android.package-archive", "Android"},
		{"windows", ".exe", "application/vnd.microsoft.portable-executable", "Windows"},
	} {
		t.Run(one.section, func(t *testing.T) {
			var logged bytes.Buffer
			was := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
			t.Cleanup(func() { slog.SetDefault(was) })

			body := bytes.Repeat([]byte(one.section), 400)
			dir := appsDirectory(t, map[string][]build{
				one.section: {{version: "0.1.0.8", file: "build" + one.suffix, contents: body}},
			})
			mux, _, _ := appsApp(t, desk(t, nil, dir))

			digest := sha256.Sum256(body)
			tag := `"` + hex.EncodeToString(digest[:]) + `"`
			path := "/api/apps/latest/" + one.section + "/file"

			whole := appsGet(mux, path, nil, "User-Agent", updatingApp)
			if whole.Code != http.StatusOK || !bytes.Equal(whole.Body.Bytes(), body) {
				t.Fatalf("answered %d with %d bytes, want the build whole", whole.Code, whole.Body.Len())
			}

			for header, value := range map[string]string{
				"Content-Type":        one.contentType,
				"Content-Disposition": `attachment; filename="Tomoshibi-0.1.0.8` + one.suffix + `"`,
				"ETag":                tag,
				"Accept-Ranges":       "bytes",
			} {
				if got := whole.Header().Get(header); got != value {
					t.Errorf("%s is %q, want %q", header, got, value)
				}
			}

			partial := appsGet(mux, path, nil, "User-Agent", updatingApp, "Range", "bytes=10-19", "If-Range", tag)
			if partial.Code != http.StatusPartialContent || !bytes.Equal(partial.Body.Bytes(), body[10:20]) {
				t.Errorf("a resumed download answered %d with %d bytes", partial.Code, partial.Body.Len())
			}

			line := "handed over the " + one.called + " app as an update"
			if got := strings.Count(logged.String(), line); got != 1 {
				t.Errorf("the log says %q %d times for one download and one piece of it:\n%s", line, got, logged.String())
			}
			if !strings.Contains(logged.String(), "from=0.1.0.1") {
				t.Errorf("the log does not say which version the app came from:\n%s", logged.String())
			}
		})
	}
}

func TestAnUpdateThatCannotBeGivenSaysNoBuild(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"mac":     {{version: "0.1.0.8", file: "Tomoshibi.dmg", contents: dmg}},
		"android": {{version: "0.1.0.2", file: "Tomoshibi.apk", contents: apk, sum: strings.Repeat("ab", 32)}},
	})
	mux, _, _ := appsApp(t, desk(t, nil, dir))

	for path, why := range map[string]string{
		"/api/apps/latest/android":      "a build that does not hash to its manifest",
		"/api/apps/latest/android/file": "a build that does not hash to its manifest",
		"/api/apps/latest/windows":      "a platform with no list",
		"/api/apps/latest/ios":          "a platform with no list",
		"/api/apps/latest/ios/file":     "an app installed elsewhere",
		"/api/apps/latest/linux":        "a platform there is no app for",
		"/api/apps/latest/linux/file":   "a platform there is no app for",
	} {
		got := appsGet(mux, path, nil, "User-Agent", updatingApp)
		if got.Code != http.StatusNotFound || refusalOf(t, got) != reasonNoBuild {
			t.Errorf("%s (%s) answered %d %q, want 404 no_build", path, why, got.Code, refusalOf(t, got))
		}
	}

	if got := appsGet(mux, "/api/apps/latest/mac", nil, "User-Agent", updatingApp); got.Code != http.StatusOK {
		t.Errorf("the Mac's build, which is fine, answered %d beside a broken Android one", got.Code)
	}
}

// fieldsOf is an answer's keys, for asking what it leaves out.
func fieldsOf(t *testing.T, recorder *httptest.ResponseRecorder) map[string]json.RawMessage {
	t.Helper()

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &fields); err != nil {
		t.Fatalf("the answer is not an object: %v\n%s", err, recorder.Body.String())
	}

	return fields
}

// The iOS app is told the newest version in its list, compared as the others
// are, with the notes that can be shown, and nothing an app would read as a
// file to download. It is behind the same user agent as the others.
func TestTheIOSAppIsToldItsVersionAndNotesAndNothingToDownload(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"mac": {{version: "0.1.0.8", file: "Tomoshibi-0.1.0.8.dmg", contents: dmg}},
	})
	rewrite(t, dir, "ios", `[
		{"version": "0.1.0.9", "notes": {"en": "The one before"}},
		{"version": "0.1.0.10", "notes": {"zh-Hans": "  修好了画中画  ", "en": "Fixed the small window", "ja": 7}},
		{"version": "0.1.0.2"}
	]`)

	mux, _, _ := appsApp(t, desk(t, nil, dir))

	got := appsGet(mux, "/api/apps/latest/ios", nil, "User-Agent", updatingIPhone)
	if got.Code != http.StatusOK {
		t.Fatalf("answered %d %s", got.Code, got.Body.String())
	}

	view := updateOf(t, got)
	if view.Platform != "ios" || view.Version != "0.1.0.10" {
		t.Errorf("told %+v; want ios 0.1.0.10, which is newer than 0.1.0.9 by number and not by text", view)
	}

	want := map[string]string{"zh-Hans": "修好了画中画", "en": "Fixed the small window"}
	if len(view.Notes) != len(want) {
		t.Errorf("notes are %v, want %v", view.Notes, want)
	}
	for language, note := range want {
		if view.Notes[language] != note {
			t.Errorf("the %s note is %q, want %q", language, view.Notes[language], note)
		}
	}

	for _, field := range []string{"size", "sha256"} {
		if value, said := fieldsOf(t, got)[field]; said {
			t.Errorf("the iOS app is told a %s of %s; there is no file, and an app told one would download it",
				field, value)
		}
	}

	if cache := got.Header().Get("Cache-Control"); cache != "no-store" {
		t.Errorf("Cache-Control is %q; a CDN that kept this would go on announcing the build before last", cache)
	}

	file := appsGet(mux, "/api/apps/latest/ios/file", nil, "User-Agent", updatingIPhone)
	if file.Code != http.StatusNotFound || refusalOf(t, file) != reasonNoBuild {
		t.Errorf("the iOS app's file answered %d %q, want 404 no_build", file.Code, refusalOf(t, file))
	}

	for _, path := range []string{"/api/apps/latest/ios", "/api/apps/latest/ios/file"} {
		if got := appsGet(mux, path, nil, "User-Agent", browserAgent); got.Code != http.StatusForbidden ||
			refusalOf(t, got) != reasonNotTheApp {
			t.Errorf("%s from a browser answered %d %q, want 403 not_the_app", path, got.Code, refusalOf(t, got))
		}
	}
}

// A Mac line pasted into the iOS list, naming a disk image that is in the
// directory, is the right size and hashes to what the line says. Every check
// a file is put to passes, and the phone must still be handed nothing and told
// nothing of it but the version.
func TestALineInTheIOSListThatNamesAFileHandsNothingOver(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"mac": {{version: "0.1.0.8", file: "Tomoshibi-0.1.0.8.dmg", contents: dmg}},
		"ios": {{version: "0.1.0.8", file: "Tomoshibi-0.1.0.8.dmg", contents: dmg}},
	})
	mux, _, _ := appsApp(t, desk(t, nil, dir))

	got := appsGet(mux, "/api/apps/latest/ios", nil, "User-Agent", updatingIPhone)
	if got.Code != http.StatusOK || updateOf(t, got).Version != "0.1.0.8" {
		t.Fatalf("answered %d %s, want the version", got.Code, got.Body.String())
	}

	for _, field := range []string{"size", "sha256"} {
		if value, said := fieldsOf(t, got)[field]; said {
			t.Errorf("a line naming the disk image had its %s of %s passed on to the phone", field, value)
		}
	}

	file := appsGet(mux, "/api/apps/latest/ios/file", nil, "User-Agent", updatingIPhone)
	if file.Code != http.StatusNotFound || bytes.Equal(file.Body.Bytes(), dmg) {
		t.Errorf("the iOS app's file answered %d with %d bytes; a disk image was handed to a phone",
			file.Code, file.Body.Len())
	}

	if mac := appsGet(mux, "/api/apps/latest/mac/file", nil, "User-Agent", updatingApp); mac.Code != http.StatusOK ||
		!bytes.Equal(mac.Body.Bytes(), dmg) {
		t.Errorf("the Mac's own build answered %d with %d bytes beside it", mac.Code, mac.Body.Len())
	}
}

// An iOS list written wrongly is no build for iOS, as a broken list is for any
// platform, and every other platform's update is answered as it was.
func TestAnIOSListThatCannotBeOfferedIsNoBuildAndCostsTheOthersNothing(t *testing.T) {
	for name, typed := range map[string]string{
		"no list at all":               "",
		"an empty list":                `[]`,
		"a null":                       `null`,
		"not a list":                   `"0.1.0.9"`,
		"an object instead of a list":  `{"version": "0.1.0.9"}`,
		"a line that is not an object": `["0.1.0.9"]`,
		"a line with no version":       `[{"notes": {"en": "Fixed the small window"}}]`,
		"an empty version":             `[{"version": ""}]`,
		"a version that is a number":   `[{"version": 9}]`,
		"a version that is not one":    `[{"version": "v0.1.0.9"}]`,
		"a version with a space":       `[{"version": "0.1.0 (9)"}]`,
		"a version with a quote":       `[{"version": "0.1.0.9\"x"}]`,
	} {
		t.Run(name, func(t *testing.T) {
			lists := map[string][]build{}
			for _, one := range platforms {
				lists[one.section] = []build{{version: "1.0.0", file: "a" + one.suffix, contents: contentsOf(one.section)}}
			}

			dir := appsDirectory(t, lists)
			if typed != "" {
				rewrite(t, dir, "ios", typed)
			}

			mux, _, cookie := appsApp(t, desk(t, nil, dir))

			for _, path := range []string{"/api/apps/latest/ios", "/api/apps/latest/ios/file"} {
				got := appsGet(mux, path, nil, "User-Agent", updatingIPhone)
				if got.Code != http.StatusNotFound || refusalOf(t, got) != reasonNoBuild {
					t.Errorf("%s answered %d %q, want 404 no_build", path, got.Code, refusalOf(t, got))
				}
			}

			for _, kept := range platforms {
				got := appsGet(mux, "/api/apps/latest/"+kept.section, nil, "User-Agent", updatingApp)
				if got.Code != http.StatusOK || updateOf(t, got).Version != "1.0.0" {
					t.Errorf("the %s update answered %d %s beside a broken iOS list", kept.section, got.Code, got.Body.String())
				}

				if file := appsGet(mux, "/api/apps/latest/"+kept.section+"/file", nil, "User-Agent", updatingApp); file.Code != http.StatusOK {
					t.Errorf("the %s build answered %d beside a broken iOS list", kept.section, file.Code)
				}
			}

			view := offered(t, appsGet(mux, "/api/apps", cookie))
			for _, kept := range platforms {
				if !kept.view(view).Available {
					t.Errorf("a broken iOS list took the %s build off the page: %+v", kept.section, view)
				}
			}
		})
	}

	// Within the list as well: lines that cannot be offered are passed over for
	// the good one beside them, even where they say a higher version, and notes
	// written wrongly cost the notes and not the version.
	dir := appsDirectory(t, map[string][]build{"ios": nil})
	rewrite(t, dir, "ios", `[{"version": "v9.0.0"}, {"notes": {"en": "no version"}}, {"version": 10},
		{"version": "0.1.0.9", "notes": "Fixed the small window"}]`)

	mux, _, _ := appsApp(t, desk(t, nil, dir))

	got := appsGet(mux, "/api/apps/latest/ios", nil, "User-Agent", updatingIPhone)
	if got.Code != http.StatusOK {
		t.Fatalf("lines that cannot be offered hid the good one beside them: %d %s", got.Code, got.Body.String())
	}

	if view := updateOf(t, got); view.Version != "0.1.0.9" || view.Notes != nil {
		t.Errorf("told %+v; want 0.1.0.9 with no notes", view)
	}
}

/*
The Mac's crossing from versions of four numbers to versions of three
(updates.go, versionFor).

A Mac from before 0.1.2 checks a downloaded build's version with its build
number joined on, and a Mac from 0.1.2 checks the version alone. Told the
wrong one, either fails without anybody seeing: the old installer refuses the
build it downloaded as not the one offered, and the new app is offered a
version newer than itself on every check and refuses that too. So each is told
the version its own installer will find, from the one line, with the one file;
and nothing else in the manifest, on any platform, is changed by it.
*/

// The user agents of a Mac either side of 0.1.2, as the core writes them
// (core/protocol/src/api/agent.rs).
const (
	updatingOldMac = "Tomoshibi/0.1.0.10 (Mac; macOS 26.6; Mac16,7)"
	updatingNewMac = "Tomoshibi/0.1.2 (Mac; macOS 26.6; Mac16,7)"
	// The Macs that compare the version and the build each, the first build of
	// 0.1.4 and a later one, as version_with_build joins them; and the last
	// Mac to check the version alone.
	updatingMac013  = "Tomoshibi/0.1.3 (Mac; macOS 26.6; Mac16,7)"
	updatingMac014  = "Tomoshibi/0.1.4 (Mac; macOS 26.6; Mac16,7)"
	updatingMac0142 = "Tomoshibi/0.1.4.2 (Mac; macOS 26.6; Mac16,7)"
)

// lineOf is one manifest line as typed: a version and a file, the size and
// hash of the contents given, and a build as typed, left out where it is empty.
func lineOf(version, file string, contents []byte, typed string) string {
	digest := sha256.Sum256(contents)

	build := ""
	if typed != "" {
		build = `, "build": ` + typed
	}

	return fmt.Sprintf(`{"version": %q, "file": %q, "size": %d, "sha256": %q%s}`,
		version, file, len(contents), hex.EncodeToString(digest[:]), build)
}

// macWithBuild is a directory whose Mac list is 0.1.2 alone, with its build
// typed as given.
func macWithBuild(t *testing.T, typed string) string {
	t.Helper()

	dir := appsDirectory(t, map[string][]build{
		"mac": {{version: "0.1.2", file: "Tomoshibi-0.1.2.dmg", contents: dmg}},
	})
	rewrite(t, dir, "mac", "["+lineOf("0.1.2", "Tomoshibi-0.1.2.dmg", dmg, typed)+"]")

	return dir
}

func TestAMacFromBefore012IsToldTheVersionWithItsBuild(t *testing.T) {
	digest := sha256.Sum256(dmg)
	sum := hex.EncodeToString(digest[:])

	for _, one := range []struct {
		name, agent, build, want string
	}{
		{"a Mac on 0.1.0.x", updatingOldMac, `"2"`, "0.1.2.2"},
		{"a Mac on 0.1.0.x, the build written as a number", updatingOldMac, `2`, "0.1.2.2"},
		{"a Mac on 0.1.0.x that says nothing of its system", "Tomoshibi/0.1.0.10 (Mac)", `"2"`, "0.1.2.2"},
		{"a Mac on 0.1.0.x, a first build joined on all the same", updatingOldMac, `"1"`, "0.1.2.1"},
		{"a Mac on 0.1.2", updatingNewMac, `"2"`, "0.1.2"},
		{"a Mac on 0.1.2, the build written as a number", updatingNewMac, `2`, "0.1.2"},
		{"a Mac on 0.1.3, which checks the version alone too", updatingMac013, `"2"`, "0.1.2"},
		{"a Mac on 0.1.4", updatingMac014, `"2"`, "0.1.2.2"},
		{"a Mac on 0.1.4, a first build", updatingMac014, `"1"`, "0.1.2"},
		{"a Mac on a later build of 0.1.4", updatingMac0142, `"2"`, "0.1.2.2"},
		{"a Mac on a later build of 0.1.4, a first build not joined on", updatingMac0142, `"1"`, "0.1.2"},
		{"a Mac on 0.1.0.x, the line with no build", updatingOldMac, ``, "0.1.2"},
		{"a Mac on 0.1.0.x, the build null", updatingOldMac, `null`, "0.1.2"},
		{"an Android app on four numbers", updatingApp, `"2"`, "0.1.2.2"},
		{"an iPhone on four numbers", updatingIPhone, `"2"`, "0.1.2.2"},
		{"a Windows app on four numbers", "Tomoshibi/0.1.0.1 (Windows)", `"2"`, "0.1.2.2"},
	} {
		t.Run(one.name, func(t *testing.T) {
			mux, _, _ := appsApp(t, desk(t, nil, macWithBuild(t, one.build)))

			got := appsGet(mux, "/api/apps/latest/mac", nil, "User-Agent", one.agent)
			if got.Code != http.StatusOK {
				t.Fatalf("answered %d %s", got.Code, got.Body.String())
			}

			view := updateOf(t, got)
			if view.Version != one.want {
				t.Errorf("%q was told %q, want %q", one.agent, view.Version, one.want)
			}
			if view.Size != int64(len(dmg)) || view.SHA256 != sum {
				t.Errorf("told %+v; the size and the hash are the build's whoever asks", view)
			}
		})
	}
}

// The two Macs are told different versions of one build and are handed that
// one build: the same bytes, saved under the same name, behind the same
// validator. The old installer checks the size and hash it was told, which
// are this build's.
func TestEitherMacIsHandedTheSameBuild(t *testing.T) {
	mux, _, cookie := appsApp(t, desk(t, nil, macWithBuild(t, `"2"`)))

	digest := sha256.Sum256(dmg)
	tag := `"` + hex.EncodeToString(digest[:]) + `"`

	told := map[string]string{}
	for _, agent := range []string{updatingOldMac, updatingNewMac} {
		latest := appsGet(mux, "/api/apps/latest/mac", nil, "User-Agent", agent)
		told[agent] = updateOf(t, latest).Version

		if vary := latest.Header().Get("Vary"); vary != "User-Agent" {
			t.Errorf("Vary is %q; a CDN that kept one Mac's answer would hand it to the other", vary)
		}

		file := appsGet(mux, "/api/apps/latest/mac/file", nil, "User-Agent", agent)
		if file.Code != http.StatusOK || !bytes.Equal(file.Body.Bytes(), dmg) {
			t.Errorf("%q was handed %d with %d bytes, want the build", agent, file.Code, file.Body.Len())
		}

		for header, value := range map[string]string{
			"Content-Disposition": `attachment; filename="Tomoshibi-0.1.2.dmg"`,
			"ETag":                tag,
		} {
			if got := file.Header().Get(header); got != value {
				t.Errorf("%q was handed the build with %s %q, want %q", agent, header, got, value)
			}
		}
	}

	if told[updatingOldMac] != "0.1.2.2" || told[updatingNewMac] != "0.1.2" {
		t.Errorf("told %v; want the Mac on 0.1.0.10 told 0.1.2.2 and the one on 0.1.2 told 0.1.2", told)
	}

	// And the page, which no installer reads, says it as people are told it,
	// the build in brackets.
	if page := offered(t, appsGet(mux, "/api/apps", cookie)).Mac; !page.Available || page.Version != "0.1.2 (2)" {
		t.Errorf("the page shows the Mac build as %+v, want 0.1.2 (2)", page)
	}
}

// The newest line is chosen by its own version, and its build is its own: a
// build neither moves a line ahead of another nor is lent to the line that
// is chosen.
func TestABuildDoesNotChooseTheNewestLine(t *testing.T) {
	other := []byte("another disk image, a different size from the first")

	for name, one := range map[string]struct {
		lines string
		want  string
	}{
		// 0.1.2 joined with its 9 would be 0.1.2.9, newer than 0.1.2.1.
		"a longer version against a shorter one with a build": {
			"[" + lineOf("0.1.2", "a.dmg", dmg, `"9"`) + "," + lineOf("0.1.2.1", "b.dmg", other, ``) + "]",
			"0.1.2.1",
		},
		// A tie goes to the later line, a correction appended, and the
		// earlier one's build stays with it.
		"a later line of the same version, with no build": {
			"[" + lineOf("0.1.2", "a.dmg", dmg, `"2"`) + "," + lineOf("0.1.2", "b.dmg", other, ``) + "]",
			"0.1.2",
		},
	} {
		t.Run(name, func(t *testing.T) {
			dir := appsDirectory(t, map[string][]build{
				"mac": {{version: "0.1.2", file: "a.dmg", contents: dmg}, {version: "0.1.2.1", file: "b.dmg", contents: other}},
			})
			rewrite(t, dir, "mac", one.lines)
			mux, _, _ := appsApp(t, desk(t, nil, dir))

			if got := updateOf(t, appsGet(mux, "/api/apps/latest/mac", nil, "User-Agent", updatingOldMac)); got.Version != one.want {
				t.Errorf("the Mac on 0.1.0.10 was told %q, want %q", got.Version, one.want)
			}

			if file := appsGet(mux, "/api/apps/latest/mac/file", nil, "User-Agent", updatingOldMac); !bytes.Equal(file.Body.Bytes(), other) {
				t.Errorf("handed %d bytes, want the build of the newer line", file.Body.Len())
			}
		})
	}
}

// A build on any other platform's line is joined on as the fourth part, for
// whoever asks and however many parts their own version has: Android, Windows
// and the iOS app never held a build to the Mac's old rules, and a later build
// of a version is newer than its first to every one of them. A first build is
// the version alone.
func TestABuildIsJoinedOnForEveryOtherPlatform(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"android": {{version: "0.1.2", file: "Tomoshibi-0.1.2.apk", contents: apk}},
		"windows": {{version: "0.1.2", file: "Tomoshibi-Setup-0.1.2.exe", contents: exe}},
	})
	rewrite(t, dir, "android", "["+lineOf("0.1.2", "Tomoshibi-0.1.2.apk", apk, `"2"`)+"]")
	rewrite(t, dir, "windows", "["+lineOf("0.1.2", "Tomoshibi-Setup-0.1.2.exe", exe, `2`)+"]")
	rewrite(t, dir, "ios", `[{"version": "0.1.2", "build": "2"}]`)

	mux, _, cookie := appsApp(t, desk(t, nil, dir))

	for _, section := range []string{"android", "windows", "ios"} {
		for _, agent := range []string{updatingOldMac, updatingMac014, updatingApp, updatingIPhone, "Tomoshibi/0.1.0.1 (Windows)"} {
			got := appsGet(mux, "/api/apps/latest/"+section, nil, "User-Agent", agent)
			if got.Code != http.StatusOK || updateOf(t, got).Version != "0.1.2.2" {
				t.Errorf("%s asked by %q answered %d %s, want 0.1.2.2", section, agent, got.Code, got.Body.String())
			}
		}
	}

	page := offered(t, appsGet(mux, "/api/apps", cookie))
	if page.Android.Version != "0.1.2 (2)" || page.Windows.Version != "0.1.2 (2)" {
		t.Errorf("the page shows %q and %q, want 0.1.2 (2) for both", page.Android.Version, page.Windows.Version)
	}

	rewrite(t, dir, "android", "["+lineOf("0.1.2", "Tomoshibi-0.1.2.apk", apk, `"1"`)+"]")
	if got := updateOf(t, appsGet(mux, "/api/apps/latest/android", nil, "User-Agent", updatingApp)); got.Version != "0.1.2" {
		t.Errorf("a first build was told as %q, want the version alone", got.Version)
	}
}

// A build written wrongly is read as none, and said: the Mac on 0.1.0.x is
// told the version as it is, and the build is still offered, on the page and
// as an update, whoever asks. A build that is fine, or not there, says
// nothing in the log.
func TestABuildWrittenWronglyIsNoneAndIsSaid(t *testing.T) {
	const said = "build is not a build number"

	for name, typed := range map[string]string{
		"negative":                  `-2`,
		"negative, in quotes":       `"-2"`,
		"with a point":              `2.5`,
		"with a point, in quotes":   `"2.2"`,
		"a whole number with point": `2.0`,
		"with an exponent":          `2e0`,
		"a word":                    `"two"`,
		"empty":                     `""`,
		"with a space":              `" 2"`,
		"too long to be a build":    `"1234567890"`,
		"true":                      `true`,
		"an object":                 `{"build": 2}`,
		"a list":                    `[2]`,
	} {
		t.Run(name, func(t *testing.T) {
			var logged bytes.Buffer
			was := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
			t.Cleanup(func() { slog.SetDefault(was) })

			mux, _, cookie := appsApp(t, desk(t, nil, macWithBuild(t, typed)))

			for _, agent := range []string{updatingOldMac, updatingNewMac} {
				got := appsGet(mux, "/api/apps/latest/mac", nil, "User-Agent", agent)
				if got.Code != http.StatusOK || updateOf(t, got).Version != "0.1.2" {
					t.Errorf("a build of %s, asked by %q, answered %d %s; want 0.1.2, the build as if it said none",
						typed, agent, got.Code, got.Body.String())
				}

				if file := appsGet(mux, "/api/apps/latest/mac/file", nil, "User-Agent", agent); file.Code != http.StatusOK ||
					!bytes.Equal(file.Body.Bytes(), dmg) {
					t.Errorf("a build of %s took the Mac's file away from %q: %d", typed, agent, file.Code)
				}
			}

			if page := offered(t, appsGet(mux, "/api/apps", cookie)).Mac; !page.Available || page.Version != "0.1.2" {
				t.Errorf("a build of %s took the Mac build off the page: %+v", typed, page)
			}

			if !strings.Contains(logged.String(), said) {
				t.Errorf("a build of %s was passed over without a word:\n%s", typed, logged.String())
			}
		})
	}

	for _, typed := range []string{``, `null`, `"2"`, `2`, `"0"`} {
		var logged bytes.Buffer
		was := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))

		mux, _, _ := appsApp(t, desk(t, nil, macWithBuild(t, typed)))
		appsGet(mux, "/api/apps/latest/mac", nil, "User-Agent", updatingOldMac)
		appsGet(mux, "/api/apps/latest/mac", nil, "User-Agent", updatingNewMac)

		slog.SetDefault(was)

		if strings.Contains(logged.String(), said) {
			t.Errorf("a build of %q, which is fine or not there, was said to be wrong:\n%s", typed, logged.String())
		}
	}
}
