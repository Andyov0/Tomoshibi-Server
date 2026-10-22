package app

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"tomoshibi/internal/admin"
	"tomoshibi/internal/limit"

	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
The page somebody signs into to look after their own account.

Deliberately not the management pages. What somebody changes here is their own
passphrase and their own picture — no relay, no room, no setting that belongs to
the deployment. Putting the two behind one door would mean everybody with an
account holding a key to a building they have no business in, and dressing the
door differently for different people is how a page comes to be one mistake away
from showing the wrong person the wrong thing.

The page shows more than it changes. It reads back what the account may use
(Can, below) so that a feature somebody was not given is explained rather than
merely missing, and it keeps settings for how calls start — but those are the
browser's, written to its own storage, and never reach this server. Nothing an
account holder does here alters what they may do or what anybody else sees.

Recognised the same way everybody here is recognised: a name and a passphrase,
turned into a signature and compared against what was stored. This server has
never been told a passphrase in a form it keeps and still is not.
*/

// The cookie an account's own session travels in.
//
// A different name from the management one, because they are different sessions
// with different powers and a browser holding both should send each where it
// belongs. Strict, HttpOnly and Secure for the reasons the other one is.
const accountCookie = "meet-live.account"

// What kind of session this is, written into the record.
//
// Checked on every read. The two kinds share a bucket, and the thing that must
// never happen is a token from one being accepted by the other.
const accountKind = "account"

// How long an account's session lasts without being used, and at the outside.
const (
	accountIdle = 30 * 24 * time.Hour
	accountMax  = 90 * 24 * time.Hour
)

// mountAccounts registers the pages an account holder uses.
//
// Only where there is a store to hold accounts, which is everywhere but a
// relay. A deployment without one has no such addresses rather than addresses
// that refuse.
func (a *App) mountAccounts(mux *http.ServeMux) {
	if a.store == nil {
		return
	}

	mux.HandleFunc("POST /api/account/session", a.accountSignIn)
	mux.HandleFunc("DELETE /api/account/session", a.accountSignOut)
	mux.HandleFunc("GET /api/account/me", a.accountMe)
	mux.HandleFunc("POST /api/account/passphrase", a.accountPassphrase)
	mux.HandleFunc("PUT /api/account/avatar", a.accountAvatar)
	mux.HandleFunc("DELETE /api/account/avatar", a.accountAvatar)

	// Somebody's picture, by the signature it belongs to.
	//
	// Open, because it is shown beside their name in a room to everybody in
	// that room, and a picture behind a session would be a picture nobody in
	// the call could see. What it discloses is that a signature has an account
	// and what its owner chose to look like, both of which are already on
	// screen wherever they are.
	mux.HandleFunc("GET /api/avatar/{trip}", a.avatar)
}

func (a *App) accountSignIn(w http.ResponseWriter, r *http.Request) {
	// Two limits, because this door does two jobs.
	//
	// The join's limiter bounds how often anybody may ask, which is what stops
	// this from being a way to hammer the store. The guessing budget bounds how
	// often a passphrase may be tried, and it is shared with the management
	// sign-in — which matters here more than anywhere, because whoever() below
	// accepts an administrator's name and passphrase and hands back a session
	// that moderates every room for thirty days. The management sign-in holds
	// that same credential to ten a minute; without this, the same guess was
	// worth ten a second here.
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	attempt, allowed := a.admin.Guessing().Take(limit.Caller(r, a.conf.Meet.Hops()))
	if !allowed {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}
	defer attempt.Settled()

	var body struct {
		Name       string          `json:"name"`
		Passphrase room.Passphrase `json:"passphrase"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	// The signature is derived whether or not the name exists, so that a name
	// nobody has does not answer faster than one somebody does. Enumerating
	// accounts should not be cheaper than guessing at them.
	trip := room.Trip(a.tripKey, strings.TrimSpace(string(body.Passphrase)))

	account, ok := a.whoever(body.Name, trip)

	if !ok || body.Passphrase.Empty() {
		// Charged on the way out rather than on the way in, so that somebody
		// signing in correctly does not spend from a budget meant for guesses.
		attempt.Failed()

		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	if account.Blocked {
		fail(w, http.StatusForbidden, reasonBlocked)
		return
	}

	token := accountToken()
	now := time.Now().UTC()

	if err := a.store.KeepSession(token, store.Session{
		Trip: account.Trip, Name: account.Name, Kind: accountKind,
		Opened: now, Expires: now.Add(accountIdle),
	}); err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     accountCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil || forwardedProto(r, a.conf.Meet.TrustProxy) == "https",
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(accountIdle.Seconds()),
	})

	respond(w, a.accountOf(account))
}

// whoever finds the person a name and a signature belong to, in either list.
//
// Two lists and one door. Administrators are kept apart from accounts because
// they answer different questions — one is who may run this deployment, the
// other is who has been given a name here — and for a while that meant the one
// group who certainly have credentials were the one group who could not sign in
// at the front of the site. They typed the name and passphrase they use for the
// management pages and were told the pair does not go together, which is both
// true and useless.
//
// An administrator is returned as an account because that is what the rest of
// this file needs: a name, a signature, and a picture. Nothing is authorised by
// the shape — being an administrator is decided by the administrator list, every
// time it is asked, and never by a field carried over from here.
func (a *App) whoever(name, trip string) (store.Account, bool) {
	if account, ok := a.store.Account(name); ok && account.Trip == trip {
		return account, true
	}

	if admin, ok := a.store.AdminNamed(name); ok && admin.Trip == trip {
		return store.Account{Name: admin.Name, Trip: admin.Trip, Avatar: admin.Avatar}, true
	}

	return store.Account{}, false
}

func (a *App) accountSignOut(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(accountCookie); err == nil {
		_ = a.store.DropSession(cookie.Value)
	}

	http.SetCookie(w, &http.Cookie{
		Name: accountCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})

	w.WriteHeader(http.StatusNoContent)
}

// signedIn returns the account this request carries, if it carries a live one.
func (a *App) signedIn(r *http.Request) (store.Account, bool) {
	// A relay holds none, and the join reads this on every request. Guarded here
	// rather than at each call so that adding a second caller cannot reintroduce
	// the panic.
	if a.store == nil {
		return store.Account{}, false
	}

	// Nor from another origin, for anything that changes something. The account
	// cookie hosts rooms, arranges and cancels meetings and changes the
	// passphrase, and SameSite=Strict still sends it from a sibling subdomain;
	// see admin.FromHere. A join from elsewhere simply arrives unsigned.
	if !admin.FromHere(r) {
		return store.Account{}, false
	}

	cookie, err := r.Cookie(accountCookie)
	if err != nil {
		return store.Account{}, false
	}

	session, ok := a.store.Session(cookie.Value)
	if !ok || session.Kind != accountKind {
		return store.Account{}, false
	}

	now := time.Now().UTC()

	if now.After(session.Expires) || now.Sub(session.Opened) > accountMax {
		_ = a.store.DropSession(cookie.Value)
		return store.Account{}, false
	}

	account, held := a.whoever(session.Name, session.Trip)

	// Blocked is checked here and not only at the door.
	//
	// Signing in refuses a blocked account and the join refuses one, but the
	// session somebody already held went on working: for up to a month they kept
	// their page, could change their own passphrase and picture, and could go on
	// asking which room names are in use. Blocking somebody has to end what they
	// have, not only stop them getting more.
	if held && account.Blocked {
		held = false
	}

	if !held {
		// The account was removed, renamed, or had its passphrase changed by
		// somebody else. The session names something that is no longer there,
		// which is a session that has ended.
		_ = a.store.DropSession(cookie.Value)
		return store.Account{}, false
	}

	// Pushed forward by being used, and written back at most once a minute for
	// the reason the management sessions are.
	if now.Sub(session.Expires.Add(-accountIdle)) > time.Minute {
		session.Expires = now.Add(accountIdle)
		_ = a.store.KeepSession(cookie.Value, session)
	}

	return account, true
}

func (a *App) accountMe(w http.ResponseWriter, r *http.Request) {
	account, ok := a.signedIn(r)
	if !ok {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	respond(w, a.accountOf(account))
}

func (a *App) accountPassphrase(w http.ResponseWriter, r *http.Request) {
	account, ok := a.signedIn(r)
	if !ok {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	var body struct {
		Current room.Passphrase `json:"current"`
		Next    room.Passphrase `json:"next"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	// The current one, even though the session already says who this is. A
	// session proves somebody signed in; this asks whether the person at the
	// keyboard now is that person, which is the question an unattended laptop
	// raises.
	if room.Trip(a.tripKey, strings.TrimSpace(string(body.Current))) != account.Trip {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	next := strings.TrimSpace(string(body.Next))

	if len([]rune(next)) < 8 {
		fail(w, http.StatusBadRequest, reasonPassphraseShort)
		return
	}

	was := account.Trip
	account.Trip = room.Trip(a.tripKey, next)

	if account.Trip == was {
		fail(w, http.StatusBadRequest, reasonPassphraseSame)
		return
	}

	if err := a.rewrite(was, account, false); err != nil {
		// The signature checked above is no longer the record's: an
		// administrator set a new passphrase while this was on its way, and
		// what was typed as the current one is not, now.
		if errors.Is(err, store.ErrNoSuchAccount) {
			fail(w, http.StatusForbidden, reasonNotYours)
			return
		}

		fail(w, http.StatusConflict, reasonPassphraseTaken)
		return
	}

	// Carried across, or they would be signed out by their own success.
	if cookie, err := r.Cookie(accountCookie); err == nil {
		if session, held := a.store.Session(cookie.Value); held {
			session.Trip = account.Trip
			_ = a.store.KeepSession(cookie.Value, session)
		}
	}

	// And their figure on the management pages with them; see MoveSpent.
	a.relayed.MoveSpent(was, account.Trip)

	// And the addresses they had invited to test the iOS app, or a new
	// passphrase would be a new allowance of them. See store/testers.go.
	if err := a.store.MoveTesters(was, account.Trip); err != nil {
		slog.Error("failed to carry an account's invitations to test across a passphrase change",
			"account", account.Trip, "error", err)
	}

	respond(w, a.accountOf(account))
}

func (a *App) accountAvatar(w http.ResponseWriter, r *http.Request) {
	account, ok := a.signedIn(r)
	if !ok {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	if r.Method == http.MethodDelete {
		account.Avatar = ""
	} else {
		var body struct {
			Image string `json:"image"`
		}

		// Room for the picture and very little else. The client scales it down
		// long before this; the limit is here because a limit the server does
		// not enforce is a suggestion.
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 96<<10)).Decode(&body); err != nil {
			fail(w, http.StatusRequestEntityTooLarge, reasonAvatarLarge)
			return
		}

		if !strings.HasPrefix(body.Image, "data:image/") {
			fail(w, http.StatusBadRequest, reasonNotAnImage)
			return
		}

		account.Avatar = body.Image
	}

	if err := a.rewrite(account.Trip, account, true); err != nil {
		fail(w, http.StatusBadRequest, reasonAvatarLarge)
		return
	}

	respond(w, a.accountOf(account))
}

// rewrite saves one of a person's own changes back to whichever list they are
// actually in: their picture, where picture is true, and otherwise their
// signature.
//
// `was` is the signature they carried before, which is the key an administrator
// is stored under and is therefore what has to be found again after a passphrase
// change. An account is keyed by name and does not have this problem, which is
// why one call cannot serve both without being told.
//
// The one field, and never the record. The record in hand was read when the
// request began, and the request is as long as the picture takes to arrive;
// written whole, it put back whatever an administrator had changed meanwhile,
// a block among it, which is how an administrator stops somebody's films being
// relayed. The administrators' list had learned this already (SetAdminAvatar);
// the accounts' had not.
func (a *App) rewrite(was string, account store.Account, picture bool) error {
	if _, ok := a.store.Account(account.Name); ok {
		if picture {
			return a.store.SetAccountAvatar(account.Name, account.Avatar)
		}

		return a.store.SetAccountTrip(account.Name, was, account.Trip)
	}

	admin, ok := a.store.AdminBySignature(was)
	if !ok {
		return store.ErrNoSuchAccount
	}

	// The signature is the key, so changing it is a move rather than an edit.
	// Done by the store in one transaction: written as a remove and an add, a
	// failure between the two would delete an administrator, and the one it
	// would delete is whoever was changing their own passphrase.
	if !picture {
		if admin.Trip == account.Trip {
			return nil
		}

		return a.store.ReplaceAdminTrip(was, account.Trip)
	}

	// The picture by itself. The whole record used to go back through
	// UpdateAdmin, which now carries the picture over from what is stored — so
	// that another administrator changing this one's role cannot erase it — and
	// so cannot be how the picture changes.
	return a.store.SetAdminAvatar(account.Trip, account.Avatar)
}

func (a *App) avatar(w http.ResponseWriter, r *http.Request) {
	account, ok := a.store.AccountBySignature(r.PathValue("trip"))

	// Administrators keep their pictures in their own list, and a picture is
	// shown by signature — the caller has no idea which list its owner is in and
	// should not have to.
	if !ok {
		if admin, held := a.store.AdminBySignature(r.PathValue("trip")); held {
			account, ok = store.Account{Name: admin.Name, Trip: admin.Trip, Avatar: admin.Avatar}, true
		}
	}

	if !ok || account.Avatar == "" {
		http.NotFound(w, r)
		return
	}

	kind, data, found := strings.Cut(account.Avatar, ",")
	if !found || !strings.HasSuffix(kind, ";base64") {
		http.NotFound(w, r)
		return
	}

	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	// The type the picture says it is, from the part of the data URI before the
	// encoding — and only from the handful this accepts, so a stored string
	// cannot name a type that makes a browser do something other than draw it.
	media := strings.TrimSuffix(strings.TrimPrefix(kind, "data:"), ";base64")

	switch media {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
	default:
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", media)
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(raw)
}

// accountOf is what an account holder is told about themselves.
//
// Never the signature of anybody else and never a passphrase, because there is
// none to tell. The picture comes back as a URL rather than as itself, so the
// page that shows it and the page that shows everybody else's use one path.
type accountView struct {
	Name   string `json:"name"`
	Trip   string `json:"trip"`
	Avatar string `json:"avatar,omitempty"`
	// Admin is whether this person also runs the deployment.
	//
	// Told to them and to nobody else, and only so the page can offer the way to
	// the management pages: somebody who administers this server should not have
	// to remember an address. Nothing is authorised by it — the management pages
	// ask the administrator list themselves, on every request, and would refuse a
	// browser that had been told otherwise.
	Admin   bool   `json:"admin,omitempty"`
	Created string `json:"created,omitempty"`
	// Scopes are the groups they belong to, so their page can offer to send a
	// link into a room held under one. Like Admin, a courtesy to the page and
	// never a permission: the invitation endpoint asks the account itself.
	Scopes []string `json:"scopes,omitempty"`
	// Can is what they may use, so their page can say so and not offer what
	// would be refused. A courtesy like the two above: every endpoint it names
	// asks again for itself. Always present, empty or not, so a page can tell
	// "nothing" from a server too old to say.
	Can []string `json:"can"`
}

func (a *App) accountOf(account store.Account) accountView {
	view := accountOf(account)

	_, view.Admin = a.store.AdminBySignature(account.Trip)
	view.Can = a.granted(account.Trip)

	return view
}

func accountOf(account store.Account) accountView {
	view := accountView{Name: account.Name, Trip: account.Trip, Scopes: account.Scopes}

	if account.Avatar != "" {
		view.Avatar = "/api/avatar/" + account.Trip
	}

	if !account.Created.IsZero() {
		view.Created = account.Created.UTC().Format(time.RFC3339)
	}

	return view
}

func accountToken() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand does not fail on any platform this runs on, and a
		// predictable session token is worse than not answering.
		panic("read random bytes: " + err.Error())
	}

	return base64.RawURLEncoding.EncodeToString(raw)
}
