package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/remote"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
	"tomoshibi/internal/testflight"
)

/*
Getting the native apps, for somebody signed in or somebody holding a link into
a meeting.

The apps are in no store. The Mac app is a disk image, the Android app a
package and the Windows app an installer, all handed over by this server from a
directory, and the iOS app is TestFlight, which installs for an address Apple
has been asked to invite or for whoever opens the beta's public link. They are behind something for the same
reason the client's own features are: a download link anybody can reach is one
posted everywhere, and every TestFlight tester is counted against a ceiling
Apple sets for the app.

That something is an account, or an invitation. Who has an account here is a
decision somebody made, and so is who holds an invitation: a host made the link
for a meeting and sent it to the people meant to be in it, and the page that
link opens offers them the app before the meeting, the way any meeting service
does. So a valid invitation or meeting link in the address — ?invite= or
?meeting=, as the page already has it — lets its holder ask what is offered and
download the Mac, Android and Windows builds, without an account. Valid is what the join
would make of it, asked by the same rules (heldLink, below), so a link that
would not let somebody into the meeting does not hand them the app either: one
revoked, run out, not open yet, made by somebody no longer in the scope, or
ignored at a door that asks for an account.

The iOS app goes the two ways TestFlight has. An account is invited by its
address, so that the testers are people this deployment can name — which is
the point of asking for an address at all. Somebody without an account has no
address here, and is offered the beta's public link instead, where one is
configured; that link has a ceiling of its own in App Store Connect. An account
on a deployment that cannot invite by address is offered the public link as
well, rather than nothing.

	GET  /api/apps             what the page shows: each build, and how the iOS app is offered
	GET  /api/apps/mac         the newest disk image itself
	GET  /api/apps/android     the newest Android package itself
	GET  /api/apps/windows     the newest Windows installer itself
	POST /api/apps/ios/invite  ask Apple to invite one address, for an account only

The first four take ?invite=<token> or ?meeting=<token> in place of a session,
and a download made that way is logged as one, with the room it was for.

The directory holds the builds and a manifest beside them, apps.json, with a
list for each platform whose app is a file, and one for the iOS app:

	{"mac":     [{"version": "1.2.0", "file": "Tomoshibi-1.2.0.dmg",
	              "size": 84213760, "sha256": "…64 hex digits…"}],
	 "android": [{"version": "1.2.0", "file": "Tomoshibi-1.2.0.apk",
	              "size": 31457280, "sha256": "…64 hex digits…"}],
	 "windows": [{"version": "1.2.0", "file": "Tomoshibi-Setup-1.2.0.exe",
	              "size": 41943040, "sha256": "…64 hex digits…"}],
	 "ios":     [{"version": "1.2.0"}]}

The iOS list is for the app's own updates and nothing else. TestFlight installs
that app, so its lines say which version is the newest there and what changed
in it, and nothing about a file: the download page goes on offering the iOS app
the two TestFlight ways described above, whatever the list says, and no file is
handed over for it anywhere. Any entry may also carry notes, by language, which
the apps show beside an update (updates.go). Any entry may carry its build
number as well, "build": "2" or 2: a later build of a version is offered as the
version with the build joined on, 0.1.4.2, and shown on the page as 0.1.4 (2)
(updates.go, versionFor). A list holds one entry for each version.

For each platform the entry with the highest version is offered, and only when
its file is there, is the size the manifest says, and hashes to what the
manifest says. A file still being copied in is the wrong size, and one replaced
by mistake hashes to something else; either is the page saying the app is not
available yet rather than handing somebody a file that will not open. The hash
is worked out once per file and remembered by its size and modification time,
because a build is tens of megabytes and the page asks after every one of them
on every visit.

Each platform's list is read on its own, and so is each entry in it. A list
that is missing, is not a list, or holds a line this server cannot read takes
that line or that platform off the page and nothing else: an Android line
written by hand with its size in quotes must not take the Mac or Windows build
away, nor either of those the others. Only a manifest that is not JSON at all
costs every platform, since then there is nothing to tell them apart by.

The manifest is read on every request rather than at startup, so a new build is
a file copied in and a manifest rewritten, and the server is not restarted for
it — a restart drops every call on a full deployment.

The invitation asks App Store Connect through a narrow interface (tester, below),
because a handler that held the real client could only be tested by inviting
somebody. Each account may have a handful of addresses invited, counted in the
store against its signature; an address it invited before is "already invited",
which is the truth and costs nothing to say again.
*/
// Refusals particular to the apps.
const (
	// reasonSignedOut is a request for an app with no live account session
	// behind it and no link in its place: never signed in, signed out, or a
	// session that has ended. The meeting endpoints say not_signed_in for the
	// same thing. The download page reads the status before the code, so it
	// cannot take the two for different conditions.
	reasonSignedOut = "signed_out"

	// reasonNotAvailable is a build asked for where there is none to give:
	// nothing configured, nothing in the manifest for that platform, or a file
	// that does not match what the manifest says of it.
	reasonNotAvailable = "not_available"

	// reasonNotConfigured is an invitation asked for where no App Store Connect
	// key was given.
	reasonNotConfigured = "not_configured"

	// reasonInvalidEmail is something that cannot be an address Apple would
	// mail. Checked here so that Apple is not asked to judge a typo, and so
	// that nothing Apple would refuse anyway is charged against the account.
	reasonInvalidEmail = "invalid_email"

	// reasonTooManyAddresses is an account that has had as many addresses
	// invited as one account may.
	reasonTooManyAddresses = "too_many_addresses"

	// reasonTestFlightRefused is App Store Connect saying no, or not answering.
	// One code for both, because the person at the page can do the same thing
	// about either — try later — and the log says which it was.
	reasonTestFlightRefused = "testflight_refused"
)

// testersPerAccount is how many addresses one account may have invited.
//
// A person, their partner's phone, an iPad: a handful. Enough that nobody who
// uses the app themselves meets it, and few enough that one account cannot
// spend the app's tester ceiling, or have Apple mail strangers in its name.
const testersPerAccount = 5

// tester is the one thing an invitation asks of App Store Connect.
type tester interface {
	Invite(ctx context.Context, email string) (testflight.Outcome, error)
}

// appsDesk is what the download endpoints keep between requests.
type appsDesk struct {
	// dir is where the builds and their manifest are, and empty where there
	// are none. The configuration calls it mac_dir, after the first platform
	// it held; see config.Apps for why the name stayed.
	dir string

	// tester invites an address. Nil where no App Store Connect key was given,
	// which is the page saying invitations are not offered yet.
	tester tester

	// publicLink is the beta's TestFlight public link, empty where none was
	// configured. Offered to whoever cannot be invited by address; see the
	// file's header.
	publicLink string

	// Two budgets, and an invitation has to fit both: one for the address it
	// came from, so that one network cannot spend every account's allowance,
	// and one for the account, so that one account cannot spend from every
	// network it reaches. Far tighter than the join's, because each one is a
	// request to Apple and, often, a mail sent.
	byCaller  *limit.Limiter
	byAccount *limit.Limiter

	// inviting holds the accounts with an invitation in flight. One at a time
	// per account, so that two presses at once cannot both find four addresses
	// recorded and between them make six.
	inviting sync.Map

	// verified remembers each platform's last hash on its own, indexed by
	// platform. One memory for the desk would hold whichever build was checked
	// last, and the page asks after every one on every visit: the Mac's check
	// would evict Android's and Android's the Mac's, so that every visit hashed
	// each file again, tens of megabytes apiece, while looking as if it
	// remembered. The iOS app's is never used, having no file to hash.
	verified [len(shelves)]verifiedImage

	// remote is the directory's remote.json, what the apps are told without a
	// release of them (remote.go). Read through one value for the life of the
	// desk, which keeps the last reading, so that a file nobody has changed is
	// not parsed again for every app that asks.
	remote *remote.File
}

// newAppsDesk reads the apps section into what the endpoints use.
//
// A key that cannot be read here was readable at startup, when the
// configuration was checked; it has moved since. That is said and invitations
// are left off, rather than refusing to start: see config.Apps for why a
// download page is never a reason a meeting server does not run.
func newAppsDesk(conf *config.Config) *appsDesk {
	apps := conf.Meet.Apps
	desk := &appsDesk{
		dir:        apps.MacDir,
		publicLink: apps.TestFlight.PublicLink,
		// One a minute, after the first few. A person typing their own address
		// needs one and a mistyped one needs two; nothing a person does needs
		// a sixth in a minute.
		byCaller:  limit.New(1.0/60, 10, conf.Meet.Hops()),
		byAccount: limit.New(1.0/60, 5, 0),
		remote:    remote.At(apps.MacDir),
	}

	if flight := apps.TestFlight; flight.Configured() {
		key, err := testflight.ReadKey(flight.KeyFile)
		if err != nil {
			slog.Error("the App Store Connect key could not be read, so no TestFlight "+
				"invitations are offered", "error", err)
		} else {
			desk.tester = testflight.New(flight.KeyID, flight.Issuer, flight.Group, key)
		}
	}

	return desk
}

func (a *App) mountApps(mux *http.ServeMux) {
	if a.store == nil || a.apps == nil {
		return
	}

	mux.HandleFunc("GET /api/apps", a.appsOffered)
	mux.HandleFunc("GET /api/apps/mac", a.download(platformMac))
	mux.HandleFunc("GET /api/apps/android", a.download(platformAndroid))
	mux.HandleFunc("GET /api/apps/windows", a.download(platformWindows))
	mux.HandleFunc("POST /api/apps/ios/invite", a.inviteTester)

	// What the apps themselves ask, to update themselves. See updates.go.
	mux.HandleFunc("GET /api/apps/latest/{platform}", a.latest)
	mux.HandleFunc("GET /api/apps/latest/{platform}/file", a.latestFile)

	// And what they say and do between releases. See remote.go.
	mux.HandleFunc("GET /api/apps/remote", a.remoteSettings)

	// The page itself, which is the account page's document: it shares that
	// page's sign-in, and somebody who arrives signed out is asked to sign in
	// in the same words and the same place. See web/src/account/main.tsx.
	mux.HandleFunc("GET /apps", a.ownAccount)
}

// What the page is told.
type appsView struct {
	Mac     buildView `json:"mac"`
	Android buildView `json:"android"`
	Windows buildView `json:"windows"`
	IOS     iosView   `json:"ios"`
}

// buildView is one platform's newest build, where there is one to hand over.
type buildView struct {
	Available bool   `json:"available"`
	Version   string `json:"version,omitempty"`
	Size      int64  `json:"size,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
}

type iosView struct {
	// Invites is whether this account can be invited by address: the
	// deployment has a key to ask Apple with, and whoever is asking is signed
	// in. Never for somebody holding only a link.
	Invites bool `json:"invites"`
	// Left is how many more addresses this account may have invited.
	Left int `json:"left"`
	// Link is the beta's public link, for whoever is not offered invitations
	// by address, where the deployment has one.
	Link string `json:"link,omitempty"`
}

// asker is who a request for the apps is from: an account, or somebody holding
// a link into a meeting.
type asker struct {
	// account is the account's signature, empty for somebody holding a link.
	account string

	// link is which kind of link they hold, "invitation" or "meeting", and
	// room is the meeting it is for. Both empty for an account.
	link, room string
}

// askerOf works out who is asking for the apps, or refuses them.
//
// A session first, as before, so that somebody signed in who also arrived on a
// link is the account and is invited by address. Then a link in the address,
// charged to the join's budget first: a token is the whole of the check, and an
// endpoint that answers whether one is good is worth no more guesses than the
// door it opens.
func (a *App) askerOf(w http.ResponseWriter, r *http.Request) (asker, bool) {
	if account, ok := a.signedIn(r); ok {
		return asker{account: account.Trip}, true
	}

	kind, token := presentedLink(r)
	if token == "" {
		fail(w, http.StatusUnauthorized, reasonSignedOut)
		return asker{}, false
	}

	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return asker{}, false
	}

	name, ok := a.heldLink(kind, token)
	if !ok {
		// One code for every way a link can be no good — never made, revoked,
		// run out, not open yet — by the words the invitation and the meeting
		// say it in elsewhere. The page does the same about each, which is not
		// to offer the app; the join screen beside it says which it was.
		reason := reasonNoSuchInvite
		if kind == linkMeeting {
			reason = reasonNoSuchMeeting
		}

		fail(w, http.StatusForbidden, reason)

		return asker{}, false
	}

	return asker{link: kind, room: name}, true
}

// The two kinds of link that stand in for an account here, by the query
// parameter each arrives in, which is also what the log calls them.
const (
	linkInvitation = "invitation"
	linkMeeting    = "meeting"
)

// presentedLink is the link a request for the apps carries in its address: an
// invitation's token under invite=, a meeting's under meeting=.
//
// The address only, and not the cookie a redeemed invitation leaves. The page
// that offers the app has the link in its address because that is how it was
// opened; the cookie outlives the meeting's link by a day and belongs to the
// join, which reads it to survive a reload, not to anything else.
func presentedLink(r *http.Request) (kind, token string) {
	query := r.URL.Query()

	if token := strings.TrimSpace(query.Get("invite")); token != "" {
		return linkInvitation, token
	}

	if token := strings.TrimSpace(query.Get("meeting")); token != "" {
		return linkMeeting, token
	}

	return "", ""
}

/*
heldLink reports whether a link would let its holder into the meeting it is
for, by the rules the join holds it to, and which room that is. Nothing is
spent: an invitation's count of people through it is the join's to keep.

An invitation is held to exactly what the join holds it to. It is found, which
a revoked one is not, since revoking and closing the room throw it away; it is
inside its ceiling (Live) and its window has opened (Begun), which is what
store.Redeem asks; for a room under a scope, whoever made it may still let
anybody in, which is what redeemScoped asks before redeeming; and for any other
room, the deployment's door takes invitations at all, which it does not where
joining asks for an account (mayJoin).

Not open yet is refused, though a meeting link before its meeting is not, and
the difference is the join's rather than this file's: an invitation used before
its window is turned away at the door, and the page it opens says when to come
back rather than leading to the join screen, so there is no first arrival for
the app to be offered to. A meeting link's page before the meeting is the
waiting screen, which is where people arrive early on purpose.

A meeting link has no door of its own — its holders go in by the invitation the
meeting produces when it begins — so it is held to what makes it worth waiting
on: the meeting is found, which a cancelled one is not, is still to come or
still being held, and would be let in by its invitation when it comes, which
under a door that asks for an account it would not be. Valid before it begins,
because that is when the page asks: somebody opening Tuesday's link on Monday is
exactly who should be able to install the app first.

A store that will not answer reads here as a link that is no good, which is a
refusal of a download and not of a meeting; the join, which matters more, says
so loudly on its own.
*/
func (a *App) heldLink(kind, token string) (string, bool) {
	now := a.now()

	if kind == linkMeeting {
		meeting, err := a.store.Arranged(token)
		if err != nil || !meeting.Outstanding(now) {
			return "", false
		}

		return meeting.Room, a.joining() != room.ByAccount
	}

	invite, found := a.store.Invite(token)
	if !found || !invite.Live(now) || !invite.Begun(now) {
		return "", false
	}

	if _, scope := room.Split(invite.Room); scope != "" {
		return invite.Room, a.member(invite.By, scope)
	}

	return invite.Room, a.joining() != room.ByAccount
}

func (a *App) appsOffered(w http.ResponseWriter, r *http.Request) {
	who, ok := a.askerOf(w, r)
	if !ok {
		return
	}

	view := appsView{
		Mac:     a.apps.shown(platformMac),
		Android: a.apps.shown(platformAndroid),
		Windows: a.apps.shown(platformWindows),
	}

	if a.apps.tester != nil && who.account != "" {
		view.IOS.Invites = true

		invited, err := a.store.Testers(who.account)
		if err != nil {
			slog.Error("failed to read whom an account has invited to test", "account", who.account, "error", err)
		}

		view.IOS.Left = max(0, testersPerAccount-len(invited))
	} else {
		view.IOS.Link = a.apps.publicLink
	}

	w.Header().Set("Cache-Control", "private, no-store")
	respond(w, view)
}

// download is the download of one platform's newest build, the same for each:
// what differs between them is in its shelf.
func (a *App) download(p platform) http.HandlerFunc {
	shelf := shelves[p]

	return func(w http.ResponseWriter, r *http.Request) {
		who, ok := a.askerOf(w, r)
		if !ok {
			return
		}

		release, file, ok := a.apps.open(p)
		if !ok {
			fail(w, http.StatusNotFound, reasonNotAvailable)
			return
		}
		defer file.Close()

		info, err := file.Stat()
		if err != nil {
			fail(w, http.StatusNotFound, reasonNotAvailable)
			return
		}

		// The name a browser saves it under, whatever the file in the
		// directory is called. The version was held to a handful of characters
		// when the manifest was read, so nothing in it can close the quotes.
		w.Header().Set("Content-Type", shelf.contentType)
		w.Header().Set("Content-Disposition", `attachment; filename="Tomoshibi-`+release.Version+shelf.suffix+`"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")

		// Private, because this answer is behind an account or a link and the
		// deployment it was written for has a CDN in front: anything a shared
		// cache may keep, it may hand to whoever asks next.
		w.Header().Set("Cache-Control", "private, no-cache")

		// The hash as the validator, so that a download resumed with If-Range
		// after a new build was copied in starts again rather than splicing the
		// end of one build onto the start of another.
		w.Header().Set("ETag", `"`+release.SHA256+`"`)

		// Said apart, so that the log can be read for how far a meeting's link
		// carried the app: an account by its signature, a link by its kind and
		// the room it was for, never by its token, which is a way into that
		// meeting for as long as it lasts.
		if r.Header.Get("Range") == "" {
			if who.account != "" {
				slog.Info("handed over the "+shelf.called+" app", "account", who.account, "version", release.Version)
			} else {
				slog.Info("handed over the "+shelf.called+" app on a link into a meeting",
					"link", who.link, "room", who.room, "version", release.Version)
			}
		}

		// ServeContent for the ranges: a build fetched over a connection that
		// drops halfway should resume rather than begin again.
		http.ServeContent(w, r, "", info.ModTime(), file)
	}
}

func (a *App) inviteTester(w http.ResponseWriter, r *http.Request) {
	// Signed in, which is also the same-site check: signedIn refuses a session
	// to any request that changes something and came from another origin, so
	// a page elsewhere cannot spend somebody's invitations by posting here.
	account, ok := a.signedIn(r)
	if !ok {
		fail(w, http.StatusUnauthorized, reasonSignedOut)
		return
	}

	desk := a.apps
	if desk.tester == nil {
		fail(w, http.StatusServiceUnavailable, reasonNotConfigured)
		return
	}

	// Both budgets are charged, even when the first refuses, so that a caller
	// cannot learn which of the two it ran out of by watching the other.
	byCaller := desk.byCaller.Allow(r)
	byAccount := desk.byAccount.AllowKey(account.Trip)
	if !byCaller || !byAccount {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	if _, busy := desk.inviting.LoadOrStore(account.Trip, struct{}{}); busy {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}
	defer desk.inviting.Delete(account.Trip)

	var body struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body)

	email, valid := testerAddress(body.Email)
	if !valid {
		fail(w, http.StatusBadRequest, reasonInvalidEmail)
		return
	}

	// Refused rather than let through while the store will not answer. The rule
	// that a store outage admits people is about a meeting nobody can tell is
	// happening; this is a count, and the count is the only thing between one
	// account and the app's whole tester ceiling.
	invited, err := a.store.Testers(account.Trip)
	if err != nil {
		slog.Error("failed to read whom an account has invited to test", "account", account.Trip, "error", err)
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	left := testersPerAccount - len(invited)

	for _, one := range invited {
		if one.Address == email {
			respond(w, invitation{Result: testflight.AlreadyInvited, Left: max(0, left)})
			return
		}
	}

	if left <= 0 {
		fail(w, http.StatusForbidden, reasonTooManyAddresses)
		return
	}

	// Its own deadline, under the request's, so that a stalled Apple is a
	// sentence on the page within half a minute rather than a spinner for as
	// long as the browser cares to wait.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	masked := testflight.Masked(email)

	outcome, err := desk.tester.Invite(ctx, email)
	if err != nil {
		slog.Warn("App Store Connect did not take an invitation",
			"account", account.Trip, "address", masked, "error", err)
		fail(w, http.StatusBadGateway, reasonTestFlightRefused)
		return
	}

	// Counted whether Apple sent a mail now or sent one before. Either way the
	// address is a tester because this account asked, and it is the testers
	// that are being counted.
	//
	// A failure here is logged and not refused: the invitation has gone, and
	// telling somebody it failed would have them ask again for something that
	// worked. What is lost is one place in the count.
	if err := a.store.AddTester(account.Trip, store.Tester{Address: email, At: time.Now().UTC()}); err != nil {
		slog.Error("failed to record an invitation to test", "account", account.Trip, "error", err)
	}

	slog.Info("invited somebody to test the iOS app",
		"account", account.Trip, "address", masked, "outcome", outcome)

	respond(w, invitation{Result: outcome, Left: max(0, left-1)})
}

// invitation is what the page is told an invitation came to.
type invitation struct {
	Result testflight.Outcome `json:"result"`
	Left   int                `json:"left"`
}

// testerAddress reads what was typed as an address Apple could mail, or says
// that it is not one.
//
// Stricter than the RFC, deliberately. What is accepted is the address of a
// person on an ordinary mail system — letters, digits and the usual handful of
// symbols before the @, a dotted name with a real-looking suffix after it —
// because the alternative is passing Apple everything net/mail will parse,
// including a display name and angle brackets, and finding out from a refusal
// that cost the account a request. Lowercased, so that one address typed two
// ways is one tester counted once.
func testerAddress(typed string) (string, bool) {
	email := strings.ToLower(strings.TrimSpace(typed))

	if len(email) > 254 {
		return "", false
	}

	local, domain, found := strings.Cut(email, "@")
	if !found || strings.Contains(domain, "@") {
		return "", false
	}

	if !localPart.MatchString(local) || len(local) > 64 ||
		strings.HasPrefix(local, ".") || strings.HasSuffix(local, ".") || strings.Contains(local, "..") {
		return "", false
	}

	if !domainPart.MatchString(domain) {
		return "", false
	}

	return email, true
}

var (
	localPart  = regexp.MustCompile(`^[a-z0-9!#$%&'*+/=?^_` + "`" + `{|}~.-]+$`)
	domainPart = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
)

// A platform the apps directory's manifest has a list for. The Mac, Android and
// Windows apps are files this server hands over, each to the download page and
// to the apps themselves as an update (updates.go); the iOS app is installed by
// TestFlight, and its list only tells the app which version is newest there.
// Everything that differs between them is in its shelf, so that reading the
// manifest, checking the file and handing it over are one piece of code each,
// and a rule added for one platform cannot be missing from another.
type platform int

const (
	platformMac platform = iota
	platformAndroid
	platformWindows
	platformIOS
)

// shelf is what tells one platform's builds apart from another's.
type shelf struct {
	// section is the manifest's key for the platform's list, and the last part
	// of the address its build is downloaded from.
	section string

	// called is how the log names the platform.
	called string

	// suffix is what a file must end in to be offered as this platform's, and
	// what the saved file is given. Checked so that a line pasted into the
	// wrong list hands nobody a disk image on a phone.
	suffix string

	// contentType is what the browser is told it is saving, and so what it
	// offers to open it with.
	contentType string

	// elsewhere is a platform whose app is installed from somewhere other
	// than this server. Its lines are held to a version alone, and no file is
	// ever opened for it, whatever a line names. It has no suffix or type,
	// which would mean nothing for it; and since an empty suffix is one every
	// file in the directory ends in, it is the check in open, not the suffix,
	// that keeps a Mac line pasted into its list from handing a disk image to
	// a phone.
	elsewhere bool
}

var shelves = [...]shelf{
	platformMac:     {section: "mac", called: "Mac", suffix: ".dmg", contentType: "application/x-apple-diskimage"},
	platformAndroid: {section: "android", called: "Android", suffix: ".apk", contentType: "application/vnd.android.package-archive"},
	// An installer, holding both architectures and choosing between them on
	// the machine it runs on, so that one file serves an ARM PC and an x64 one
	// alike. It installs for the person running it, under their own profile,
	// and asks for no administrator.
	//
	// Not the MSIX bundle this shelf first named. Windows installs an MSIX only
	// when it is signed by a certificate the machine trusts, and the owner
	// decided against buying one (2026-10-21); an unsigned installer runs once
	// somebody presses past SmartScreen's "Windows protected your PC", which
	// the pages warn of before it appears. The type is the one registered for
	// a Windows program, rather than application/octet-stream, so that what
	// the browser is told matches what it is saving.
	platformWindows: {
		section: "windows", called: "Windows", suffix: ".exe",
		contentType: "application/vnd.microsoft.portable-executable",
	},
	// TestFlight's, and listed here only so that the app can ask whether a
	// newer build is waiting there and read what changed in it. Its build
	// carries no size or hash because Apple delivers it and checks it; the
	// download page offers it by invitation or public link as before, which
	// is why the page never asks this shelf for a build.
	platformIOS: {section: "ios", called: "iOS", elsewhere: true},
}

// appRelease is one entry of the manifest, whichever platform's list it is in.
type appRelease struct {
	Version string `json:"version"`
	File    string `json:"file"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`

	// Notes is what changed, by language, as the apps show it beside an
	// update. Read apart from the rest (notesOf), so that a line whose notes
	// were written wrongly still offers its build.
	Notes json.RawMessage `json:"notes,omitempty"`

	// Build is the line's build number (on the Mac and the iPhone its
	// CFBundleVersion), where the line says one. Read apart as the notes are
	// (buildOf), and for more than tidiness: typed here as a string, a build
	// written as a number would fail the line's whole decode and take the build
	// off the page and out of every update. What the update answer joins on
	// (updates.go, versionFor) and the page shows in brackets (labelOf); never
	// what the newest line is chosen by, nor what the saved file is named.
	Build json.RawMessage `json:"build,omitempty"`
}

// The manifest's own name, beside the builds it describes.
const manifestName = "apps.json"

// releaseVersion is what a version may look like: what it is compared by and
// what is put in the name of the file somebody saves.
var releaseVersion = regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]{0,31}$`)

var hexDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)

// shown is what the page is told of one platform's build.
func (d *appsDesk) shown(p platform) buildView {
	release, file, ok := d.open(p)
	if !ok {
		return buildView{}
	}
	_ = file.Close()

	return buildView{Available: true, Version: labelOf(release), Size: release.Size, SHA256: release.SHA256}
}

// release is a platform's newest release as the apps are told of it: for an
// app handed over here, the one open finds and checks; for an app installed
// elsewhere, the newest line of its list, there being no file to check.
//
// What a line of the second kind says of a file is dropped rather than passed
// on. An app told a size and a hash would take them for a build to download,
// and a line copied from another list carries both. Its build is kept: a later
// TestFlight build of a version is offered by it as any other platform's is.
func (d *appsDesk) release(p platform) (appRelease, bool) {
	shelf := shelves[p]

	if !shelf.elsewhere {
		release, file, ok := d.open(p)
		if !ok {
			return appRelease{}, false
		}
		_ = file.Close()

		return release, true
	}

	if d == nil || d.dir == "" {
		return appRelease{}, false
	}

	newest, ok := d.newest(shelf)
	if !ok {
		return appRelease{}, false
	}

	return appRelease{Version: newest.Version, Notes: newest.Notes, Build: newest.Build}, true
}

// open finds a platform's newest release and opens its file, where there is
// one that matches what the manifest says about it. The caller closes the file.
//
// The file is opened before it is checked, and the check reads the open file,
// so that what is served is what was checked: a build copied over the old one
// between the two would otherwise be served on the strength of its
// predecessor's hash.
func (d *appsDesk) open(p platform) (appRelease, *os.File, bool) {
	if d == nil || d.dir == "" {
		return appRelease{}, nil, false
	}

	shelf := shelves[p]

	// Refused here, where a file is found, rather than left to its lines
	// failing a file's checks. They are not put to those checks (offerable),
	// so a line in its list that named a build in the directory, of the right
	// size and hash, would have that build opened and handed over.
	if shelf.elsewhere {
		return appRelease{}, nil, false
	}

	newest, ok := d.newest(shelf)
	if !ok {
		return appRelease{}, nil, false
	}

	path := filepath.Join(d.dir, newest.File)

	file, err := os.Open(path)
	if err != nil {
		slog.Warn("the manifest names a "+shelf.called+" build that is not there", "file", path)
		return appRelease{}, nil, false
	}

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != newest.Size {
		// The ordinary cause is a copy still in progress, which is over by
		// the next visit.
		slog.Warn("the "+shelf.called+" build is not the size its manifest says, so it is not offered yet",
			"file", path, "manifest", newest.Size)
		_ = file.Close()
		return appRelease{}, nil, false
	}

	if !d.verified[p].matches(file, info, newest.SHA256, shelf.called) {
		_ = file.Close()
		return appRelease{}, nil, false
	}

	return newest, file, true
}

// newest reads the manifest and picks the entry with the highest version from
// one platform's list.
//
// Read as raw pieces, the list apart from the rest of the file and each entry
// apart from the others, rather than into one struct: one value of the wrong
// type anywhere fails a whole decode, and decoded that way a size typed in
// quotes on the Android line takes the Mac build off the page with it, which
// the tests watched happen. An entry that cannot be
// offered — one that is not an object of the expected fields, a version that is
// not one, a file named with a path, a hash that is not a hash — is passed
// over, and said, for the same reason: an old line written by hand should not
// take the current build off the page.
func (d *appsDesk) newest(shelf shelf) (appRelease, bool) {
	raw, err := os.ReadFile(filepath.Join(d.dir, manifestName))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("the apps' manifest could not be read", "dir", d.dir, "error", err)
		}
		return appRelease{}, false
	}

	var lists map[string]json.RawMessage
	if err := json.Unmarshal(raw, &lists); err != nil {
		slog.Warn("the apps' manifest is not JSON this server can read", "dir", d.dir, "error", err)
		return appRelease{}, false
	}

	// A platform with no list is one with no build yet, which is ordinary and
	// not said. A null reads as an empty list.
	list, listed := lists[shelf.section]
	if !listed {
		return appRelease{}, false
	}

	var entries []json.RawMessage
	if err := json.Unmarshal(list, &entries); err != nil {
		slog.Warn("the apps' manifest has a "+shelf.section+" that is not a list, so no "+shelf.called+
			" build is offered", "dir", d.dir, "error", err)
		return appRelease{}, false
	}

	var newest appRelease
	found := false

	for _, entry := range entries {
		var one appRelease
		err := json.Unmarshal(entry, &one)
		one.SHA256 = strings.ToLower(one.SHA256)

		if err != nil || !offerable(one, shelf) {
			slog.Warn("an entry in the apps' manifest cannot be offered and is passed over",
				"dir", d.dir, "platform", shelf.section, "version", one.Version, "file", one.File)
			continue
		}

		// Later lines win a tie, so that a manifest corrected by appending is
		// read the way it was meant.
		if !found || !newerVersion(newest.Version, one.Version) {
			newest, found = one, true
		}
	}

	return newest, found
}

// offerable reports whether a manifest's entry says enough to be offered as
// one of the platform's builds: a version, always, since it is compared and
// shown; and for an app handed over here a size, a hash and a file of the
// platform's, which are what the file is checked against.
//
// An app installed elsewhere is held to its version alone. Its notes are
// optional on every platform, and nothing else in its line is used.
func offerable(one appRelease, shelf shelf) bool {
	if !releaseVersion.MatchString(one.Version) {
		return false
	}

	if shelf.elsewhere {
		return true
	}

	return one.Size > 0 && hexDigest.MatchString(one.SHA256) && shelved(one.File, shelf.suffix)
}

// shelved reports whether a manifest's file is one of the platform's builds in
// the directory itself, and not a path somewhere else.
func shelved(name, suffix string) bool {
	return name != "" && filepath.Base(name) == name && !strings.HasPrefix(name, ".") &&
		strings.HasSuffix(strings.ToLower(name), suffix)
}

// newerVersion reports whether a is a later version than b.
//
// Dotted parts compared in order, as numbers where both are numbers and as
// text where either is not, and a version that is a longer form of another is
// the later. Not semantic versioning's whole rule — a pre-release sorts after
// its release here — and a manifest is expected to list releases.
func newerVersion(a, b string) bool {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")

	for i := 0; i < len(as) && i < len(bs); i++ {
		if as[i] == bs[i] {
			continue
		}

		an, aErr := strconv.Atoi(as[i])
		bn, bErr := strconv.Atoi(bs[i])

		if aErr == nil && bErr == nil {
			return an > bn
		}

		return as[i] > bs[i]
	}

	return len(as) > len(bs)
}

// verifiedImage remembers the one build of a platform whose hash was last
// worked out.
//
// One rather than a map, because one build of a platform is offered at a time;
// a new build replaces the entry rather than growing a list. The desk keeps one
// of these for each platform, for the reason given beside it.
type verifiedImage struct {
	mu   sync.Mutex
	key  string
	good bool
}

// matches reports whether an open file hashes to want, working it out only
// when this file, at this size and modification time, has not been asked
// about before. called names the platform in the log.
//
// Held under the lock while hashing, so that the first visits after a new build
// arrives wait for one hash rather than each starting their own.
func (v *verifiedImage) matches(file *os.File, info fs.FileInfo, want, called string) bool {
	key := fmt.Sprintf("%s|%d|%d|%s", file.Name(), info.Size(), info.ModTime().UnixNano(), want)

	v.mu.Lock()
	defer v.mu.Unlock()

	if v.key == key {
		return v.good
	}

	sum := sha256.New()

	// Read through ReadAt, which leaves the file's offset where it was for
	// whatever serves it next.
	if _, err := io.Copy(sum, io.NewSectionReader(file, 0, info.Size())); err != nil {
		slog.Warn("the "+called+" build could not be read to check it", "file", file.Name(), "error", err)
		return false
	}

	v.key = key
	v.good = hex.EncodeToString(sum.Sum(nil)) == want

	if !v.good {
		slog.Error("the "+called+" build does not hash to what its manifest says, so it is not offered",
			"file", file.Name())
	}

	return v.good
}
