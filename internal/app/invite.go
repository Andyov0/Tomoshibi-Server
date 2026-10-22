package app

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
Being let into one meeting without being given anything else.

The two ways in are otherwise both about knowing something: a passphrase, or a
room name nobody has told anybody else. Neither suits somebody invited to a
single call. A passphrase is an account. And a room name is worse than it looks —
a room here is a name and nothing else, so handing over the name of a recurring
meeting hands over every future instance of it, for good, to whoever the link
reaches after them.

An invite carries neither. It names one room, it stops working, and whoever
redeems it gets an issued mark: a signature drawn from nothing, which says only
that they are not the other people in the call. That is the honest description of
a guest and it is all that should be claimed for one.

How many people it admits is however many are sent it, and how long it lasts is
until the meeting ends or a day, whichever comes first.

Not one person, which is what this said and what half an implementation of it is
still visible in the store. The panel that mints these offers a link and a way to
stop it working, and describes it as one anybody may use — a host inviting three
people should press the button once, and a link that stopped working after the
first of them arrived would read as broken. Being able to take it back is what
makes that safe, and that is what the revoke is for.

The day is the ceiling under the real rule rather than the rule: a link found in
a message from March should be dead however the asking went.

A room held under a scope keeps all of this for a link made in a call, and adds
a standing invitation, which a member makes on their own page for people who
come back. That kind carries a name and a window instead of a day, lasts until
revoked when nobody gave it an end, and survives the meeting being ended. See
standingInvite, and the store's header for the rest of the argument.
*/

// The ceiling on an invite, which is not the rule.
//
// The rule is the meeting: while the room is running the link works, and when it
// ends the link is worth nothing. This is the backstop under that, because
// "while the room is running" is answered by asking the media server and a link
// should not outlive that conversation being possible. A day, because a meeting
// invited to on Monday for Tuesday is ordinary and a link found in a message
// from March should be dead however the asking went.
const inviteFor = 24 * time.Hour

// The cookie a redeemed invite leaves behind.
//
// Not a credential and not an account: it holds the token that was spent, so
// that a reload does not have to spend another. Without it a guest who refreshed
// would be turned away by the very thing that let them in.
const inviteCookie = "meet-live.invite"

func (a *App) mountInvites(mux *http.ServeMux) {
	if a.store == nil {
		return
	}

	mux.HandleFunc("POST /api/rooms/{room}/invites", a.makeInvite)
	mux.HandleFunc("DELETE /api/rooms/{room}/invites", a.revokeInvites)
	mux.HandleFunc("GET /api/invites/{token}", a.readInvite)
	mux.HandleFunc("GET /api/rooms/{room}/live", a.roomLive)
}

// makeInvite mints one, for somebody already in the room.
//
// Only the host, and an administrator anywhere. Anybody in a call being able to
// mint links to it would make the single-use limit meaningless — one guest could
// let in the rest of the internet, one at a time — and it is the host who is
// answerable for who is in their meeting.
func (a *App) makeInvite(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	now := a.now()
	invite := store.Invite{Room: name, By: who.Mark.Trip, Created: now, Expires: now.Add(inviteFor)}

	// A room held under a scope may be asked for a standing invitation, which
	// is what a member's own page asks for. From inside a call nothing is said,
	// and the link is the meeting's exactly as a plain room's is. See
	// standingInvite.
	if _, scope := room.Split(name); scope != "" {
		var ok bool
		if invite, ok = standingInvite(w, r, invite, now); !ok {
			return
		}

		// A standing link is the invite permission's, on top of being
		// allowed to run the room. Being a member is what lets somebody act
		// on a scope's meetings; handing strangers a way into them that
		// outlives every meeting is a further thing an owner may not want
		// every member doing. Asked of whoever is making it — the account
		// behind the session or the passphrase, or the administrator, who
		// holds it whatever their record says.
		//
		// The ordinary link a call makes is not asked: it dies with the
		// meeting, and refusing it would take a host's door away from them.
		if invite.Standing && !(who.Mark.Proven && a.holds(who.Mark.Trip, store.PermInvite)) {
			fail(w, http.StatusForbidden, reasonNotAllowed)
			return
		}
	}

	token, err := store.NewInviteToken()
	if err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	if err := a.store.KeepInvite(token, invite); err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	// Returned once and never again. What the store holds is the token's hash,
	// on the same reasoning as a session: a copy of the database is not a set of
	// working invitations.
	said := describe(invite)
	said["token"] = token

	respond(w, said)
}

/*
standingInvite reads whether a link into a scoped room is to be a standing
invitation and, where it is, what it is for: whose name it lets somebody wear,
when it opens, and when it stops.

Asked for by name rather than inferred from a body being there. An ordinary
link is what a press in a call makes, and a request that grew a body for some
other reason must not quietly become a link that outlives the meeting. Without
it nothing else in the body is read.

The three are optional. No end is a link that lasts until it is revoked, because
these are made on purpose for people who come back — a client's weekly call —
and a ceiling would be a link that dies on a schedule nobody chose. There is no
upper bound on the end either: the window is checked only at the door, and a
guest already in the call is never put out by it, so a long one gives nothing
away that an unbounded one would not.

Times arrive as instants with their zone, as an arrangement's does, because a
time with no zone is a time in a zone somebody guessed.

A name longer than a display name may be is refused rather than trimmed. The
join trims what a guest typed, because their intent is obvious; here the person
making the link is choosing what somebody else will be called, and a name that
saved shorter than it was typed is one they did not choose.
*/
func standingInvite(w http.ResponseWriter, r *http.Request, invite store.Invite, now time.Time) (store.Invite, bool) {
	var body struct {
		Standing bool   `json:"standing"`
		Name     string `json:"name"`
		From     string `json:"from"`
		Until    string `json:"until"`
	}

	// An empty body is the panel in a call, which says nothing. One that will
	// not read is refused rather than taken as empty: that would be a link
	// that ends with the meeting where its maker asked for one that does not,
	// or the reverse.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		fail(w, http.StatusBadRequest, reasonBadTime)
		return invite, false
	}

	if !body.Standing {
		return invite, true
	}

	invite.Standing = true

	invite.Name = strings.TrimSpace(body.Name)
	if len([]rune(invite.Name)) > room.MaxDisplayName {
		fail(w, http.StatusBadRequest, reasonNameLong)
		return invite, false
	}

	invite.Expires = time.Time{}

	if said := strings.TrimSpace(body.From); said != "" {
		from, err := time.Parse(time.RFC3339, said)
		if err != nil {
			fail(w, http.StatusBadRequest, reasonBadTime)
			return invite, false
		}

		invite.From = from.UTC()
	}

	if said := strings.TrimSpace(body.Until); said != "" {
		until, err := time.Parse(time.RFC3339, said)

		// An end already past, or not after the start, is a link that could
		// never let anybody in — refused now, while whoever made it can still
		// see why, rather than discovered by the guest.
		if err != nil || !until.After(now) || (!invite.From.IsZero() && !until.After(invite.From)) {
			fail(w, http.StatusBadRequest, reasonBadTime)
			return invite, false
		}

		invite.Expires = until.UTC()
	}

	return invite, true
}

// describe is what anybody is told about an invite: the room, and whatever was
// said about who it is for and when. Never its maker, whose signature is their
// identity in every room on this deployment.
func describe(invite store.Invite) map[string]any {
	said := map[string]any{"room": invite.Room}

	// Absent rather than empty, so a page reading it does not have to tell a
	// link with no end from one whose end failed to arrive.
	if !invite.Expires.IsZero() {
		said["expires"] = invite.Expires.UTC().Format(time.RFC3339)
	}

	if !invite.From.IsZero() {
		said["from"] = invite.From.UTC().Format(time.RFC3339)
	}

	if invite.Name != "" {
		said["name"] = invite.Name
	}

	return said
}

// revokeInvites throws away every link to a room, without ending the meeting.
//
// The other way a link dies is the room being closed, which is a bigger thing
// than anybody wants to do about a link they pasted into the wrong window. This
// is that: the meeting carries on, and the link somebody sent stops working.
//
// All of them rather than one, because that is what revoking means to whoever
// presses it. A host who minted two links and killed only the newer one would
// have revoked nothing, and would have no way of knowing.
func (a *App) revokeInvites(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	gone, err := a.store.DropInvites(name, true)
	if err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	slog.Info("invites revoked", "room", name, "by", who.Mark.Trip, "gone", gone)

	respond(w, map[string]any{"revoked": gone})
}

// readInvite says what an invite is for, without spending it.
//
// The page somebody lands on has to name the room before they have typed
// anything, and looking must not burn the link — a preview in a chat client
// fetches URLs, and an invite consumed by being previewed would never work.
func (a *App) readInvite(w http.ResponseWriter, r *http.Request) {
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	invite, ok := a.store.Invite(r.PathValue("token"))
	if !ok {
		fail(w, http.StatusNotFound, reasonNoSuchInvite)
		return
	}

	now := a.now()

	if !invite.Live(now) {
		fail(w, http.StatusGone, reasonInviteExpired)
		return
	}

	// Early, with when. A link opened before its time is the right link at the
	// wrong moment, and the one useful thing to tell its holder is when to come
	// back.
	if !invite.Begun(now) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": reasonInviteNotYet,
			"from":  invite.From.UTC().Format(time.RFC3339),
		})

		return
	}

	// Not checked against whether a meeting is running this instant, which is
	// what this did and what made the link a dead one from the moment it was
	// made. A room only exists on the media server while somebody is connected
	// to it: between the host pressing start and their browser finishing its
	// handshake, between the last person leaving and the next arriving, and for
	// the whole of a meeting arranged in advance, there is no room to find — and
	// the link that was going to be sent out reported that the meeting was over.
	//
	// What ends a link is the room being closed, which throws the links away
	// with it, and the ceiling above. Both are things somebody did or a clock
	// did; neither is a gap between two connections.
	//
	// Only a standing invitation says when, and whose name it carries. An
	// ordinary link's end is the meeting's, and the day under it is a backstop
	// a guest should not be told to plan around.
	if !invite.Standing {
		respond(w, map[string]any{"room": invite.Room})
		return
	}

	respond(w, describe(invite))
}

// meeting reports whether a room is currently being held anywhere.
//
// Asked of the media server, which is the only thing that knows. Where it cannot
// be reached the answer is yes: a guest holding a link that was legitimately
// issued should not be turned away because a relay was slow to answer, and the
// ceiling on the invite is still underneath this.
func (a *App) meeting(r *http.Request, name string) bool {
	if a.control == nil {
		return true
	}

	live, err := a.control.Rooms(r.Context())
	if err != nil {
		return true
	}

	for _, one := range live {
		if one.GetName() == name {
			return true
		}
	}

	return false
}

// roomLive says whether a meeting is happening under this name.
//
// For the screen where somebody types a name they were given. Without it they
// are taken to a camera preview for a room that is not there, choose a device,
// press join, and are refused — which reads as the name being wrong only if they
// happen to remember typing it, and as the site being broken otherwise.
//
// Behind a session, because it is an answer about a name somebody else chose. A
// room here is a name and nothing else, so an endpoint that says whether a name
// is in use is an endpoint that finds meetings by guessing at them. Whoever is
// asking has already proved they belong here; a stranger gets nothing.
func (a *App) roomLive(w http.ResponseWriter, r *http.Request) {
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	// Administrators sign in at the same door as everybody else now, so one
	// check covers both.
	if _, ok := a.signedIn(r); !ok {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	respond(w, map[string]any{"live": a.meeting(r, strings.ToLower(r.PathValue("room")))})
}

// invited reports whether this request carries a live invite to this room.
//
// Checked before the opening policy and before the token, because an invite is
// how somebody gets in who can satisfy neither: they have no passphrase, they
// are not an administrator, and the name they were sent is one they could not
// have opened themselves.
func (a *App) invited(r *http.Request, name string) bool {
	token := presented(r)
	if token == "" {
		return false
	}

	_, err := a.store.Redeem(token, name, a.now())

	switch {
	case err == nil:
		return true

	// The token was no good, which is the ordinary answer and is not worth a
	// line in a log: a link that has been revoked, or has run past its day, or
	// was never one.
	case errors.Is(err, store.ErrInviteExpired), errors.Is(err, store.ErrNoSuchInvite):
		return false

	// And anything else, which is the store failing.
	//
	// Said out loud, because the two are indistinguishable from outside and
	// their causes are nothing alike. A store that will not answer refuses every
	// invitation on the deployment at once, and the only evidence available to
	// anybody was a stream of people saying their link did not work — which
	// reads as the links being wrong.
	default:
		slog.Error("could not look up an invitation, so it was refused",
			"room", name, "error", err)

		return false
	}
}

// presented is the invite a request carries: the one in the address, or the
// one a previous join left in a cookie.
func presented(r *http.Request) string {
	if token := strings.TrimSpace(r.URL.Query().Get("invite")); token != "" {
		return token
	}

	if cookie, err := r.Cookie(inviteCookie); err == nil {
		return strings.TrimSpace(cookie.Value)
	}

	return ""
}

// keepInvite leaves the spent token in a cookie, so a reload is not a refusal.
func keepInvite(w http.ResponseWriter, r *http.Request, secure bool) {
	token := strings.TrimSpace(r.URL.Query().Get("invite"))
	if token == "" {
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     inviteCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(inviteFor.Seconds()),
	})
}
