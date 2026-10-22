package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

/*
Moving a meeting, and moving one person into it a different way.

A meeting lives on exactly one machine. The media server binds a room to
whichever node opened it and forwards everybody else there, and there is no
migration in it: a call cannot be handed from one node to another while it is
running, by this server or by anybody.

So "switch the server" has two honest meanings and they are different actions,
which is why both are offered rather than one being quietly chosen. Setting where
the room is held applies to the next call under that name and leaves the one in
progress alone — the right answer for a recurring meeting somebody wants held
somewhere better next time. Moving it now ends the call so everybody comes back,
and they come back to the machine that was chosen; that is disruptive and is said
so on the page, because a control that ends a meeting must not be pressed by
somebody who thought it would not.

Moving one person is the smaller of the two and, with forwarding, a real thing:
which relay somebody enters through is theirs alone, separate from where the room
is. It cannot be changed underneath them — a browser holds its connection to the
machine it dialled, and nothing in the protocol asks it to move. What can be done
is to record where they should come in next time and let go of them, which is
being removed with a reason. Said plainly rather than dressed up.
*/

// Placing is where a room should be held.
type Placing interface {
	HoldRoom(room, relay string) error
	HeldOn(room string) (string, bool)
	PlaceRoom(room, relay string) error
	ReleaseRoom(room string) error
	PinEntry(room, identity, relay string) error
}

func (a *API) placeRoom(session Session, w http.ResponseWriter, r *http.Request) {
	if a.placing == nil {
		a.detached(w)
		return
	}

	name := strings.ToLower(r.PathValue("room"))

	var body struct {
		Relay string `json:"relay"`
		// Now ends the call so everybody comes back to the new machine. Absent,
		// the change waits for the next one.
		Now bool `json:"now"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	relay := strings.TrimSpace(body.Relay)

	// Checked against the list rather than taken on trust. A name nobody has
	// would be written down, believed at the next join, and found to be nothing
	// — at which point the room goes wherever the policy picks and the page
	// still says it is somewhere else.
	if !a.knownRelay(relay) {
		refuse(w, http.StatusBadRequest, "no_such_relay")
		return
	}

	if err := a.placing.PlaceRoom(name, relay); err != nil {
		a.record(session, "place room", name, relay, err)
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	a.record(session, "place room", name, relay, nil)

	if !body.Now {
		respond(w, map[string]any{"room": name, "relay": relay, "moved": false})
		return
	}

	// Ending it is what moves it, and saying so first is what makes it a move
	// rather than an ending.
	//
	// A client cannot tell the two apart: the media server disconnects everybody
	// the same way whether a meeting is over or is being put up somewhere else,
	// and the right answer is opposite in each case. So they are told, and then
	// it happens — in that order, because the message has to reach a room that
	// still exists.
	//
	// Told rather than guaranteed. The message is lossy on purpose: a reliable
	// one would be retried into a room that is about to stop existing, and the
	// retry would outlive the thing it is about. Somebody it does not reach is
	// left exactly where everybody was before this existed, which is one press
	// from being back.
	if !a.attached() {
		a.detached(w)
		return
	}

	// Everybody is told, then the room is destroyed, and only then is it put
	// back up on the machine it was moved to.
	//
	// The order is the whole of it, and the first two attempts got it wrong in
	// opposite directions.
	//
	// Closing a room destroys it everywhere. The next person to connect creates
	// it again, on whichever node their own entry relay hands them to — so the
	// meeting landed wherever whoever reconnected fastest happened to be, while
	// the record said the machine the operator had chosen. A control that
	// reports success and does nothing is worse than one that fails.
	//
	// Putting the room up on the target first does not fix that, because the
	// close that follows takes down the room that was just put up: `Close` is by
	// name and reaches every node, including the one being moved to. That is
	// what shipped, and it looked exactly like the original fault, because it
	// was the original fault.
	//
	// So the empty room is created after the close, and it is what everybody
	// rejoins into. A room that already exists is not created again, and the
	// node it exists on is the one it was pinned to.
	//
	// The gap between destroying and recreating is two calls in one handler,
	// against a browser that has to notice it was disconnected before it can
	// try again. Should one ever win that race, the placement written down a
	// moment ago still sends it to the right entry, which is where this stood
	// before any of it.
	if err := a.control.Announce(r.Context(), name, "moving", []byte(relay)); err != nil {
		// Not fatal. A move nobody was warned about is still a move, and
		// refusing here would leave the room where it is for the sake of a
		// courtesy.
		a.record(session, "announce move", name, relay, err)
	} else {
		a.letItArrive(r.Context())
	}

	if err := a.control.Close(r.Context(), name); err != nil {
		a.record(session, "move room", name, relay, err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	// The node is asked for now rather than read from the record.
	//
	// A media server's node identifier is assigned when the process starts, so
	// it changes on every restart and anything written down is stale by the next
	// upgrade. The first version of this read it from the relay's record, where
	// it is not written at all — so the hold never happened and nothing said so.
	// Moved to Shanghai, landed on Hong Kong, and the only evidence was the
	// meeting being in the wrong place.
	//
	// Said out loud when it cannot be done, because a move that quietly does
	// nothing is what this whole change is about. The move itself still stands:
	// the room is closed and the placement is written, which is what it did
	// before any of this, and it is announced as having moved because it has.
	node, err := a.nodeOf(r.Context(), relay)
	if err == nil {
		err = a.control.Hold(r.Context(), name, node)
	}

	if err != nil {
		a.record(session, "hold room", name, relay, err)

		// Answered as a failure, not as a move with a footnote.
		//
		// The call has already ended by this point and the placement is already
		// written, so the room does go to the chosen machine at the next join —
		// this is not a rollback and there is nothing to undo. What it is not is
		// the thing that was asked for: the room was to be put up there and it
		// was not, so whoever comes back first decides which node holds the
		// media, and that is a coin toss.
		//
		// Reported because a control that says it worked when it half worked is
		// how the original fault stayed hidden for a week. The operator can
		// press it again once whatever is wrong with that relay is fixed.
		refuse(w, http.StatusBadGateway, "not_held_there")
		return
	}

	a.record(session, "move room", name, relay, nil)

	respond(w, map[string]any{"room": name, "relay": relay, "moved": true})
}

func (a *API) placePerson(session Session, w http.ResponseWriter, r *http.Request) {
	if a.placing == nil {
		a.detached(w)
		return
	}

	name := strings.ToLower(r.PathValue("room"))
	identity := r.PathValue("identity")

	var body struct {
		Relay string `json:"relay"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	relay := strings.TrimSpace(body.Relay)

	if !a.knownRelay(relay) {
		refuse(w, http.StatusBadRequest, "no_such_relay")
		return
	}

	if err := a.placing.PinEntry(name, identity, relay); err != nil {
		a.record(session, "place person", name, identity, err)
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	// And then let go of them, because nothing else will. A browser holds its
	// connection to the machine it dialled and there is no message in the
	// protocol that asks it to move; the only way somebody comes in through a
	// different door is by coming in again.
	if !a.attached() {
		a.detached(w)
		return
	}

	// Warned first, and only them.
	//
	// Letting go of somebody is how they are moved -- a browser holds its
	// connection to the machine it dialled and nothing in the protocol asks it
	// to move -- but the only thing they were told was that they had been
	// removed, which is what the client says when a host throws somebody out.
	// So an operator putting one person on a healthier relay sent them a notice
	// that they had been ejected from the meeting, and a dead call.
	//
	// Addressed to them rather than said to the room. A message on this topic
	// arms a tab to come back after the next disconnection, and broadcasting it
	// would arm every tab in the room -- so the next time a host legitimately
	// ended the meeting, everybody would rebuild it.
	//
	// Not fatal. A move nobody was warned about is still a move, and the person
	// is one press from being back either way.
	if err := a.control.Tell(r.Context(), name, identity, "placing", []byte(relay)); err != nil {
		a.record(session, "announce placing", name, identity, err)
	} else {
		a.letItArrive(r.Context())
	}

	if err := a.control.Remove(r.Context(), name, identity); err != nil {
		a.record(session, "place person", name, identity, err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	a.record(session, "place person", name, identity, nil)

	respond(w, map[string]any{"room": name, "identity": identity, "relay": relay})
}

// knownRelay reports whether this is a relay this deployment has.
func (a *API) knownRelay(name string) bool {
	if name == "" || a.relays == nil {
		return false
	}

	list, err := a.relays.Relays()
	if err != nil {
		return false
	}

	for _, relay := range list {
		if relay.Name == name {
			return true
		}
	}

	return false
}

// nodeOf asks a relay what its media server is calling itself today.
//
// Live rather than remembered. The identifier is assigned at process start, so
// a relay that has been restarted — which is every relay, after every upgrade —
// has a different one from whatever was written down.
func (a *API) nodeOf(ctx context.Context, relay string) (string, error) {
	there, ok := a.relayNamed(relay)
	if !ok {
		return "", fmt.Errorf("%s is not a relay this deployment has", relay)
	}

	if a.fleet == nil {
		return "", errors.New("this node cannot reach the relays to ask which is which")
	}

	stats, err := a.fleet.AskStats(ctx, there.URL)
	if err != nil {
		return "", fmt.Errorf("ask %s which node it is: %w", relay, err)
	}

	if stats.Node == "" {
		return "", fmt.Errorf("%s did not say which node it is", relay)
	}

	return stats.Node, nil
}

// freeRoom hands a room back to the policy that would otherwise have chosen for
// it.
//
// A placement stands until somebody says otherwise, and this is somebody saying
// otherwise. It is the only way one is undone: not a timer, not the join that
// carries it out, not the call ending. An operator who pinned a room to Shanghai
// six weeks ago and has forgotten doing it is better served by a page that says
// so and a control that clears it than by a pin that quietly stopped meaning
// anything on its own.
//
// Nothing is moved. The meeting in progress stays where it is — this is about
// where the next one goes — and saying so is left to the page, because a control
// that ended a call to stop preferring a machine would be a surprising way to
// find out what it does.
func (a *API) freeRoom(session Session, w http.ResponseWriter, r *http.Request) {
	if a.placing == nil {
		a.detached(w)
		return
	}

	name := strings.ToLower(r.PathValue("room"))

	if err := a.placing.ReleaseRoom(name); err != nil {
		a.record(session, "free room", name, "", err)
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	a.record(session, "free room", name, "", nil)

	respond(w, map[string]any{"room": name, "relay": "", "moved": false})
}

// heedWarning is how long a warning that a call is about to end is given to
// arrive before the call is ended.
//
// It used to be no time at all: the warning and the disconnection were two
// calls one after the other, and the disconnection could reach a phone first.
// Measured against a local deployment, a person placed on another relay from
// Chrome on Android missed the warning twice in nine tries and was shown the
// join page with "You were removed from this room"; a computer missed it none
// of eight. Under a second is long enough for a message already sent to land
// and short enough that the operator's press still reads as immediate.
const heedWarning = 800 * time.Millisecond

// letItArrive waits for a warning to reach whoever it was for, or for the
// operator's request to be given up, whichever is first. Given up is not a
// reason to leave the move half done, so it returns either way.
func (a *API) letItArrive(ctx context.Context) {
	if a.heed <= 0 {
		return
	}
	wait := time.NewTimer(a.heed)
	defer wait.Stop()
	select {
	case <-wait.C:
	case <-ctx.Done():
	}
}
