package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/remote"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
	"tomoshibi/internal/testflight"
)

/*
The download page's five endpoints, through the router.

What would go wrong silently, and what each test below holds:

  - A gate missing from one of the five. The page is behind an account, and an
    endpoint that answered without one would hand a build, or an invitation in
    the deployment's name, to whoever found the address. The Windows download
    came last and is the easiest to have mounted without it.
  - A build offered before it is whole, or after it was replaced by something
    else. Either is a download that will not open, and the person holding it
    blames the app. The Mac, Android and Windows builds are held to this by the
    same tables, so that a rule cannot come to hold for one and not another.
  - One platform's mistake costing another its build. The three share a
    manifest, and a line typed wrongly in one list must leave the other lists
    offered.
  - The platforms' hashes evicting each other. The page asks after every one
    on every visit, and a memory with room for one would hash every file again
    every time while appearing to remember.
  - An invitation counted wrongly. Five per account is the only thing between
    one account and the app's whole tester ceiling; an address invited twice
    must not count twice, and a refusal from Apple must not count at all.
  - An address in the log. Every invitation is logged, and none of them may
    carry the address it was for.

App Store Connect itself is played by a fake behind the narrow interface the
handler holds. The requests the real client makes, the token it signs and the
409 path it follows are held by internal/testflight's own tests against a
stand-in that verifies every token; here, a fake that answers "already
invited" is what that path comes back as.
*/

// fakeTester plays App Store Connect at the level the handler talks to it.
type fakeTester struct {
	mu sync.Mutex
	// inGroup are the addresses Apple already has in the group, which is the
	// 409 path coming back as already invited.
	inGroup map[string]bool
	refuse  bool
	asked   []string
}

func (f *fakeTester) Invite(_ context.Context, email string) (testflight.Outcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.asked = append(f.asked, email)

	if f.refuse {
		return "", &testflight.Refused{Status: http.StatusForbidden, Code: "FORBIDDEN_ERROR"}
	}

	if f.inGroup[email] {
		return testflight.AlreadyInvited, nil
	}

	f.inGroup[email] = true

	return testflight.Sent, nil
}

func (f *fakeTester) times() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return len(f.asked)
}

// generous is a budget nobody in a test reaches, for the tests that are about
// something else.
func generous() *limit.Limiter { return limit.New(1000, 1000, 0) }

// appsApp is a control node with the download endpoints, one account signed
// in, and the desk given.
func appsApp(t *testing.T, desk *appsDesk) (http.Handler, *store.Store, *http.Cookie) {
	t.Helper()

	_, st, app := controlWithStore(t, config.PickProbe)
	app.apps = desk

	cookie := signedInAs(t, st, "tess", room.Trip(tripKey, "tess's own passphrase"))

	return app.Handler(), st, cookie
}

func desk(t *testing.T, fake tester, dir string) *appsDesk {
	t.Helper()

	return &appsDesk{dir: dir, tester: fake, byCaller: generous(), byAccount: generous(), remote: remote.At(dir)}
}

// build is one file to put in a directory, and what its manifest says.
type build struct {
	version, file string
	contents      []byte
	// size and sum, where set, are what the manifest claims instead of the
	// truth.
	size int64
	sum  string
}

// appsDirectory writes builds and a manifest describing them, a list for each
// platform named.
func appsDirectory(t *testing.T, lists map[string][]build) string {
	t.Helper()

	dir := t.TempDir()

	manifest := map[string][]map[string]any{}
	for section, builds := range lists {
		entries := []map[string]any{}

		for _, one := range builds {
			if one.contents != nil {
				if err := os.WriteFile(filepath.Join(dir, filepath.Base(one.file)), one.contents, 0o644); err != nil {
					t.Fatal(err)
				}
			}

			digest := sha256.Sum256(one.contents)
			sum := hex.EncodeToString(digest[:])
			if one.sum != "" {
				sum = one.sum
			}

			size := int64(len(one.contents))
			if one.size != 0 {
				size = one.size
			}

			entries = append(entries, map[string]any{
				"version": one.version, "file": one.file, "size": size, "sha256": sum,
			})
		}

		manifest[section] = entries
	}

	written, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(dir, manifestName), written, 0o644); err != nil {
		t.Fatal(err)
	}

	return dir
}

// macDirectory is a directory with Mac builds and nothing else.
func macDirectory(t *testing.T, builds ...build) string {
	t.Helper()

	return appsDirectory(t, map[string][]build{"mac": builds})
}

// rewrite replaces one list of a directory's manifest with JSON as typed,
// which is how a hand-edited manifest goes wrong.
func rewrite(t *testing.T, dir, section, typed string) {
	t.Helper()

	path := filepath.Join(dir, manifestName)

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	var lists map[string]json.RawMessage
	if err := json.Unmarshal(raw, &lists); err != nil {
		t.Fatal(err)
	}

	lists[section] = json.RawMessage(typed)

	written, err := json.Marshal(lists)
	if err != nil {
		t.Fatalf("the list typed for %s is not JSON at all: %v", section, err)
	}

	if err := os.WriteFile(path, written, 0o644); err != nil {
		t.Fatal(err)
	}
}

// walked is a platform as the tests below walk it: the list it is under, the
// address it is downloaded from, what its files end in, what the browser is
// to be told, and where the page's answer says it.
type walked struct {
	section, path, suffix, contentType string
	view                               func(appsView) buildView
}

var platforms = []walked{
	{"mac", "/api/apps/mac", ".dmg", "application/x-apple-diskimage",
		func(v appsView) buildView { return v.Mac }},
	{"android", "/api/apps/android", ".apk", "application/vnd.android.package-archive",
		func(v appsView) buildView { return v.Android }},
	{"windows", "/api/apps/windows", ".exe", "application/vnd.microsoft.portable-executable",
		func(v appsView) buildView { return v.Windows }},
}

// othersThan is every platform that is not this one.
func othersThan(one walked) []walked {
	var others []walked

	for _, other := range platforms {
		if other.section != one.section {
			others = append(others, other)
		}
	}

	return others
}

// contentsOf is something shaped like each platform's build, a different size
// for each, so that one handed over in place of another is told apart.
func contentsOf(section string) []byte {
	return map[string][]byte{"mac": dmg, "android": apk, "windows": exe}[section]
}

func appsGet(mux http.Handler, path string, cookie *http.Cookie, header ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	for i := 0; i+1 < len(header); i += 2 {
		request.Header.Set(header[i], header[i+1])
	}

	return ask(mux, request)
}

func invite(mux http.Handler, cookie *http.Cookie, email string, header ...string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"email": email})

	request := httptest.NewRequest(http.MethodPost, "/api/apps/ios/invite", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		request.AddCookie(cookie)
	}
	for i := 0; i+1 < len(header); i += 2 {
		request.Header.Set(header[i], header[i+1])
	}

	return ask(mux, request)
}

func refusalOf(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()

	var said struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &said)

	return said.Error
}

func offered(t *testing.T, recorder *httptest.ResponseRecorder) appsView {
	t.Helper()

	if recorder.Code != http.StatusOK {
		t.Fatalf("the page's question answered %d: %s", recorder.Code, recorder.Body)
	}

	var view appsView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatalf("the answer was not readable: %v", err)
	}

	return view
}

func invited(t *testing.T, recorder *httptest.ResponseRecorder) invitation {
	t.Helper()

	if recorder.Code != http.StatusOK {
		t.Fatalf("the invitation answered %d %s, want 200", recorder.Code, refusalOf(t, recorder))
	}

	var said invitation
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatalf("the answer was not readable: %v", err)
	}

	return said
}

var dmg = bytes.Repeat([]byte("a disk image, or something shaped like one. "), 2000)

var apk = bytes.Repeat([]byte("an Android package, or near enough. "), 1500)

var exe = bytes.Repeat([]byte("MZ, and then a Windows installer, more or less. "), 1200)

func TestNobodySignedOutReachesAnyOfTheApps(t *testing.T) {
	fake := &fakeTester{inGroup: map[string]bool{}}
	mux, _, _ := appsApp(t, desk(t, fake, appsDirectory(t, map[string][]build{
		"mac":     {{version: "1.0.0", file: "a.dmg", contents: dmg}},
		"android": {{version: "1.0.0", file: "a.apk", contents: apk}},
		"windows": {{version: "1.0.0", file: "a.exe", contents: exe}},
	})))

	for _, recorder := range []*httptest.ResponseRecorder{
		appsGet(mux, "/api/apps", nil),
		appsGet(mux, "/api/apps/mac", nil),
		appsGet(mux, "/api/apps/android", nil),
		appsGet(mux, "/api/apps/windows", nil),
		invite(mux, nil, "ada@example.com"),
	} {
		if recorder.Code != http.StatusUnauthorized || refusalOf(t, recorder) != reasonSignedOut {
			t.Errorf("signed out answered %d %q, want 401 %q",
				recorder.Code, refusalOf(t, recorder), reasonSignedOut)
		}
	}

	if fake.times() != 0 {
		t.Errorf("App Store Connect was asked %d times on behalf of nobody", fake.times())
	}
}

// The same-site check the other POST endpoints have. A page on a sibling
// subdomain posting here with the account's cookie must arrive unsigned:
// SameSite=Strict still sends the cookie from one.
func TestAnInvitationFromAnotherSiteArrivesSignedOut(t *testing.T) {
	fake := &fakeTester{inGroup: map[string]bool{}}
	mux, _, cookie := appsApp(t, desk(t, fake, ""))

	for _, site := range []string{"same-site", "cross-site"} {
		recorder := invite(mux, cookie, "ada@example.com", "Sec-Fetch-Site", site)
		if recorder.Code != http.StatusUnauthorized {
			t.Errorf("a %s invitation with a live cookie answered %d, want 401", site, recorder.Code)
		}
	}

	if fake.times() != 0 {
		t.Errorf("a page elsewhere spent an invitation: %v", fake.asked)
	}

	if got := invite(mux, cookie, "ada@example.com", "Sec-Fetch-Site", "same-origin").Code; got != http.StatusOK {
		t.Errorf("the page's own invitation answered %d", got)
	}
}

// The highest version is offered, compared as numbers: 1.10 is after 1.9,
// which a comparison of text would put the other way round.
func TestSignedInIsToldTheNewestBuild(t *testing.T) {
	dir := macDirectory(t,
		build{version: "1.10.0", file: "Tomoshibi-1.10.0.dmg", contents: dmg},
		build{version: "1.9.3", file: "Tomoshibi-1.9.3.dmg", contents: []byte("older")},
	)

	mux, _, cookie := appsApp(t, desk(t, &fakeTester{inGroup: map[string]bool{}}, dir))

	view := offered(t, appsGet(mux, "/api/apps", cookie))

	digest := sha256.Sum256(dmg)
	if !view.Mac.Available || view.Mac.Version != "1.10.0" || view.Mac.Size != int64(len(dmg)) ||
		view.Mac.SHA256 != hex.EncodeToString(digest[:]) {
		t.Errorf("the Mac build offered is %+v, want 1.10.0 at %d bytes", view.Mac, len(dmg))
	}

	if !view.IOS.Invites || view.IOS.Left != testersPerAccount {
		t.Errorf("invitations offered as %+v, want offered with %d left", view.IOS, testersPerAccount)
	}
}

func TestNothingConfiguredOffersNothing(t *testing.T) {
	mux, _, cookie := appsApp(t, desk(t, nil, ""))

	view := offered(t, appsGet(mux, "/api/apps", cookie))
	if view.Mac.Available || view.Android.Available || view.Windows.Available || view.IOS.Invites {
		t.Errorf("a deployment with nothing configured offered %+v", view)
	}

	for _, one := range platforms {
		recorder := appsGet(mux, one.path, cookie)
		if recorder.Code != http.StatusNotFound || refusalOf(t, recorder) != reasonNotAvailable {
			t.Errorf("%s with nothing to download answered %d %q", one.path, recorder.Code, refusalOf(t, recorder))
		}
	}
}

// A manifest with builds for the other platforms has none for this one, and
// says so, rather than offering one it has under this one's name.
func TestAPlatformWithNothingInTheManifestIsNotOffered(t *testing.T) {
	for _, one := range platforms {
		t.Run(one.section, func(t *testing.T) {
			lists := map[string][]build{}
			for _, other := range othersThan(one) {
				lists[other.section] = []build{{version: "3.0.0", file: "only" + other.suffix, contents: contentsOf(other.section)}}
			}

			dir := appsDirectory(t, lists)
			mux, _, cookie := appsApp(t, desk(t, nil, dir))

			view := offered(t, appsGet(mux, "/api/apps", cookie))
			if one.view(view).Available {
				t.Errorf("a manifest with no %s list offered %+v", one.section, one.view(view))
			}

			for _, other := range othersThan(one) {
				if !other.view(view).Available {
					t.Errorf("a manifest with no %s list did not offer the %s build it has", one.section, other.section)
				}
			}

			recorder := appsGet(mux, one.path, cookie)
			if recorder.Code != http.StatusNotFound || refusalOf(t, recorder) != reasonNotAvailable {
				t.Errorf("%s answered %d %q, want 404 %q", one.path, recorder.Code, refusalOf(t, recorder), reasonNotAvailable)
			}

			// And an empty list, or a null, is the same.
			for _, typed := range []string{`[]`, `null`} {
				rewrite(t, dir, one.section, typed)

				if code := appsGet(mux, one.path, cookie).Code; code != http.StatusNotFound {
					t.Errorf("a %s list of %s answered %d, want 404", one.section, typed, code)
				}
			}
		})
	}
}

// A build is offered only once it is the file its manifest describes, on
// either platform.
func TestABuildThatIsNotWhatItsManifestSaysIsNotOffered(t *testing.T) {
	for _, one := range platforms {
		entries := map[string]build{
			// A copy still in progress: the manifest written first, the file
			// arriving after.
			"still being copied": {version: "2.0.0", file: "b" + one.suffix, contents: dmg[:100], size: int64(len(dmg))},
			"replaced by another file": {version: "2.0.0", file: "b" + one.suffix, contents: dmg,
				sum: strings.Repeat("0", 64)},
			"not there at all":         {version: "2.0.0", file: "gone" + one.suffix},
			"named outside the folder": {version: "2.0.0", file: "../b" + one.suffix, contents: dmg},
			"not a build at all":       {version: "2.0.0", file: "b.zip", contents: dmg},
			"a version with a quote":   {version: `2.0.0"x`, file: "b" + one.suffix, contents: dmg},
		}

		// Another platform's suffix: a line pasted into the wrong list.
		for _, other := range othersThan(one) {
			entries["the "+other.section+" file"] = build{version: "2.0.0", file: "b" + other.suffix, contents: dmg}
		}

		for name, entry := range entries {
			t.Run(one.section+"/"+name, func(t *testing.T) {
				dir := appsDirectory(t, map[string][]build{one.section: {entry}})
				mux, _, cookie := appsApp(t, desk(t, nil, dir))

				if view := offered(t, appsGet(mux, "/api/apps", cookie)); one.view(view).Available {
					t.Errorf("offered %+v", one.view(view))
				}

				if code := appsGet(mux, one.path, cookie).Code; code != http.StatusNotFound {
					t.Errorf("the download answered %d, want 404", code)
				}
			})
		}
	}
}

// Every platform's build handed over the same way: the bytes, under the
// version's name and the platform's type, private to the account, resumable,
// and logged once for a whole file rather than once for every piece of it.
func TestEachBuildStreamsUnderItsVersion(t *testing.T) {
	for _, one := range platforms {
		t.Run(one.section, func(t *testing.T) {
			var logged bytes.Buffer
			was := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
			t.Cleanup(func() { slog.SetDefault(was) })

			body := contentsOf(one.section)

			dir := appsDirectory(t, map[string][]build{
				one.section: {{version: "0.1.0.6", file: "build-4471" + one.suffix, contents: body}},
			})
			mux, _, cookie := appsApp(t, desk(t, nil, dir))

			digest := sha256.Sum256(body)
			tag := `"` + hex.EncodeToString(digest[:]) + `"`

			recorder := appsGet(mux, one.path, cookie)
			if recorder.Code != http.StatusOK {
				t.Fatalf("the download answered %d", recorder.Code)
			}

			want := map[string]string{
				"Content-Disposition":    `attachment; filename="Tomoshibi-0.1.0.6` + one.suffix + `"`,
				"Content-Type":           one.contentType,
				"Content-Length":         fmt.Sprint(len(body)),
				"Accept-Ranges":          "bytes",
				"X-Content-Type-Options": "nosniff",
				"ETag":                   tag,
				// Never kept by a cache in front, which would hand it to the
				// next person who asks whether or not they are signed in.
				"Cache-Control": "private, no-cache",
			}
			for header, value := range want {
				if got := recorder.Header().Get(header); got != value {
					t.Errorf("%s is %q, want %q", header, got, value)
				}
			}

			if !bytes.Equal(recorder.Body.Bytes(), body) {
				t.Errorf("the body is %d bytes and not the build", recorder.Body.Len())
			}

			// And resumed from where a dropped download stopped, while the
			// build is still the one it started on.
			partial := appsGet(mux, one.path, cookie, "Range", "bytes=100-199", "If-Range", tag)
			if partial.Code != http.StatusPartialContent || !bytes.Equal(partial.Body.Bytes(), body[100:200]) {
				t.Errorf("a range answered %d with %d bytes", partial.Code, partial.Body.Len())
			}

			// One line for the whole file and none for the piece of it, so
			// that the log counts downloads rather than the reconnections of
			// one.
			line := "handed over the " + map[string]string{"mac": "Mac", "android": "Android", "windows": "Windows"}[one.section] + " app"
			if got := strings.Count(logged.String(), line); got != 1 {
				t.Errorf("the log says %q %d times for one whole download and one piece:\n%s",
					line, got, logged.String())
			}

			// A resume that began on another build is given this one whole.
			stale := appsGet(mux, one.path, cookie, "Range", "bytes=100-199", "If-Range", `"`+strings.Repeat("0", 64)+`"`)
			if stale.Code != http.StatusOK || !bytes.Equal(stale.Body.Bytes(), body) {
				t.Errorf("a resume begun on another build answered %d with %d bytes, want the whole build",
					stale.Code, stale.Body.Len())
			}
		})
	}
}

// One manifest, every platform, each offered with its own build and each
// download handing over its own file.
func TestEveryPlatformIsOfferedFromOneManifest(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"mac": {
			{version: "0.1.0.6", file: "Tomoshibi-0.1.0.6.dmg", contents: dmg},
			{version: "0.1.0.5", file: "Tomoshibi-0.1.0.5.dmg", contents: []byte("older")},
		},
		"android": {
			{version: "0.1.0.10", file: "Tomoshibi-0.1.0.10.apk", contents: apk},
			{version: "0.1.0.9", file: "Tomoshibi-0.1.0.9.apk", contents: []byte("older")},
		},
		"windows": {
			{version: "0.1.0.2", file: "Tomoshibi-Setup-0.1.0.2.exe", contents: exe},
			{version: "0.1.0.1", file: "Tomoshibi-Setup-0.1.0.1.exe", contents: []byte("older")},
		},
	})
	mux, _, cookie := appsApp(t, desk(t, nil, dir))

	view := offered(t, appsGet(mux, "/api/apps", cookie))

	macSum, apkSum, exeSum := sha256.Sum256(dmg), sha256.Sum256(apk), sha256.Sum256(exe)

	if want := (buildView{Available: true, Version: "0.1.0.6", Size: int64(len(dmg)),
		SHA256: hex.EncodeToString(macSum[:])}); view.Mac != want {
		t.Errorf("the Mac build offered is %+v, want %+v", view.Mac, want)
	}

	if want := (buildView{Available: true, Version: "0.1.0.10", Size: int64(len(apk)),
		SHA256: hex.EncodeToString(apkSum[:])}); view.Android != want {
		t.Errorf("the Android build offered is %+v, want %+v", view.Android, want)
	}

	if got := appsGet(mux, "/api/apps/mac", cookie); !bytes.Equal(got.Body.Bytes(), dmg) {
		t.Errorf("the Mac download handed over %d bytes that are not the disk image", got.Body.Len())
	}

	if got := appsGet(mux, "/api/apps/android", cookie); !bytes.Equal(got.Body.Bytes(), apk) {
		t.Errorf("the Android download handed over %d bytes that are not the package", got.Body.Len())
	}

	if want := (buildView{Available: true, Version: "0.1.0.2", Size: int64(len(exe)),
		SHA256: hex.EncodeToString(exeSum[:])}); view.Windows != want {
		t.Errorf("the Windows build offered is %+v, want %+v", view.Windows, want)
	}

	// Saved under the version, as the others are, whatever the installer in
	// the directory is called.
	got := appsGet(mux, "/api/apps/windows", cookie)
	if !bytes.Equal(got.Body.Bytes(), exe) {
		t.Errorf("the Windows download handed over %d bytes that are not the installer", got.Body.Len())
	}

	if saved := got.Header().Get("Content-Disposition"); saved != `attachment; filename="Tomoshibi-0.1.0.2.exe"` {
		t.Errorf("the Windows installer is saved as %q", saved)
	}
}

// A mistake in one platform's list takes that platform's build off the page
// and leaves the others'. Each of these failed the whole manifest when it was
// decoded into one struct, and the Mac build went with the Android line.
func TestOneBrokenListDoesNotHideTheOthers(t *testing.T) {
	for _, broken := range platforms {
		for name, typed := range map[string]string{
			"not a list":                  `"Tomoshibi-2.0.0` + broken.suffix + `"`,
			"an object instead of a list": `{"version": "2.0.0", "file": "b` + broken.suffix + `"}`,
			"a size in quotes":            `[{"version": "2.0.0", "file": "b` + broken.suffix + `", "size": "12", "sha256": "` + strings.Repeat("a", 64) + `"}]`,
			"a version that is a number":  `[{"version": 2, "file": "b` + broken.suffix + `", "size": 12, "sha256": "` + strings.Repeat("a", 64) + `"}]`,
		} {
			t.Run(broken.section+"/"+name, func(t *testing.T) {
				lists := map[string][]build{}
				for _, one := range platforms {
					lists[one.section] = []build{{version: "1.0.0", file: "a" + one.suffix, contents: contentsOf(one.section)}}
				}

				dir := appsDirectory(t, lists)
				rewrite(t, dir, broken.section, typed)

				mux, _, cookie := appsApp(t, desk(t, nil, dir))
				view := offered(t, appsGet(mux, "/api/apps", cookie))

				for _, kept := range othersThan(broken) {
					if !kept.view(view).Available {
						t.Errorf("a broken %s list took the %s build off the page: %+v", broken.section, kept.section, view)
					}

					if code := appsGet(mux, kept.path, cookie).Code; code != http.StatusOK {
						t.Errorf("%s answered %d beside a broken %s list", kept.path, code, broken.section)
					}
				}

				if broken.view(view).Available {
					t.Errorf("the broken %s list offered %+v", broken.section, broken.view(view))
				}
			})
		}
	}

	// Within one list as well: a line that cannot be read is passed over and
	// the good line beside it is offered.
	dir := appsDirectory(t, map[string][]build{"android": nil})
	if err := os.WriteFile(filepath.Join(dir, "a.apk"), apk, 0o644); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(apk)
	rewrite(t, dir, "android", `[{"version": "9.0.0", "file": "z.apk", "size": "12"},
		{"version": "1.0.0", "file": "a.apk", "size": `+fmt.Sprint(len(apk))+`, "sha256": "`+hex.EncodeToString(digest[:])+`"}]`)

	mux, _, cookie := appsApp(t, desk(t, nil, dir))
	if view := offered(t, appsGet(mux, "/api/apps", cookie)); view.Android.Version != "1.0.0" {
		t.Errorf("a line that cannot be read hid the good one beside it: %+v", view.Android)
	}
}

// The manifest's iOS list is for the app's own updates (updates.go) and is
// nothing of the page's: the page offers the iOS app by TestFlight whatever the
// list says, and is answered word for word as it was without it. The list
// written here holds the likeliest mistake as well, a line naming the Mac's
// disk image, which is in the directory and checks out.
func TestAnIOSListLeavesThePageAsItWas(t *testing.T) {
	lists := map[string][]build{}
	for _, one := range platforms {
		lists[one.section] = []build{{version: "1.0.0", file: "a" + one.suffix, contents: contentsOf(one.section)}}
	}

	dir := appsDirectory(t, lists)

	d := desk(t, nil, dir)
	d.publicLink = "https://testflight.apple.com/join/AbCd1234"
	mux, _, cookie := appsApp(t, d)

	before := appsGet(mux, "/api/apps", cookie)
	offered(t, before)

	digest := sha256.Sum256(dmg)
	rewrite(t, dir, "ios", fmt.Sprintf(`[{"version": "9.9.9", "file": "a.dmg", "size": %d, "sha256": %q},
		{"version": "0.1.0.9", "notes": {"en": "Fixed the small window"}}]`, len(dmg), hex.EncodeToString(digest[:])))

	after := appsGet(mux, "/api/apps", cookie)
	if view := offered(t, after); view.IOS.Link != d.publicLink || view.IOS.Invites {
		t.Errorf("the page offers the iOS app as %+v beside an iOS list, want the public link", view.IOS)
	}

	if after.Body.String() != before.Body.String() {
		t.Errorf("an iOS list changed what the page is told:\nwithout it %s\nwith it    %s", before.Body, after.Body)
	}

	for _, one := range platforms {
		if got := appsGet(mux, one.path, cookie); got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), contentsOf(one.section)) {
			t.Errorf("%s answered %d with %d bytes beside an iOS list", one.path, got.Code, got.Body.Len())
		}
	}
}

// The ordinary case, and the address as Apple is given it: trimmed and
// lowercased, so that one person typed two ways is one tester.
func TestAnInvitationIsSent(t *testing.T) {
	fake := &fakeTester{inGroup: map[string]bool{}}
	mux, st, cookie := appsApp(t, desk(t, fake, ""))

	said := invited(t, invite(mux, cookie, "  Ada@Example.COM "))
	if said.Result != testflight.Sent || said.Left != testersPerAccount-1 {
		t.Errorf("a new address came to %+v", said)
	}

	if len(fake.asked) != 1 || fake.asked[0] != "ada@example.com" {
		t.Errorf("Apple was asked about %v", fake.asked)
	}

	list, _ := st.Testers(room.Trip(tripKey, "tess's own passphrase"))
	if len(list) != 1 || list[0].Address != "ada@example.com" || list[0].At.IsZero() {
		t.Errorf("the record is %+v", list)
	}
}

// Apple already has them in the group — the 409 path — and so does this
// account's record after; asked again, Apple is not asked at all.
func TestAnAddressAlreadyInvitedIsSaidSo(t *testing.T) {
	fake := &fakeTester{inGroup: map[string]bool{"ada@example.com": true}}
	mux, _, cookie := appsApp(t, desk(t, fake, ""))

	said := invited(t, invite(mux, cookie, "ada@example.com"))
	if said.Result != testflight.AlreadyInvited || said.Left != testersPerAccount-1 {
		t.Errorf("an address Apple already had came to %+v; it counts, since this account asked", said)
	}

	again := invited(t, invite(mux, cookie, "ADA@example.com"))
	if again.Result != testflight.AlreadyInvited || again.Left != testersPerAccount-1 {
		t.Errorf("the same address again came to %+v, and must not count twice", again)
	}

	if fake.times() != 1 {
		t.Errorf("Apple was asked %d times about one address", fake.times())
	}
}

func TestSomethingThatIsNotAnAddressIsRefusedBeforeAppleIsAsked(t *testing.T) {
	fake := &fakeTester{inGroup: map[string]bool{}}
	mux, _, cookie := appsApp(t, desk(t, fake, ""))

	for _, typed := range []string{
		"", "ada", "ada@", "@example.com", "ada@example", "ada@@example.com",
		"Ada <ada@example.com>", "ada lovelace@example.com", "ada@exa mple.com",
		".ada@example.com", "ada..l@example.com", "ada@-example.com", "ada@example.c",
		"ada@例え.jp", strings.Repeat("a", 65) + "@example.com",
	} {
		recorder := invite(mux, cookie, typed)
		if recorder.Code != http.StatusBadRequest || refusalOf(t, recorder) != reasonInvalidEmail {
			t.Errorf("%q answered %d %q, want 400 %q", typed, recorder.Code, refusalOf(t, recorder), reasonInvalidEmail)
		}
	}

	if fake.times() != 0 {
		t.Errorf("Apple was asked to judge %v", fake.asked)
	}

	for _, typed := range []string{"ada.lovelace+tf@mail.example.co.uk", "o'brien@example.ie"} {
		if code := invite(mux, cookie, typed).Code; code != http.StatusOK {
			t.Errorf("%q is an ordinary address and answered %d", typed, code)
		}
	}
}

func TestAnAccountMayInviteOnlySoMany(t *testing.T) {
	fake := &fakeTester{inGroup: map[string]bool{}}
	mux, _, cookie := appsApp(t, desk(t, fake, ""))

	for i := range testersPerAccount {
		said := invited(t, invite(mux, cookie, fmt.Sprintf("person%d@example.com", i)))
		if said.Left != testersPerAccount-1-i {
			t.Errorf("after %d, %d are said to be left", i+1, said.Left)
		}
	}

	recorder := invite(mux, cookie, "one.too.many@example.com")
	if recorder.Code != http.StatusForbidden || refusalOf(t, recorder) != reasonTooManyAddresses {
		t.Errorf("past the allowance answered %d %q, want 403 %q",
			recorder.Code, refusalOf(t, recorder), reasonTooManyAddresses)
	}

	if fake.times() != testersPerAccount {
		t.Errorf("Apple was asked %d times for an allowance of %d", fake.times(), testersPerAccount)
	}

	// One already invited is still answered: it is not a new tester.
	if said := invited(t, invite(mux, cookie, "person0@example.com")); said.Result != testflight.AlreadyInvited {
		t.Errorf("an address already counted, asked again at the limit, came to %+v", said)
	}

	view := offered(t, appsGet(mux, "/api/apps", cookie))
	if view.IOS.Left != 0 {
		t.Errorf("the page is told %d are left", view.IOS.Left)
	}
}

// By account and by address, and each budget on its own refuses.
func TestInvitationsAreRateLimitedByAccountAndByAddress(t *testing.T) {
	t.Run("by account", func(t *testing.T) {
		d := desk(t, &fakeTester{inGroup: map[string]bool{}}, "")
		d.byAccount = limit.New(0.0001, 1, 0)
		mux, _, cookie := appsApp(t, d)

		invited(t, invite(mux, cookie, "one@example.com"))

		recorder := invite(mux, cookie, "two@example.com")
		if recorder.Code != http.StatusTooManyRequests || refusalOf(t, recorder) != reasonRateLimited {
			t.Errorf("an account past its budget answered %d %q", recorder.Code, refusalOf(t, recorder))
		}
	})

	t.Run("by address", func(t *testing.T) {
		d := desk(t, &fakeTester{inGroup: map[string]bool{}}, "")
		d.byCaller = limit.New(0.0001, 1, 0)
		mux, st, cookie := appsApp(t, d)

		invited(t, invite(mux, cookie, "one@example.com"))

		// A second account from the same address finds the address spent.
		other := signedInAs(t, st, "otto", room.Trip(tripKey, "otto's own passphrase"))
		recorder := invite(mux, other, "two@example.com")
		if recorder.Code != http.StatusTooManyRequests || refusalOf(t, recorder) != reasonRateLimited {
			t.Errorf("a second account from a spent address answered %d %q", recorder.Code, refusalOf(t, recorder))
		}
	})
}

func TestInvitationsWithNoKeySayTheyAreNotConfigured(t *testing.T) {
	mux, _, cookie := appsApp(t, desk(t, nil, ""))

	recorder := invite(mux, cookie, "ada@example.com")
	if recorder.Code != http.StatusServiceUnavailable || refusalOf(t, recorder) != reasonNotConfigured {
		t.Errorf("no key answered %d %q, want 503 %q", recorder.Code, refusalOf(t, recorder), reasonNotConfigured)
	}
}

// A refusal is said, and costs the account nothing.
func TestARefusalFromAppleIsSaidAndNotCounted(t *testing.T) {
	fake := &fakeTester{inGroup: map[string]bool{}, refuse: true}
	mux, st, cookie := appsApp(t, desk(t, fake, ""))

	recorder := invite(mux, cookie, "ada@example.com")
	if recorder.Code != http.StatusBadGateway || refusalOf(t, recorder) != reasonTestFlightRefused {
		t.Errorf("Apple refusing answered %d %q, want 502 %q",
			recorder.Code, refusalOf(t, recorder), reasonTestFlightRefused)
	}

	if list, _ := st.Testers(room.Trip(tripKey, "tess's own passphrase")); len(list) != 0 {
		t.Errorf("a refused address was counted: %+v", list)
	}
}

// Every invitation is logged, by the account's signature and the outcome, and
// none of them by the address.
func TestTheLogNeverCarriesTheAddress(t *testing.T) {
	var logged bytes.Buffer
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
	t.Cleanup(func() { slog.SetDefault(was) })

	fake := &fakeTester{inGroup: map[string]bool{}}
	mux, _, cookie := appsApp(t, desk(t, fake, ""))

	invited(t, invite(mux, cookie, "ada.lovelace@example.com"))

	fake.refuse = true
	invite(mux, cookie, "grace.hopper@example.com")

	text := logged.String()
	if !strings.Contains(text, room.Trip(tripKey, "tess's own passphrase")) || !strings.Contains(text, "sent") {
		t.Errorf("the log does not say who invited and what came of it:\n%s", text)
	}

	for _, whole := range []string{"ada.lovelace", "grace.hopper"} {
		if strings.Contains(text, whole) {
			t.Errorf("the log carries %s:\n%s", whole, text)
		}
	}
}

// Changing one's own passphrase changes the signature the count is kept
// under. Without carrying it across, a new passphrase was a new five.
func TestAPassphraseChangeKeepsTheCount(t *testing.T) {
	fake := &fakeTester{inGroup: map[string]bool{}}
	mux, _, cookie := appsApp(t, desk(t, fake, ""))

	for i := range testersPerAccount {
		invited(t, invite(mux, cookie, fmt.Sprintf("person%d@example.com", i)))
	}

	change := httptest.NewRequest(http.MethodPost, "/api/account/passphrase",
		strings.NewReader(`{"current":"tess's own passphrase","next":"a different passphrase entirely"}`))
	change.AddCookie(cookie)

	if recorder := ask(mux, change); recorder.Code != http.StatusOK {
		t.Fatalf("the passphrase change answered %d %s", recorder.Code, recorder.Body)
	}

	if view := offered(t, appsGet(mux, "/api/apps", cookie)); view.IOS.Left != 0 {
		t.Errorf("after a passphrase change the account has %d invitations again", view.IOS.Left)
	}

	recorder := invite(mux, cookie, "fresh@example.com")
	if recorder.Code != http.StatusForbidden {
		t.Errorf("a new passphrase bought a new allowance: %d %s", recorder.Code, refusalOf(t, recorder))
	}
}

// The page's address is the account page's document, and refuses to be framed
// as that document does: a signed-in person's press on an invisible frame of
// this page would be an invitation sent in their name.
func TestTheDownloadPageIsTheAccountDocument(t *testing.T) {
	_, _, app := controlWithStore(t, config.PickProbe)
	app.apps = desk(t, nil, "")
	app.web = Web(fstest.MapFS{
		"index.html":   {Data: []byte("the meeting page")},
		"account.html": {Data: []byte("the account page")},
	})

	recorder := ask(app.Handler(), httptest.NewRequest(http.MethodGet, "/apps", nil))

	if recorder.Body.String() != "the account page" {
		t.Errorf("/apps served %q, want the account document", recorder.Body)
	}

	if got := recorder.Header().Get("Content-Security-Policy"); got != "frame-ancestors 'none'" {
		t.Errorf("/apps may be framed: Content-Security-Policy is %q", got)
	}
}

func TestADiskImageIsHashedOncePerFile(t *testing.T) {
	dir := macDirectory(t, build{version: "1.0.0", file: "a.dmg", contents: dmg})
	d := desk(t, nil, dir)

	for range 3 {
		if _, file, ok := d.open(platformMac); !ok {
			t.Fatal("a whole disk image was not offered")
		} else {
			_ = file.Close()
		}
	}

	first := d.verified[platformMac].key

	// Replaced in place by a file of the same size that is not the same file:
	// the remembered hash must not vouch for it.
	tampered := bytes.Clone(dmg)
	tampered[0] ^= 0xff
	if err := os.WriteFile(filepath.Join(dir, "a.dmg"), tampered, 0o644); err != nil {
		t.Fatal(err)
	}
	stamp(t, filepath.Join(dir, "a.dmg"))

	if _, _, ok := d.open(platformMac); ok {
		t.Error("a file replaced after it was checked was offered on the old file's hash")
	}

	if d.verified[platformMac].key == first {
		t.Error("the replacement was not hashed again")
	}
}

// The page asks after every build on every visit. Each platform's check must
// be remembered apart from the others', or each evicts the last and every
// visit hashes every file again.
func TestEachPlatformsHashIsRememberedApart(t *testing.T) {
	dir := appsDirectory(t, map[string][]build{
		"mac":     {{version: "1.0.0", file: "a.dmg", contents: dmg}},
		"android": {{version: "1.0.0", file: "a.apk", contents: apk}},
		"windows": {{version: "1.0.0", file: "a.exe", contents: exe}},
	})
	d := desk(t, nil, dir)
	mux, _, cookie := appsApp(t, d)

	offered(t, appsGet(mux, "/api/apps", cookie))

	mac, android, windows := d.verified[platformMac].key, d.verified[platformAndroid].key, d.verified[platformWindows].key
	if !strings.Contains(mac, "a.dmg") || !strings.Contains(android, "a.apk") || !strings.Contains(windows, "a.exe") {
		t.Fatalf("after one visit the Mac's memory holds %q, Android's %q and Windows' %q", mac, android, windows)
	}

	for range 3 {
		offered(t, appsGet(mux, "/api/apps", cookie))
		appsGet(mux, "/api/apps/android", cookie)
		appsGet(mux, "/api/apps/windows", cookie)

		if d.verified[platformMac].key != mac || d.verified[platformAndroid].key != android {
			t.Fatalf("one platform's check evicted another's: the Mac's memory now holds %q and Android's %q",
				d.verified[platformMac].key, d.verified[platformAndroid].key)
		}
	}
}

// stamp moves a file's modification time on, which a rewrite within the same
// clock tick would not.
func stamp(t *testing.T, path string) {
	t.Helper()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	later := info.ModTime().Add(2e9)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
}
