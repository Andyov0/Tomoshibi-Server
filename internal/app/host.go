package app

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
)

/*
The person a room answers to.

Every meeting eventually needs somebody who can quiet it. Not moderation in the
management sense — that belongs to whoever runs the deployment and is behind a
different door — but the ordinary business of a call: a microphone left open in a
noisy room, somebody who will not leave, a meeting whose owner has gone home and
handed it on.

Until now the only person who could do any of that was an administrator of the
whole deployment, which is the wrong shape twice over. It gives somebody running
one meeting nothing, and it means the only way to give them something is to hand
them every room, every relay and every account.

So the room has a host: whoever first spoke its name, because there is nobody
else it could reasonably be, and transferable, because the person who opened a
recurring meeting is not always the person running it. An administrator is a host
everywhere, which is not a special case so much as what being an administrator
already meant.

Proof is the token. There are no sessions for people in a call — a join is
stateless and deliberately so — but the token this server signed for them names
one room and one identity and cannot be edited, which is exactly the claim these
requests need. Sending a passphrase back would be the alternative and a bad one:
it would put a credential on the wire for every mute.
*/

// mountHost registers what a host may do.
func (a *App) mountHost(mux *http.ServeMux) {
	if a.store == nil {
		return
	}

	mux.HandleFunc("GET /api/rooms/{room}/host", a.whoseRoom)
	mux.HandleFunc("POST /api/rooms/{room}/host", a.handOver)
	mux.HandleFunc("POST /api/rooms/{room}/mute", a.quieten)
	mux.HandleFunc("DELETE /api/rooms/{room}/people/{identity}", a.turnOut)
	mux.HandleFunc("POST /api/rooms/{room}/close", a.dissolve)
	mux.HandleFunc("PUT /api/rooms/{room}/relay", a.moveRoom)
}

// bearer is who a request proves it is, from the token it carries.
type bearer struct {
	Identity string
	Room     string
	Mark     room.Signature
}

// whoIs reads the token a request carries and says who it belongs to.
//
// Verified against the same credentials that signed it, so nothing here trusts
// a field the caller filled in. The room is taken from the grant rather than
// from the path: a token for one meeting must not act on another, and comparing
// the two is the whole of that guarantee.
func (a *App) whoIs(r *http.Request) (bearer, bool) {
	raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if raw == "" || raw == r.Header.Get("Authorization") {
		return bearer{}, false
	}

	verifier, err := auth.ParseAPIToken(raw)
	if err != nil {
		return bearer{}, false
	}

	if verifier.APIKey() != a.conf.Key {
		return bearer{}, false
	}

	_, grants, err := verifier.Verify(a.conf.Secret)
	if err != nil || grants == nil || grants.Video == nil {
		return bearer{}, false
	}

	mark, _ := room.SignatureOf(grants.Identity)

	return bearer{Identity: grants.Identity, Room: grants.Video.Room, Mark: mark}, true
}

// mayHost reports whether this request may act on this room.
//
// Two ways in, and the second is not a courtesy: an administrator locked out of
// a room they can already close from the management pages would be an
// inconsistency somebody would work around by closing it.
func (a *App) mayHost(r *http.Request, name string) (bearer, bool) {
	who, ok := a.whoIs(r)

	// A management session outranks everything, including its own bearer.
	//
	// This used to be reached only after the join token verified, so an
	// administrator was refused by the expiry of a credential that has nothing
	// to do with why they may act. A join token lasts five minutes by design —
	// it authorises one join and is not meant to be carried around — and the
	// page holds it for the length of the meeting. Every host control therefore
	// began answering "not yours" about five minutes in, to the person who can
	// close the room from the management pages, which is the exact
	// inconsistency the comment above this function was written about.
	//
	// The room is still named, because a session is permission to act on this
	// deployment's rooms rather than a licence to send requests without saying
	// where.
	//
	// The rooms capability rather than moderate, because these are the acts
	// the management pages put behind it — closing, removing, muting, moving —
	// reached from the meeting instead. Moderate holds it, so every moderator
	// keeps this; asked as moderate, an administrator given the rooms alone
	// could close a meeting from one page and be told it was not theirs on the
	// other.
	if a.admin != nil {
		if session, live := a.admin.SessionOf(r); live && session.Allows(config.ManageRooms) {
			if ok && who.Room == name {
				return who, true
			}

			// Acting without a usable bearer, which is what an expired one is.
			// The identity is unknown and unnecessary: what follows from this is
			// authority over the room, not a claim about who is in it.
			//
			// The mark is the session's, which is who is acting. It was left
			// empty, which cost nothing while it went only into a log line, and
			// costs an invitation now: one minted to a scoped room records its
			// maker, and the store checks that maker is still entitled every
			// time the link is used — an empty one is entitled to nothing.
			return bearer{Room: name, Mark: room.Signature{Trip: session.Trip, Proven: true}}, true
		}
	}

	// A room held under a scope has no host on record, and answers to every
	// member instead. See scope.go.
	if _, scope := room.Split(name); scope != "" {
		return a.mayHostScoped(r, name, scope, who, ok)
	}

	// And an account session, which is a credential with a life measured in
	// weeks rather than in the five minutes a join token gets.
	//
	// The token is what the page has, and it is spent on the connect and then
	// carried for the length of the meeting — so every host control stopped
	// working a few minutes in, for everybody, whatever they were. An
	// administrator noticed first because they have the most buttons.
	//
	// The mark is the account's, which is the same mark the join was made with:
	// signing in is what earns it, and it is what the room was claimed under.
	if !ok || who.Room != name {
		if account, in := a.signedIn(r); in {
			mark := room.Signature{Trip: account.Trip, Proven: true}

			if a.administrating(r, mark) {
				return bearer{Room: name, Mark: mark}, true
			}

			if host := a.store.HostOf(name); host != "" && host == account.Trip {
				return bearer{Room: name, Mark: mark}, true
			}
		}

		return bearer{}, false
	}

	if a.administrating(r, who.Mark) {
		return who, true
	}

	host := a.store.HostOf(name)

	// The mark has to have been earned.
	//
	// An issued mark is drawn from nothing and, crucially, is not chosen by this
	// server: a client sends back the identity it was given, and one carrying no
	// passphrase matches whatever it likes. So anybody could send an identity
	// bearing the host's mark and be the host — and the mark was on screen,
	// beside the host's name, in every roster. Comparing an unearned mark
	// authorises nothing at all, which is worse than not comparing.
	//
	// A room with no host answers to nobody. That is not the same as answering
	// to everybody, and reading it that way would make the first person to ask
	// the host of any room whose record predates this.
	return who, who.Mark.Proven && host != "" && host == who.Mark.Trip
}

// administrating reports whether this request is an administrator's, by any of
// the three ways somebody can be one.
//
// The mark alone was the whole test, and it is the one that fails in the case
// that matters. It only says what the identity was minted from: somebody who
// followed an invitation is a guest by design and carries a mark drawn from
// nothing, and somebody who joined without typing their passphrase carries
// nothing either. Both of them can be sitting in the management pages in the
// next tab, and both were told a room they administer was not theirs.
//
// So a session counts as well — the management one, and an account's where that
// account is an administrator. All three answer the same question and no two of
// them answer it in the same place, which is precisely why one of them was
// missed.
func (a *App) administrating(r *http.Request, mark room.Signature) bool {
	if a.mayModerate(mark) {
		return true
	}

	// A management session, and only one that may act on rooms.
	//
	// The management pages are careful about the difference: closing a room,
	// removing somebody and muting a track are all behind the rooms capability
	// there, which moderate carries. This door asked only whether somebody was
	// signed in, so an administrator trusted to look and not to touch could
	// close any meeting, take any room, and place one on a machine reserved for
	// administrators — the whole capability split bypassed for anything
	// room-shaped.
	if session, ok := a.admin.SessionOf(r); ok {
		return session.Allows(config.ManageRooms)
	}

	if account, ok := a.signedIn(r); ok {
		return a.mayModerate(room.Signature{Trip: account.Trip, Proven: true})
	}

	return false
}

// mayModerate reports whether a mark belongs to an administrator who may act
// on rooms rather than only watch.
//
// The rooms capability, for the reason mayHost asks for it: an administrator
// given the fleet or the accounts and not the rooms has no more business ending
// somebody's meeting from inside it than from the management pages.
func (a *App) mayModerate(mark room.Signature) bool {
	if !mark.Proven {
		return false
	}

	for _, one := range a.administrators() {
		if one.Trip == mark.Trip {
			return one.Allows(config.ManageRooms)
		}
	}

	return false
}

// isAdministrator reports whether a mark is one, without a management session.
func (a *App) isAdministrator(mark room.Signature) bool {
	if !mark.Proven {
		return false
	}

	for _, one := range a.administrators() {
		if one.Trip == mark.Trip {
			return true
		}
	}

	return false
}

func (a *App) whoseRoom(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.whoIs(r)
	if !ok || who.Room != name {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	admin := a.administrating(r, who.Mark)

	// The same question every control asks, asked the same way, so the panel
	// cannot offer what the controls will refuse. It compared the host's mark
	// here by hand, which was the same answer until a room under a scope, with
	// no host to compare against, had to be answered as well.
	_, yours := a.mayHost(r, name)

	respond(w, map[string]any{
		// Whether the person asking is it, worked out here rather than left to
		// the client to compare: the client would have to be told the host's
		// mark to make the comparison, and a mark is somebody's identity in
		// every room on this deployment.
		// The host's own mark is deliberately not among these.
		//
		// It was, and it is the thing an impostor needs: a mark is somebody's
		// identity in every room on this deployment, and handing it to everybody
		// in the call turned "be the host" into "send back the mark you were
		// shown". What anybody needs to know is whether they may act, which is a
		// yes or a no about themselves.
		"yours": yours,
		"admin": admin,
	})
}

func (a *App) handOver(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	// Nothing to hand over. A room under a scope answers to every member, so
	// writing a host down would make one where there is meant to be none — and
	// the one written would keep the room after leaving the scope.
	if _, scope := room.Split(name); scope != "" {
		fail(w, http.StatusConflict, reasonScopedRoom)
		return
	}

	var body struct {
		To string `json:"to"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	// Named by identity and stored by mark. The client is looking at a roster of
	// identities and has no business being told anybody's mark — a mark is who
	// somebody is in every room here, and a page that listed them would be
	// handing out the thing the whole scheme rests on.
	mark, valid := room.SignatureOf(strings.TrimSpace(body.To))

	if !valid {
		fail(w, http.StatusBadRequest, reasonNoSuchPerson)
		return
	}

	// Handed only to somebody who can prove the name they are being handed it
	// under. An issued mark belongs to a tab rather than to a person and can be
	// worn by anybody who reads it, so a room parked on one answers to whoever
	// asks — which is not a host, it is an unlocked door with a label on it.
	//
	// A refusal of its own rather than the one above. Both used to answer
	// no_such_person, which the panel reads as somebody having left, so a host
	// handing the room to a guest sitting in the call was told the guest had
	// gone. What the host needs to hear is the way out: the guest rejoins with
	// a passphrase.
	if !mark.Proven {
		fail(w, http.StatusBadRequest, reasonNotProven)
		return
	}

	if err := a.store.SetHost(name, mark.Trip); err != nil {
		slog.Error("failed to hand over a room", "room", name, "error", err)
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	slog.Info("room handed over", "room", name, "from", who.Mark.Trip, "to", mark.Trip)

	// Everybody in the room is told, because nothing else would tell them.
	//
	// The standing is asked for once on joining and again on the events that
	// might mean it changed, and the list of those events is somebody leaving
	// and the connection changing state. A handover is neither. So the person
	// giving it away kept a panel full of controls that had all begun answering
	// 403, the person receiving it saw nothing at all, and the two of them found
	// out when an unrelated third person left the call.
	//
	// Not fatal. The handover is written down and is what every later request
	// will be answered against; this only decides whether two screens catch up
	// now or in a minute.
	if a.control != nil {
		if err := a.control.Announce(r.Context(), name, "host", []byte(mark.Trip)); err != nil {
			slog.Warn("handed a room over but could not tell the room", "room", name, "error", err)
		}
	}

	respond(w, map[string]any{"host": mark.Trip})
}

func (a *App) quieten(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	var body struct {
		Identity string `json:"identity"`
		Track    string `json:"track"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	if a.beyond(r, who.Mark, body.Identity) {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	if err := a.acting(r, func(control admin.Control) error {
		return control.Mute(r.Context(), name, body.Identity, body.Track)
	}); err != nil {
		fail(w, http.StatusBadGateway, reasonMediaUnreachable)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (a *App) turnOut(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	identity := r.PathValue("identity")

	// Removing oneself is leaving, and the button for that is elsewhere. Refused
	// here because a host who did it would leave a room with a host who is not
	// in it and nobody able to take over.
	if identity == who.Identity {
		fail(w, http.StatusBadRequest, reasonNoSuchPerson)
		return
	}

	if a.beyond(r, who.Mark, identity) {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	if err := a.acting(r, func(control admin.Control) error {
		return control.Remove(r.Context(), name, identity)
	}); err != nil {
		fail(w, http.StatusBadGateway, reasonMediaUnreachable)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// dissolve ends the meeting for everybody at once.
//
// The one control here that is not about a person. Removing somebody is a
// judgement about them; this is the host saying the meeting is over, and it has
// to reach everybody — a host who leaves a room they cannot close leaves a
// meeting that goes on without them, under a name they will use again next week.
//
// Three things happen and the order is the point. The links go first, because an
// invite outliving the room it was to would be a way back into a name the host
// deliberately ended — and a room here is a name, so the next meeting held under
// it would inherit them. The room record lets go of its relay, so nothing sends
// the next person to a machine that is no longer holding anything. And the media
// server ends the room last, which is what actually disconnects everybody, with
// a reason their client can tell apart from being removed.
func (a *App) dissolve(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	// Not a standing invitation into a scoped room, which is not the meeting's.
	// It was made by a member for another day, often by somebody who is not in
	// this call — and Monday's meeting ending is no reason for Tuesday's client
	// to find their link dead. Keeping somebody out after this is a revocation,
	// which is a separate press and takes every link.
	if gone, err := a.store.DropInvites(name, false); err != nil {
		slog.Error("failed to drop the invites to a closed room", "room", name, "error", err)
	} else if gone > 0 {
		slog.Info("dropped invites to a closed room", "room", name, "gone", gone)
	}

	if err := a.store.ReleaseRoom(name); err != nil {
		slog.Error("failed to release a closed room", "room", name, "error", err)
	}

	// The meeting arranged here, if there was one, is over: a link opened
	// tomorrow should say so rather than hand out the invitation just dropped.
	if err := a.store.End(name, time.Now().UTC()); err != nil {
		slog.Error("failed to end a closed room's arranged meeting", "room", name, "error", err)
	}

	if err := a.acting(r, func(control admin.Control) error {
		return control.Close(r.Context(), name)
	}); err != nil {
		// Said out loud, because the two halves have come apart: the links are
		// gone and the meeting is not. Whoever pressed this is looking at a room
		// that did not close, and the honest answer is that it did not.
		slog.Error("failed to close a room", "room", name, "error", err)
		fail(w, http.StatusBadGateway, reasonMediaUnreachable)
		return
	}

	slog.Info("room closed", "room", name, "by", who.Mark.Trip)

	w.WriteHeader(http.StatusNoContent)
}

// moveRoom puts the meeting on another machine, without ending it.
//
// The host's own version of what the management pages can do, and it is
// deliberately narrower in one place: a relay reserved for administrators is not
// one a host may send a room to. That is enforced here rather than by leaving it
// off the list, because a list is a courtesy and a check is a rule — the name
// travels in a request anybody can write, and somebody who read it off a
// colleague's screen would otherwise have found the reservation to be decoration.
//
// The meeting does not stop. Everybody is told the room is moving, and then it
// is taken down: their clients hear the first, treat the second as a move rather
// than an ending, and come straight back to the machine written down a moment
// earlier.
func (a *App) moveRoom(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	var body struct {
		Relay string `json:"relay"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	wanted, found := a.relays.named(strings.TrimSpace(body.Relay))
	if !found {
		fail(w, http.StatusBadRequest, reasonNoSuchRelay)
		return
	}

	if wanted.AdminOnly && !a.administrating(r, who.Mark) {
		fail(w, http.StatusForbidden, reasonRelayNotAllowed)
		return
	}

	if err := a.store.PlaceRoom(name, wanted.Name); err != nil {
		slog.Error("failed to move a room", "room", name, "error", err)
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	// Said before it happens, and to a room that still exists. A client cannot
	// tell a meeting that is over from one being put up elsewhere — the media
	// server ends both the same way — and the two want opposite answers.
	if err := a.acting(r, func(control admin.Control) error {
		return control.Announce(r.Context(), name, "moving", []byte(wanted.Name))
	}); err != nil {
		slog.Error("failed to announce a move", "room", name, "error", err)
	}

	if err := a.acting(r, func(control admin.Control) error {
		return control.Close(r.Context(), name)
	}); err != nil {
		fail(w, http.StatusBadGateway, reasonMediaUnreachable)
		return
	}

	slog.Info("room moved", "room", name, "to", wanted.Name, "by", who.Mark.Trip)

	respond(w, map[string]any{"relay": wanted.Shown()})
}

// beyond reports whether somebody is out of this caller's reach.
//
// A host runs their meeting and an administrator runs the deployment the meeting
// is happening on, so the second outranks the first — and it did not: a host
// could quiet an administrator, or put them out of a room they administer, which
// inverts the whole arrangement at the one moment it matters.
//
// Read from the identity, which is signed into the token and is the only thing
// about a participant that neither they nor anybody else can change. An
// administrator joined as a guest carries no mark and is not protected here,
// which is honest rather than a gap: nothing in that call says who they are, and
// a rule that guessed would be worse than one that does not.
func (a *App) beyond(r *http.Request, caller room.Signature, identity string) bool {
	if a.administrating(r, caller) {
		return false
	}

	mark, ok := room.SignatureOf(identity)

	return ok && a.isAdministrator(mark)
}

// acting runs something against whichever media server is holding the rooms.
//
// The same one the management pages use, because there is only one and because
// having two ways to reach it is how they come to disagree. Nil where a
// deployment holds no media at all, which is a refusal rather than a panic.
func (a *App) acting(_ *http.Request, do func(admin.Control) error) error {
	control := a.control
	if control == nil {
		return errors.New("no media server to act on")
	}

	return do(control)
}

// hostOnOpening records who a freshly opened room answers to.
//
// Called on every join and does nothing on all but the first, because a room
// that already has a host is not looking for one — a later arrival becoming host
// by walking in is the fault this guards against, and it would be invisible
// until somebody used it.
func (a *App) hostOnOpening(name string, grant room.Grant) {
	mark, ok := room.SignatureOf(grant.Identity)

	// Only a mark somebody can prove. A room opened by an anonymous visitor
	// therefore answers to nobody, which is the honest outcome: their mark is
	// drawn from nothing, changes with every tab, and can be worn by anybody who
	// sees it, so recording it as the host would be recording that the room
	// belongs to whoever asks.
	if !ok || !mark.Proven {
		return
	}

	// Claimed rather than checked and then set. The check used to be a separate
	// read, which left a gap two people opening the same name at once both fit
	// through — and the room answered to whichever of them the store wrote last.
	if _, err := a.store.ClaimHost(name, mark.Trip); err != nil {
		slog.Error("failed to record who opened a room", "room", name, "error", err)
	}
}
