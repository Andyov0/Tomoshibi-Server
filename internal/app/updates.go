package app

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

/*
The apps asking for their own next version.

The Mac, Android and Windows apps look for a newer build when they start and
every few hours after, say so, and with the person's agreement download and
install it. The owner decided these need no account (2026-10-20): an app
somebody is using as a guest on an invitation has no session to show, and an
update that only reaches people who happen to be signed in leaves the rest on
whatever they first installed.

	GET /api/apps/latest/{platform}       the newest build's version, size, hash and notes
	GET /api/apps/latest/{platform}/file  the build itself, in ranges

What stands in for the account is that the request comes from one of the
apps: the user agent every app sends (core/protocol/src/api/agent.rs) begins
"Tomoshibi/". That is no secret and anybody can send it, so it is not what
keeps a build private; it is what stops these addresses working as a download
link pasted into a chat, which opens in a browser that says it is a browser.
The download page's own endpoints keep their account or invitation for that
reason, and the build an app is handed here is the one the page offers.

The same manifest and the same checks as the page (apps.go): the newest entry
for the platform, offered only when its file is there, is the size the
manifest says and hashes to what it says. An app checks size and hash again
after downloading, against what the first address told it, and installs
nothing that does not match.

The iOS app asks the first address as well, and is told a version and its
notes and nothing else. TestFlight installs it, so all the app can do with an
answer is say that a newer build is waiting there; the manifest's iOS list
says no more than that (apps.go), and its /file is no_build whatever the list
names, since a build handed to a phone from here is one it cannot install.
The answer leaves out the size and the hash rather than giving them as
nothing, so that no app reads a zero as a build to download.

One thing in an answer depends on which app asks. A Mac from before 0.1.2
checks a downloaded build by another rule from the Macs after it, and is told
the version that rule will find in the build (versionFor); the size, the hash
and the file are the same for both.
*/

// Refusals particular to updates. The spellings are the ones the apps were
// written against.
const (
	// reasonNotTheApp is a request that did not come from one of the apps.
	reasonNotTheApp = "not_the_app"

	// reasonNoBuild is a platform with nothing to offer: no such platform, no
	// list for it, or a file that does not match its manifest.
	reasonNoBuild = "no_build"
)

// updateView is what an app is told of the newest build.
//
// Size and SHA256 are left out for the iOS app, which has neither, and are
// never empty for the others: a file's entry without both is passed over
// before it gets here (offerable), so what the Mac, Android and Windows apps
// are told is what they were told before there was an iOS list.
type updateView struct {
	Platform string            `json:"platform"`
	Version  string            `json:"version"`
	Size     int64             `json:"size,omitempty"`
	SHA256   string            `json:"sha256,omitempty"`
	Notes    map[string]string `json:"notes,omitempty"`
}

// fromTheApp reports whether a request names itself as one of the apps.
func fromTheApp(r *http.Request) bool {
	return strings.HasPrefix(r.UserAgent(), "Tomoshibi/")
}

// updating finds the platform an update request is for and refuses one that
// is not from an app or names no platform.
func (a *App) updating(w http.ResponseWriter, r *http.Request) (platform, bool) {
	if !fromTheApp(r) {
		fail(w, http.StatusForbidden, reasonNotTheApp)
		return 0, false
	}

	for p, shelf := range shelves {
		if shelf.section == r.PathValue("platform") {
			return platform(p), true
		}
	}

	fail(w, http.StatusNotFound, reasonNoBuild)

	return 0, false
}

func (a *App) latest(w http.ResponseWriter, r *http.Request) {
	p, ok := a.updating(w, r)
	if !ok {
		return
	}

	release, ok := a.apps.release(p)
	if !ok {
		fail(w, http.StatusNotFound, reasonNoBuild)
		return
	}

	// Never kept by the CDN in front, which would otherwise go on answering
	// with the build before last for as long as it liked, and answer the
	// browser this refuses with what it kept for an app. Varied by the user
	// agent for that second reason, and because two Macs are not always told
	// the same version (versionFor).
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "User-Agent")

	respond(w, updateView{
		Platform: shelves[p].section,
		Version:  versionFor(p, release, r.UserAgent()),
		Size:     release.Size,
		SHA256:   release.SHA256,
		Notes:    notesOf(release.Notes),
	})
}

/*
versionFor is the version an app is told its newest build is: the line's
version with its build joined on the way the apps now call themselves, except
to the Macs whose installers hold a build to another rule.

From 0.1.4 every app calls itself by its version and, for any build after the
first, its build as a fourth part: 0.1.4, then 0.1.4.2, 0.1.4.3 (the owner,
2026-10-22: a small fix keeps the version and takes the next build; a new
version is for new features or a large update). The native repository's core
joins them (version_with_build) and the apps say them as "0.1.4 (2)". So a line
of 0.1.4 with build 2 is offered as 0.1.4.2, which the update check finds newer
than 0.1.4 by its rule of dotted numbers, and the first build as 0.1.4 alone,
which is what every app out there compares and installs as 0.1.4.

Two kinds of Mac are told something else, because each Mac's installer holds a
downloaded build to the version it was told, and told the wrong one it installs
nothing and is offered the same again on every check:

  - A Mac from before 0.1.2 called itself by its marketing version and its
    build joined, 0.1.0.10, and its installer wants exactly the new app's
    CFBundleShortVersionString and CFBundleVersion joined by a dot. It is told
    the version with the build always joined on, 0.1.4.1 for a first build.
  - A Mac on 0.1.2 or 0.1.3 calls itself and checks a build by the marketing
    version alone, and would refuse 0.1.4.2 as not the 0.1.4 it finds. It is
    told the version alone, and finding 0.1.4 installs the newest build there
    is of it.

From 0.1.4 a Mac's installer compares the version and the build each (a missing
fourth part is the first build), so either form would do; it is told the
joined one, like every other app.

The size, the hash and the file are the same build's whoever asks; the newest
line is still chosen by its own version (newest), a platform's list holding one
line for each version; and a build written wrongly is said and read as none
(buildOf), which offers that line as its first build.
*/
func versionFor(p platform, release appRelease, agent string) string {
	build := buildOf(release.Build)

	if client := clientOf(agent); p == platformMac && client != nil && client.Kind == "mac" {
		switch {
		case joinedVersion.MatchString(client.App) && newerVersion("0.1.2", client.App):
			if build == "" {
				return release.Version
			}
			return release.Version + "." + build
		case newerVersion("0.1.4", client.App):
			return release.Version
		}
	}

	return withBuild(release.Version, build)
}

// withBuild is a version as the apps from 0.1.4 call themselves: the version
// alone for the first build (no build, or build 1), the build as a fourth part
// for every later one. As the core's version_with_build.
func withBuild(version, build string) string {
	if n, err := strconv.Atoi(build); err == nil && n > 1 {
		return version + "." + build
	}

	return version
}

// labelOf is a line's version as people are told it, as the core's
// version_label writes it: "0.1.4 (2)" for a later build, the version alone
// for the first.
func labelOf(release appRelease) string {
	if joined := withBuild(release.Version, buildOf(release.Build)); joined != release.Version {
		return release.Version + " (" + joined[len(release.Version)+1:] + ")"
	}

	return release.Version
}

// joinedVersion is how a Mac from before 0.1.2 calls itself in its user
// agent: four dotted numbers, its marketing version's three and its build.
var joinedVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$`)

// buildNumber is what a line's build may be: the app's build number (on the
// Mac and the iPhone its CFBundleVersion), digits alone, and few enough of them
// that whatever reads the joined version as numbers can.
var buildNumber = regexp.MustCompile(`^[0-9]{1,9}$`)

// buildOf reads a line's build, written as a string or as a number, "2" or 2,
// and is empty where the line says none. One that is not a build number —
// negative, with a point in it, a word, anything but digits — is said and read
// as none, so that the line is still offered, as its version's first build.
func buildOf(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}

	// A number is kept as it was written, so that 2.0 or 2e0 is refused
	// rather than guessed to mean 2: the installer compares text, and a build
	// that is not plainly the build's own CFBundleVersion is better said in
	// the log than guessed at.
	said := string(raw)
	if raw[0] == '"' && json.Unmarshal(raw, &said) != nil {
		said = ""
	}

	if !buildNumber.MatchString(said) {
		slog.Warn("a line's build is not a build number, so the line is offered as its version's first build",
			"build", string(raw))
		return ""
	}

	return said
}

func (a *App) latestFile(w http.ResponseWriter, r *http.Request) {
	p, ok := a.updating(w, r)
	if !ok {
		return
	}

	shelf := shelves[p]

	// The iOS app's is no_build here too: open finds no file for an app
	// installed elsewhere.
	release, file, ok := a.apps.open(p)
	if !ok {
		fail(w, http.StatusNotFound, reasonNoBuild)
		return
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		fail(w, http.StatusNotFound, reasonNoBuild)
		return
	}

	w.Header().Set("Content-Type", shelf.contentType)
	w.Header().Set("Content-Disposition", `attachment; filename="Tomoshibi-`+release.Version+shelf.suffix+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "User-Agent")

	// The hash as the validator, as on the page: an update resumed with
	// If-Range after a newer build was copied in starts again rather than
	// splicing the end of one build onto the start of another, which the app
	// would refuse at the hash and download again from nothing anyway.
	w.Header().Set("ETag", `"`+release.SHA256+`"`)

	// Said once per download rather than once per range, and with the
	// version the app came from, which is what anybody reading this wants to
	// know: how many are still on what.
	if r.Header.Get("Range") == "" {
		from := ""
		if client := clientOf(r.UserAgent()); client != nil {
			from = client.App
		}
		slog.Info("handed over the "+shelf.called+" app as an update", "version", release.Version, "from", from)
	}

	http.ServeContent(w, r, "", info.ModTime(), file)
}

// What a note may be keyed by: a language tag, as the apps' dictionaries are.
var noteLanguage = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z]{2,4})?$`)

// How long one language's note may be. An update's notes are a few lines; a
// manifest with a novel in it is a mistake, and the app has a banner to fit
// them in.
const noteLength = 2000

// notesOf reads an entry's notes, keeping what can be shown and passing over
// what cannot. A note written wrongly costs its own language, or all of the
// notes, and never the build.
func notesOf(raw json.RawMessage) map[string]string {
	if len(raw) == 0 {
		return nil
	}

	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		slog.Warn("an update's notes are not an object of languages, so none are shown", "error", err)
		return nil
	}

	kept := make(map[string]string, len(all))
	for language, value := range all {
		var note string
		if !noteLanguage.MatchString(language) || json.Unmarshal(value, &note) != nil {
			continue
		}

		note = strings.TrimSpace(note)
		if note == "" {
			continue
		}

		if utf8.RuneCountInString(note) > noteLength {
			note = string([]rune(note)[:noteLength])
		}

		kept[language] = note
	}

	if len(kept) == 0 {
		return nil
	}

	return kept
}
