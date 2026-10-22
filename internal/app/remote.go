package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"tomoshibi/internal/remote"
	"tomoshibi/internal/store"
)

/*
What the apps are told without a release of them: their words, which features
are off, a few numbers, and the lobby's notice.

	GET /api/apps/remote   everything in remote.json that holds for the app asking

The file and what it may hold are internal/remote's. What is here is the
answer, which is worked out for the app that asks rather than handed over
whole: a switch for Android 0.1.4 is applied here, so an app is told only
which features are off for itself, and the apps need not agree with this
server, or with each other, on how a rule is matched. Which app is asking is
read from its user agent (device.go), as the history reads it, and its version
is compared as the update check compares versions (newerVersion), so that a
rule written "below 0.1.5" means the versions the update check would offer
0.1.5 to.

Like the update check (updates.go), this needs no account: the lobby the notice
is for is the screen before anybody has signed in, and an app on an invitation
has no session at all. And like it, only the apps are answered, by the same
test and in the same words, so that the address pasted into a browser is not
a page.

An app that matched nothing is told nothing rather than everything: a rule for
some platforms holds for no app whose platform is not known, and a rule for
some versions for no app whose version is not. Both are narrower than they
were written and never wider, which is the side to err on for a rule that turns
something off.

The answer carries a revision, the first sixteen hex digits of the SHA-256 of
the rest of it written canonically, every object's keys in order and nothing
between the tokens, as encoding/json writes a map; so one answer is always the
same bytes and the same revision, which is also its ETag. An app that sends it back in If-None-Match is told 304
and nothing else, which is most of the checks an app makes.
*/

// remoteAnswer is what an app is told, before its revision is worked out from
// it.
//
// Every field is always there, as an empty object or list where there is
// nothing, and the notice as null: an app reading the answer need not tell
// "nothing" from "not said", and a cached answer is replaced whole rather than
// merged with the last.
//
// The fields are in the order of their names, and so are the notice's
// (remote.Notice), because the revision is the hash of the answer with every
// object's keys in order and encoding/json writes a struct in the order it is
// declared. Declared as an app reads it, phrases first, the hash was of a form
// nobody could reproduce without this file, which a test worked out the
// canonical way and caught.
type remoteAnswer struct {
	Notice  *remote.Notice               `json:"notice"`
	Off     []string                     `json:"off"`
	Params  map[string]float64           `json:"params"`
	Phrases map[string]map[string]string `json:"phrases"`
}

// remoteView is the answer with its revision at the front.
type remoteView struct {
	Revision string `json:"revision"`
	remoteAnswer
}

func (a *App) remoteSettings(w http.ResponseWriter, r *http.Request) {
	if !fromTheApp(r) {
		fail(w, http.StatusForbidden, reasonNotTheApp)
		return
	}

	answer := tell(a.apps.remote.Read(), clientOf(r.UserAgent()), a.now())

	written, err := json.Marshal(answer)
	if err != nil {
		// Nothing in an answer can fail to encode, a number having been read
		// from JSON in the first place; said rather than assumed all the same.
		slog.Error("failed to write the apps' remote settings", "error", err)
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	sum := sha256.Sum256(written)
	revision := hex.EncodeToString(sum[:8])
	tag := `"` + revision + `"`

	// Never kept by the CDN in front, for the reasons the update check gives:
	// it would go on answering with a notice taken down, and answer a browser
	// with what it kept for an app. Varied by the user agent because two apps
	// are not told the same thing.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "User-Agent")
	w.Header().Set("ETag", tag)

	if alreadyHas(r.Header.Get("If-None-Match"), tag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	respond(w, remoteView{Revision: revision, remoteAnswer: answer})
}

// alreadyHas reports whether an If-None-Match names this answer. A list, a weak
// tag and a star are read as HTTP has them; the apps send the one tag they were
// given.
func alreadyHas(asked, tag string) bool {
	for _, one := range strings.Split(asked, ",") {
		one = strings.TrimSpace(one)
		if one == "*" || strings.TrimPrefix(one, "W/") == tag {
			return true
		}
	}

	return false
}

// tell works out what the file says to one app at one moment.
//
// The rules are taken in the file's order and each that holds for the app
// replaces what came before it for the same feature or number, so that the
// last one standing is the answer. A switch that says on takes a feature off
// the list rather than merely not adding it, which is what lets a narrower rule
// further down turn back on what a wider one turned off.
func tell(settings remote.Settings, client *store.Client, now time.Time) remoteAnswer {
	answer := remoteAnswer{
		Phrases: settings.Phrases,
		Off:     []string{},
		Params:  map[string]float64{},
	}

	if answer.Phrases == nil {
		answer.Phrases = map[string]map[string]string{}
	}

	off := map[string]bool{}
	for _, one := range settings.Switches {
		if holdsFor(one.Where, client) {
			off[one.Feature] = one.Off
		}
	}

	for feature, isOff := range off {
		if isOff {
			answer.Off = append(answer.Off, feature)
		}
	}

	sort.Strings(answer.Off)

	for _, one := range settings.Params {
		if holdsFor(one.Where, client) {
			answer.Params[one.Name] = one.Value
		}
	}

	// Over is the same as never published. An app that still has an ended
	// notice cached drops it at this answer, and one that was offline past
	// the end has the end itself to go by.
	if settings.Notice.Showing(now) {
		answer.Notice = settings.Notice
	}

	return answer
}

// holdsFor reports whether a rule is for an app: its platform among the rule's
// platforms, where the rule names any, and its version from the rule's from
// and below its below, where the rule says either.
//
// The bounds are the update check's comparison of dotted numbers, so 0.1.4.2,
// a later build of 0.1.4, is from 0.1.4 and below 0.1.5. One consequence is
// worth knowing when writing a rule: 0.1.4 is below 0.1.4.1, though the apps
// call both the first build of 0.1.4. A bound written to the build should be
// written with the build.
func holdsFor(where remote.Where, client *store.Client) bool {
	kind, version := "", ""
	if client != nil {
		kind, version = client.Kind, client.App
	}

	if len(where.Platforms) > 0 && !where.Matches(kind) {
		return false
	}

	if where.From == "" && where.Below == "" {
		return true
	}

	if version == "" {
		return false
	}

	if where.From != "" && newerVersion(where.From, version) {
		return false
	}

	if where.Below != "" && !newerVersion(where.Below, version) {
		return false
	}

	return true
}
