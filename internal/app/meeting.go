package app

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
Meetings arranged ahead of time.

The store file carries the argument for what an arrangement is; this file is
the door to it. Three things come through here: a host arranging one and being
handed the link, a person holding the link asking whether it has begun, and the
host's own join, which is what begins it.

## Who may arrange one

Somebody signed in. Not somebody with a passphrase in a field — the lobby is
where arranging is offered, the lobby is for accounts, and an account is a
signature this deployment already vouches for. The meeting's host is that
signature, which is also what the room recognises them by when they walk in.

Not on a name somebody else is already host of. Without that rule any account
could arrange a meeting on a room another person holds every day, walk in, and
be handed working invitations to it: the mint on beginning is keyed only to the
arrangement's host, and the arrangement would be theirs. The refusal is made at
the moment of arranging rather than at the meeting, when it can still be acted
on by picking another name.

Not where joining asks for an account. Under that policy an invitation is
ignored at the door, so everything this hands out would be refused, and the
kind thing is to say so before a link exists rather than to twenty people on
the day.

## What the link tells a stranger

The room's name, which is in the link already; when; where it is held, by a
relay name that is public anyway; and whether it has begun. The last is a
presence signal — somebody holding the link can tell when the host is in the
room — and that is accepted: the link is sent to people the host means to have
in the room, and knowing the host has arrived is what they are waiting for.

The token itself cannot be enumerated: it is derived under a key from an id
minted from twenty-four random bytes.
*/

const (
	reasonNoSuchMeeting = "no_such_meeting"
	reasonRoomArranged  = "room_already_arranged"
	reasonBadTime       = "bad_time"
	reasonNeedsInvites  = "meetings_need_invites"
	reasonNotSignedIn   = "not_signed_in"
	reasonTooMany       = "too_many_meetings"
)

/*
How far ahead a meeting may be arranged, and how far behind.

Sixty days ahead, because an arrangement is swept a day after its time and a
record that cannot be swept for a year is a record that costs the store for a
year. An hour behind, because a form filled in slowly should not be refused for
having been filled in slowly.
*/
const (
	arrangesAhead  = 60 * 24 * time.Hour
	arrangesBehind = time.Hour
)

/*
How many a host may have pending at once.

Enough for anybody arranging their own week, and a bound on what one account
can write into the store: every join on a name walks the meetings bucket, and
that walk is only cheap while the bucket is.
*/
const arrangesAtOnce = 20

func (a *App) mountMeetings(mux *http.ServeMux) {
	if a.store == nil {
		return
	}

	mux.HandleFunc("POST /api/meetings", a.arrange)
	mux.HandleFunc("GET /api/meetings", a.arrangements)
	mux.HandleFunc("GET /api/meetings/{token}", a.arranged)
	mux.HandleFunc("DELETE /api/meetings/{id}", a.cancelMeeting)
}

// arranging is what a host asks for.
type arranging struct {
	Room  string `json:"room"`
	At    string `json:"at"`
	Relay string `json:"relay"`
}

// arrangement is what everybody is told about one, host and guest alike.
type arrangement struct {
	ID      string `json:"id"`
	Room    string `json:"room"`
	At      string `json:"at"`
	Relay   string `json:"relay,omitempty"`
	Started bool   `json:"started"`
	Ended   bool   `json:"ended"`
	// Token is the secret in the link, said only to the host.
	Token string `json:"token,omitempty"`
	// Mine is whether whoever is asking arranged it.
	Mine bool `json:"mine,omitempty"`
	// Invite is the way in, said only once it has begun and while it is good.
	Invite string `json:"invite,omitempty"`
	// From is when the host may begin it, which is before At. Said so the
	// screen can say so, rather than offering a Start that begins nothing.
	From string `json:"from"`
}

func (a *App) told(m store.Meeting) arrangement {
	return arrangement{
		ID:      m.ID,
		Room:    m.Room,
		At:      m.At.UTC().Format(time.RFC3339),
		Relay:   m.Held,
		Started: m.Begun(),
		Ended:   m.Over(),
		From:    m.At.Add(-store.BeginsFrom).UTC().Format(time.RFC3339),
	}
}

func (a *App) arrange(w http.ResponseWriter, r *http.Request) {
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	account, ok := a.signedIn(r)
	if !ok || account.Blocked {
		fail(w, http.StatusUnauthorized, reasonNotSignedIn)
		return
	}

	// Arranging only. Reading one's meetings and cancelling them stay with
	// being signed in, so somebody whose permission is taken away can still
	// see what they already arranged and call it off rather than have it
	// stand, reserved in their name, with no way to reach it.
	if !a.holds(account.Trip, store.PermArrange) {
		fail(w, http.StatusForbidden, reasonNotAllowed)
		return
	}

	if a.joining() == room.ByAccount {
		fail(w, http.StatusConflict, reasonNeedsInvites)
		return
	}

	var body arranging
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	name := strings.ToLower(strings.TrimSpace(body.Room))
	if !room.ValidName(name) {
		fail(w, http.StatusBadRequest, reasonBadRoom)
		return
	}

	// Not a name held under a scope. An arrangement makes its name the host's
	// until it begins, and nothing here asks whether that host is a member — so
	// anybody with an account could reserve a scope's room and keep its members
	// out of it. A link with a time on it is what a scope has instead.
	if _, scope := room.Split(name); scope != "" {
		fail(w, http.StatusBadRequest, reasonScopedRoom)
		return
	}

	now := time.Now().UTC()

	// The moment is absolute and arrives as one: the client turns its local
	// wall clock into an instant before sending, and this refuses anything
	// else, because a time with no zone is a time in a zone somebody guessed.
	at, err := time.Parse(time.RFC3339, strings.TrimSpace(body.At))
	if err != nil || at.Before(now.Add(-arrangesBehind)) || at.After(now.Add(arrangesAhead)) {
		fail(w, http.StatusBadRequest, reasonBadTime)
		return
	}

	// A relay is looked up exactly as a move looks one up, because that is the
	// same act — somebody deciding where a meeting is held — and a relay only
	// administrators may choose is only theirs to choose here as well.
	held := ""

	if wanted := strings.TrimSpace(body.Relay); wanted != "" {
		relay, found := a.relays.named(wanted)
		if !found {
			fail(w, http.StatusBadRequest, reasonNoSuchRelay)
			return
		}

		mark := room.Signature{Trip: account.Trip, Proven: true, Account: true}
		if relay.AdminOnly && !a.administrating(r, mark) {
			fail(w, http.StatusForbidden, reasonRelayNotAllowed)
			return
		}

		held = relay.Name
	}

	// A name that already answers to somebody else is not on offer. See the
	// file header: this is the line between arranging a meeting and minting
	// invitations to another person's room.
	if host := a.store.HostOf(name); host != "" && host != account.Trip && a.store.Used(name) {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	if len(a.store.Arrangements(account.Trip, now)) >= arrangesAtOnce {
		fail(w, http.StatusTooManyRequests, reasonTooMany)
		return
	}

	id, err := store.NewMeetingID()
	if err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	token := store.MeetingToken(a.tripKey, id)

	meeting := store.Meeting{
		ID: id, Room: name, At: at.UTC(), Held: held, Host: account.Trip, Made: now,
	}

	switch err := a.store.Arrange(token, meeting, now); {
	case errors.Is(err, store.ErrRoomArranged):
		fail(w, http.StatusConflict, reasonRoomArranged)
		return

	case err != nil:
		slog.Error("failed to arrange a meeting", "room", name, "error", err)
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	said := a.told(meeting)
	said.Token = token
	said.Mine = true

	respond(w, said)
}

// arrangements lists the caller's own, with their links.
func (a *App) arrangements(w http.ResponseWriter, r *http.Request) {
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	account, ok := a.signedIn(r)
	if !ok || account.Blocked {
		fail(w, http.StatusUnauthorized, reasonNotSignedIn)
		return
	}

	now := time.Now().UTC()
	mine := a.store.Arrangements(account.Trip, now)

	all := make([]arrangement, 0, len(mine))
	for _, m := range mine {
		said := a.told(m)
		said.Token = store.MeetingToken(a.tripKey, m.ID)
		said.Mine = true
		all = append(all, said)
	}

	respond(w, map[string]any{"meetings": all})
}

/*
arranged is what the link answers, to anybody holding it.

Rate-limited like the other public reads, because a page left open polls this,
and answered with the invitation only while the invitation is actually good:
a closed room drops its invites, and a meeting record that went on saying
"here is your way in" about one of those would send people to a door that
turns them away and then offers to let them knock.
*/
func (a *App) arranged(w http.ResponseWriter, r *http.Request) {
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	meeting, err := a.store.Arranged(r.PathValue("token"))
	if err != nil {
		fail(w, http.StatusNotFound, reasonNoSuchMeeting)
		return
	}

	now := time.Now().UTC()
	said := a.told(meeting)

	if account, ok := a.signedIn(r); ok && account.Trip == meeting.Host {
		said.Mine = true
	}

	if meeting.Begun() && !meeting.Over() && meeting.Invite != "" {
		if invite, ok := a.store.Invite(meeting.Invite); ok && now.Before(invite.Expires) {
			said.Invite = meeting.Invite
		}
	}

	respond(w, said)
}

func (a *App) cancelMeeting(w http.ResponseWriter, r *http.Request) {
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	account, ok := a.signedIn(r)
	if !ok || account.Blocked {
		fail(w, http.StatusUnauthorized, reasonNotSignedIn)
		return
	}

	dropped, err := a.store.Cancel(r.PathValue("id"), account.Trip)
	if err != nil {
		fail(w, http.StatusNotFound, reasonNoSuchMeeting)
		return
	}

	// The invitation a begun meeting handed out goes with it. That one, not
	// every invitation to the room: the host may have made others on purpose.
	if dropped.Invite != "" {
		if err := a.store.DropInvite(dropped.Invite); err != nil {
			slog.Error("failed to withdraw a cancelled meeting's invite", "room", dropped.Room, "error", err)
		}
	}

	w.WriteHeader(http.StatusNoContent)
}

/*
reservedFor says whether a name is somebody else's while their meeting is
pending, so the join can refuse to open it to anybody else.

See the store's header for why this is a refusal rather than a takeover. The
claimant is the trip the join will mint — an account's, or a passphrase's, or
nothing for a stranger — and an administrator is never asked.
*/
func (a *App) reservedFor(name, claimant string, now time.Time) bool {
	meeting, ok := a.store.ArrangedFor(name, now)

	return ok && !meeting.Begun() && meeting.Host != claimant
}

/*
arrangedPlacement is where a host's own arranged meeting is to be held, for
the join to honour before it picks anywhere else.

Only for the host, only inside the window, and only where the relay still
exists — a relay taken out of the fleet between arranging and meeting is not a
place anybody can be sent. Answers nothing for everybody else, and nothing once
the meeting has begun, because by then the placement has been written down
where every join reads it.

The join asks this whenever the room's record is not a deliberate placement,
and not only when it is empty. A record that holds a guess — the note every
join leaves for two hours — is exactly what the host's own camera test on the
name leaves behind, and an arrangement is an instruction where a guess is a
measurement; the first version asked only for an empty record, so the host's
own earlier visit made their choice disappear, and the guess was then written
down as if it had been chosen.
*/
func (a *App) arrangedPlacement(name string, grant room.Grant, now time.Time) (string, bool) {
	mark, ok := room.SignatureOf(grant.Identity)
	if !ok || !mark.Proven {
		return "", false
	}

	meeting, ok := a.store.ArrangedFor(name, now)
	if !ok || meeting.Host != mark.Trip || meeting.Begun() || !meeting.CanBegin(now) || meeting.Held == "" {
		return "", false
	}

	if _, found := a.relays.everywhere(meeting.Held); !found {
		slog.Warn("an arranged meeting names a relay this deployment no longer has, so it goes wherever suits",
			"room", name, "relay", meeting.Held)

		return "", false
	}

	return meeting.Held, true
}

/*
beginArranged is the moment a meeting starts: its host has just joined.

Everything here is best effort and says so in the log, because the join has
already succeeded and nothing about an arrangement is allowed to turn a host's
own join into a refusal. Two things happen when a meeting actually begins:

The invitation is minted and kept, so the link can hand it out.

And the room's placement is written as a deliberate one, so every guest's join
reads it from the record — never asking the media server, never ageing out —
which is what makes the host's choice hold across a call that may not have a
single participant yet when the first guest's join arrives. Only where the host
chose a machine: a meeting arranged for wherever suits is not pinned to
wherever the first join happened to land.

Nothing here makes anybody the host. The first version did, unconditionally,
and that let any account take any room whose name had gone quiet: arrange a
meeting on it, walk in, and the room was theirs. The name is reserved for the
arranger while the meeting is pending instead (see reservedFor), so by the time
this runs the room's host is the arranger or nobody, and where it is somebody
else after all — an administrator opened it, say — the meeting does not begin
in their room.
*/
func (a *App) beginArranged(name string, grant room.Grant) {
	mark, ok := room.SignatureOf(grant.Identity)
	if !ok || !mark.Proven {
		return
	}

	if host := a.store.HostOf(name); host != "" && host != mark.Trip {
		slog.Warn("an arranged meeting's name answers to somebody else, so the meeting does not begin",
			"room", name)

		return
	}

	now := time.Now().UTC()

	minted, err := store.NewInviteToken()
	if err != nil {
		slog.Error("could not mint an invite for an arranged meeting", "room", name, "error", err)
		return
	}

	began, err := a.store.Begin(name, mark.Trip, minted, now)
	switch {
	case errors.Is(err, store.ErrNoSuchMeeting), errors.Is(err, store.ErrNotTheHost):
		return

	case err != nil:
		slog.Error("failed to begin an arranged meeting", "room", name, "error", err)
		return
	}

	// Somebody else's join, or the host's second one: the meeting was already
	// under way and nothing below is for this join to do.
	if began.Invite != minted {
		return
	}

	// Written down before the invitation is handed out, so the first guest's
	// join — which may arrive within the poll — reads a placed room.
	if began.Held != "" {
		if _, found := a.relays.everywhere(began.Held); found {
			if err := a.store.PlaceRoom(name, began.Held); err != nil {
				slog.Error("failed to place an arranged meeting", "room", name, "relay", began.Held, "error", err)
			}
		}
	}

	if err := a.store.KeepInvite(minted, store.Invite{
		Room: name, By: mark.Trip, Created: now, Expires: now.Add(inviteFor),
	}); err != nil {
		slog.Error("failed to keep an arranged meeting's invite", "room", name, "error", err)
	}

	slog.Info("an arranged meeting began", "room", name, "relay", began.Held)
}
