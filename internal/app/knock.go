package app

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"tomoshibi/internal/limit"
	"tomoshibi/internal/store"
)

/*
Standing at the door of a meeting that will not have you.

The join refuses somebody with no invite, no account and no claim on the room,
and that is the right answer to a stranger who guessed a name. It is the wrong
answer to somebody who was told "we're on at four" and never got the link,
which is most of the people who will ever hit it — the room is real, they are
expected, and the only thing they are missing is a URL somebody forgot to send.

So they can knock, and somebody in the room can answer. Admitting mints them an
invite and nothing else: the door already knows how to let in somebody holding
one, and a second way through it would be a second thing to keep correct.

What this does not do is tell the knocker anything. A refusal and a knock that
nobody answers look identical from outside, and a room that does not exist
looks like both — otherwise this would be a way to find out which names are in
use by knocking on them.
*/

// How long an admitted knocker's invite is good for.
//
// Minutes, not the day an ordinary invite gets. This one was made for one
// person who is standing at the door right now; the reason to be generous with
// a link somebody was sent — that it travels through a chat client and gets
// read late — does not apply to a door somebody is already at.
const admittedFor = 10 * time.Minute

func (a *App) mountKnocks(mux *http.ServeMux) {
	if a.store == nil {
		return
	}

	mux.HandleFunc("POST /api/rooms/{room}/knock", a.knock)
	mux.HandleFunc("GET /api/rooms/{room}/knock/{token}", a.atTheDoor)
	mux.HandleFunc("GET /api/rooms/{room}/knocks", a.whoIsKnocking)
	mux.HandleFunc("POST /api/rooms/{room}/knocks/{token}", a.answerKnock)
}

// knock records somebody asking to be let in.
func (a *App) knock(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	// The same budget as a join, because it is the same thing being spent:
	// without it this is a way to fill a host's screen with names, and to find
	// out which rooms exist by watching which knocks are ever answered.
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	var body struct {
		Name string `json:"name"`
	}

	// A body that will not read is a knock with no name on it, which is a knock
	// nobody can answer — but it is not worth a refusal with its own code, since
	// the only thing on the other end is a browser this deployment wrote.
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body)

	// Answered the same way whether the room exists or not.
	//
	// A knock that is refused for a name nobody has used, and one that simply
	// goes unanswered, must be indistinguishable — otherwise knocking is a way
	// to enumerate which names are meetings.
	token, err := store.NewKnockToken()
	if err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	id, err := store.NewKnockID()
	if err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	if err := a.store.Knocked(token, store.Knock{
		ID:      id,
		Room:    name,
		Name:    strings.TrimSpace(body.Name),
		Address: limit.Caller(r, a.conf.Meet.Hops()),
		State:   store.Knocking,
		At:      time.Now().UTC(),
	}); err != nil {
		slog.Error("failed to record a knock", "room", name, "error", err)
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	respond(w, map[string]any{"token": token, "state": store.Knocking})
}

// atTheDoor answers the knocker's own question: has anybody let me in.
func (a *App) atTheDoor(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	knock, err := a.store.AtTheDoor(r.PathValue("token"), time.Now().UTC())
	switch {
	case errors.Is(err, store.ErrNoSuchInvite), errors.Is(err, store.ErrInviteExpired):
		// Gone rather than refused: a knock nobody answered and one that was
		// refused are the same thing to somebody standing outside, and saying
		// which would say something about the room.
		respond(w, map[string]any{"state": store.Refused})
		return

	case err != nil:
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	if !strings.EqualFold(knock.Room, name) {
		respond(w, map[string]any{"state": store.Refused})
		return
	}

	answer := map[string]any{"state": knock.State}

	// The invite, once and to the person it was made for. It is in the store
	// against their token and reaches nobody else.
	if knock.State == store.Admitted && knock.Invite != "" {
		answer["invite"] = knock.Invite
	}

	respond(w, answer)
}

// whoIsKnocking is the list somebody in the room answers from.
func (a *App) whoIsKnocking(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	if _, ok := a.mayHost(r, name); !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	waiting := a.store.Knocking(name, time.Now().UTC())

	out := make([]map[string]any, 0, len(waiting))
	for _, one := range waiting {
		out = append(out, map[string]any{
			"id":   one.ID,
			"name": one.Name,
			// Where they are knocking from, because it is half of what somebody
			// deciding has to go on and there is nothing else. A name is typed.
			"address": one.Address,
			"at":      one.At.UTC(),
		})
	}

	respond(w, map[string]any{"knocking": out})
}

// answerKnock lets somebody in, or does not.
func (a *App) answerKnock(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	var body struct {
		Admit bool `json:"admit"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 512)).Decode(&body)

	now := time.Now().UTC()

	invite := ""
	if body.Admit {
		// Minted before the knock is marked, so a store that fails halfway
		// leaves somebody still knocking rather than admitted with nothing to
		// be admitted by.
		token, err := store.NewInviteToken()
		if err != nil {
			fail(w, http.StatusInternalServerError, reasonServerError)
			return
		}

		if err := a.store.KeepInvite(token, store.Invite{
			Room: name, By: who.Mark.Trip, Created: now, Expires: now.Add(admittedFor),
		}); err != nil {
			slog.Error("failed to mint an invite for somebody admitted", "room", name, "error", err)
			fail(w, http.StatusInternalServerError, reasonServerError)
			return
		}

		invite = token
	}

	state := store.Refused
	if body.Admit {
		state = store.Admitted
	}

	if _, err := a.store.Answered(r.PathValue("token"), name, state, invite, now); err != nil {
		fail(w, http.StatusNotFound, reasonNoSuchInvite)
		return
	}

	respond(w, map[string]any{"state": state})
}
