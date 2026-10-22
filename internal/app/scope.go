package app

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
Rooms held under a scope.

A scope is a label on accounts — a company, a team — and `standup@acme` is a room
only the people carrying `acme` may say. It is still a name and nothing else:
there is no room object, nothing created first, and nothing to clean up. What
the suffix changes is the question the join asks.

## Every time, not the first time

The door for a plain name is about opening it. Whoever first says a name decides
whether it may be opened, and after that anybody who knows it is in — which is a
fine model for a name that is long and given out carefully, and the wrong one
here. A scoped room asked only at its opening would let in anybody the name ever
reached once it had been used, and a guest's link puts the name in front of the
guest. So the scope is checked on every join: a member, an administrator, or
somebody holding a live invitation from one of those, and nobody else.

A link is worth its maker's standing, asked every time it is used: taking
somebody out of a scope takes their links with it, without anybody having to
find and revoke each one. It is asked just before the link is counted rather
than inside the same write, and the gap between the two is not worth closing —
a guest let in a moment before the tag went keeps their place for the whole
meeting anyway, because nothing puts out somebody already in the call.

The opening and joining policies do not apply. A scope is something an
administrator set up on purpose, so a room under one keeps its own rule and that
rule is the whole of it; mixing the two would leave a room whose door depends on
two settings in two places. A scoped name cannot be arranged in advance either,
because an arrangement reserves a name for its host and nothing here checks that
the host is a member.

## Nobody is the host, so everybody in it is

A scoped room has no recorded host. Every member, and every administrator given
the rooms capability (which moderate carries), runs it: mutes, removes, ends the
meeting, moves it, answers the door.
A recorded host was considered and is worse: `ClaimHost` only claims an empty
record, so a host taken out of the scope would leave the room answering to
somebody who may no longer enter it and to nobody else, for good. With no host
there is nothing to hand over, and the handover is refused.

## Closed when the store will not answer

The deployment's rule is the opposite one — a store that cannot tell an unused
name from one a meeting is happening in lets the join through and says so — and
this departs from it on purpose. That rule protects a first use: whoever it lets
through already knows the name. The scope protects every use, and a scoped room
that let people in while the store was down would be a meeting handed to anybody
who guessed its name for as long as the outage lasted. So the refusal stands,
and it is logged as an outage rather than said as a judgement about the person.
*/

// The refusals particular to a scope.
const (
	// reasonNotInScope is somebody who is not a member asking for a room held
	// under a scope. Not the same sentence as not_invited: it says who the room
	// is for, which is in the name already.
	reasonNotInScope = "not_in_scope"
	// reasonScopedRoom is something a room under a scope does not have: a host
	// to hand over, or an arrangement to reserve its name.
	reasonScopedRoom = "scoped_room"
)

// errWithdrawn is a link into a scoped room whose maker may no longer make one:
// taken out of the scope, blocked, or removed. Its own error for a log line;
// the person holding it is told the same as for a link that is gone, because
// to them it is one.
var errWithdrawn = errors.New("whoever made that invite may no longer let anybody in")

/*
admitScoped decides whether somebody may enter a room held under a scope.

In order, and the order is the policy: an account session that carries the tag
or belongs to an administrator; then a live invitation to this room; then a
passphrase that carries the tag or is an administrator's. Nothing else gets in.
Answers the invitation that let them in, nil for a member, and false having
already written the refusal.

An invitation makes its holder a guest, whatever else they brought: the caller
mints their token from neither their passphrase nor their session. A member
who wants to be themselves opens the room by its name; a guest's link is for
the guest, and the name signed into their token is the one it was made for. The
session goes first all the same. Nobody is signed in by accident, and somebody
signed in to an account in the scope is that member; turning them into a
stranger in their own group's room because a link was in their address bar
would be the door being clever at them.

An invitation that is no good does not end the asking. It may be for another
room — the cookie a previous guest visit left is sent with every join — and a
member with their passphrase who happened to be holding one is still a member.
Only when nothing else admits them is its reason the answer, and only where
that reason is about this room: a link that ran out or has not opened yet says
so, and one that names another room says nothing about this one.

Whether the passphrase belongs to an administrator was settled by the caller,
charged against the guessing budget, and is not asked again here. Asking whether
it belongs to a member is not charged a second time either: the same passphrase
was charged once at the top of the join, and a guess is one guess however many
lists it is compared against.
*/
func (a *App) admitScoped(
	w http.ResponseWriter, r *http.Request, name, scope string,
	isAdmin bool, signature string, said room.Passphrase,
) (*store.Invite, bool) {
	// Signed in, and a member. The session was read by the caller with a blocked
	// account already turned away, so a signature here is somebody in good
	// standing.
	if signature != "" && a.member(signature, scope) {
		return nil, true
	}

	// Why an invitation was turned away, kept for the refusal if nothing else
	// lets them in. Empty where there was none, or it was for some other room.
	refused := ""

	if token := presented(r); token != "" {
		invite, err := a.redeemScoped(token, name, scope)

		switch {
		case err == nil:
			return &invite, true

		case errors.Is(err, store.ErrInviteExpired):
			refused = reasonInviteExpired

		case errors.Is(err, store.ErrInviteNotYet):
			refused = reasonInviteNotYet

		// Its maker has left the scope or been blocked. Told as a link that is
		// gone, because to the person holding it that is what it is; the log
		// is for whoever has to explain it.
		case errors.Is(err, errWithdrawn):
			slog.Info("an invitation was refused because whoever made it may no longer let anybody in",
				"room", name)

			refused = reasonNoSuchInvite

		// Not this room's, or nobody's: a link that says nothing about this
		// room, and so nothing to say about it if they are turned away.
		case errors.Is(err, store.ErrNoSuchInvite):

		default:
			a.storeSilent(w, name, err)
			return nil, false
		}
	}

	if isAdmin {
		return nil, true
	}

	if !said.Empty() && a.member(room.Trip(a.tripKey, strings.TrimSpace(string(said))), scope) {
		return nil, true
	}

	// Asked once, on the way out. Every lookup above reads a store that will not
	// answer as "nobody", so this is the only point at which an outage and a
	// stranger can be told apart — and they want different sentences.
	if err := a.store.Answering(); err != nil {
		a.storeSilent(w, name, err)
		return nil, false
	}

	switch refused {
	case "":
		fail(w, http.StatusForbidden, reasonNotInScope)
	case reasonInviteExpired:
		fail(w, http.StatusGone, refused)
	default:
		fail(w, http.StatusForbidden, refused)
	}

	return nil, false
}

// redeemScoped is Redeem for a room held under a scope, which first asks
// whether whoever made the link may still let anybody in.
//
// Asked before the redemption is counted rather than after, so a link refused
// for its maker is not recorded as somebody having come through it.
func (a *App) redeemScoped(token, name, scope string) (store.Invite, error) {
	if held, ok := a.store.Invite(token); ok && held.Room == name && !a.member(held.By, scope) {
		return store.Invite{}, errWithdrawn
	}

	return a.store.Redeem(token, name, a.now())
}

/*
member reports whether a signature belongs in a scope: an account carrying it
and not blocked, or an administrator of any kind, who belongs to every scope.

Asked of whoever is at the door and of whoever made the link they hold, and
both through here, because who is an administrator has one answer on this
deployment — the stored list, or the configured one where nothing is stored.
The store answered the second question itself for a while, from its own list
only, and so would have refused as withdrawn every link made by an
administrator who exists only in the configuration.
*/
func (a *App) member(trip, scope string) bool {
	mark := room.Signature{Trip: trip, Proven: true}

	return a.inScope(mark, scope) || a.isAdministrator(mark)
}

// storeSilent refuses a scoped join because nothing could say who is in it.
//
// Loud, because this is the one place an outage turns people away rather than
// letting them through, and a run of members reporting that they cannot get in
// should lead somebody to the store and not to their accounts.
func (a *App) storeSilent(w http.ResponseWriter, name string, err error) {
	slog.Error("the store did not answer, so a room held under a scope was refused",
		"room", name, "error", err)

	fail(w, http.StatusServiceUnavailable, reasonServerError)
}

// inScope reports whether a mark belongs to an account carrying a scope.
//
// Accounts only. An administrator is a member of every scope at the door, but
// running a room is the rooms capability — which moderate carries — and not
// membership, so one who may only observe, or was given only the accounts or
// the fleet, is no more the host of a scoped room than of any other: the split
// the management pages draw between looking and touching would otherwise be
// undone for every room with an `@` in it.
func (a *App) inScope(mark room.Signature, scope string) bool {
	if !mark.Proven || scope == "" {
		return false
	}

	account, ok := a.store.AccountBySignature(mark.Trip)

	return ok && !account.Blocked && account.InScope(scope)
}

// mayHostScoped is mayHost for a room held under a scope: anybody in it, by the
// token they joined with or by the session they are signed in with.
//
// Both rather than either, unlike a plain room. A join token lasts minutes and
// a member who stepped out, or who never joined, still runs the room — that is
// what having no single host means — so the session is asked whenever the token
// does not settle it.
func (a *App) mayHostScoped(r *http.Request, name, scope string, who bearer, carried bool) (bearer, bool) {
	if carried && who.Room == name && (a.administrating(r, who.Mark) || a.inScope(who.Mark, scope)) {
		return who, true
	}

	if account, in := a.signedIn(r); in {
		mark := room.Signature{Trip: account.Trip, Proven: true}

		if a.administrating(r, mark) || (!account.Blocked && account.InScope(scope)) {
			return bearer{Room: name, Mark: mark}, true
		}
	}

	return bearer{}, false
}
