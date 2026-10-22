package app

import (
	"net/http"
	"strings"

	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
What somebody signed in may use.

Being signed in was the whole of every feature's gate: watching together, the
music library, arranging a meeting, a standing link into a scope's room, opening
a room under the accounts policy. Each now asks one more question, of the
permissions an account carries (store/perms.go), and asks it here, in one place,
because the answer has two shapes that are easy to get half right.

An account answers from its own record. An administrator is not an account —
whoever() hands one back dressed as an account with nothing but a name, a
signature and a picture — and reading the permissions off that shape would find
none set and fall to the defaults, which is right for everything that defaults
to yes and wrong in exactly the case that matters: the Emby grant, which an
administrator holds only where somebody gave it to them. So an administrator is
recognised by the administrator list, every time, and answers from their own
record there.

Somebody who is both — an administrator whose signature also has an account —
holds what either record gives them. Taking the stricter of the two would let an
untouched box on one page undo a deliberate one on the other, and both pages are
behind the same people.

Nothing here is cached. These are asked once a request, by people pressing
things; the one path asked on every segment of a film is the relay's, which
keeps its own short memory of the answer (see watchledger.go).
*/

// The refusals particular to a permission.
const (
	// reasonNotAllowed is somebody signed in asking for something their account
	// was not given. Not not_signed_in, which tells them to sign in, which would
	// not help.
	reasonNotAllowed = "not_allowed"

	// reasonEmbyNotAllowed is a film from a media server, which this deployment
	// relays only for somebody given that, and only for what they chose
	// themselves. Its own code because it is the one refusal a person who may
	// otherwise watch together will meet, and "not allowed" alone would tell
	// them they may not watch anything.
	reasonEmbyNotAllowed = "emby_not_allowed"

	// reasonUnavailable is a video this deployment will not play for anybody:
	// a media server's film where the relay is switched off. The code and the
	// status are the gateway's own for the same answer, so a page reads it the
	// same whichever of the two said it.
	reasonUnavailable = "unavailable"
)

// holds reports whether a signature carries a permission, by whichever of the
// two lists it is in.
//
// A blocked account holds nothing. The session of a blocked account is ended by
// signedIn already, but this is also asked with no request at all — of the
// person behind a film being relayed — and blocking somebody has to stop what
// they started as well as what they would start next.
func (a *App) holds(trip, permission string) bool {
	if a.store == nil || trip == "" {
		return false
	}

	if a.isAdministrator(room.Signature{Trip: trip, Proven: true}) {
		if byDefault, known := store.Permission(permission); known && byDefault {
			return true
		}

		// Read from the stored record, which is where a grant is written. An
		// administrator who is only in the configuration file has no record
		// and so no grant, which is the safe direction for the one permission
		// that spends money.
		if admin, ok := a.store.AdminBySignature(trip); ok && admin.May(permission) {
			return true
		}
	}

	account, ok := a.store.AccountBySignature(trip)

	return ok && !account.Blocked && account.May(permission)
}

// may answers for whoever a request is signed in as: who they are, and whether
// they hold a permission. Where it returns false it has already written the
// refusal — 401 for nobody signed in, 403 not_allowed for somebody who is.
func (a *App) may(w http.ResponseWriter, r *http.Request, permission string) (store.Account, bool) {
	account, ok := a.signedIn(r)
	if !ok {
		fail(w, http.StatusUnauthorized, reasonNotSignedIn)
		return store.Account{}, false
	}

	if !a.holds(account.Trip, permission) {
		fail(w, http.StatusForbidden, reasonNotAllowed)
		return store.Account{}, false
	}

	return account, true
}

// granted lists what a signature holds, in the order a page shows them.
func (a *App) granted(trip string) []string {
	out := []string{}

	for _, permission := range store.Permissions() {
		if a.holds(trip, permission) {
			out = append(out, permission)
		}
	}

	return out
}

// typedOpens reports whether a passphrase typed into the join opens a room under
// the policy that lets any passphrase open one: every passphrase does, except
// one belonging to an account that was refused the open permission.
//
// Asked by signature and of the accounts alone. An administrator's passphrase
// was recognised before this is asked and opens anything; one belonging to
// nobody opens a room because that is what the policy says a passphrase does.
func (a *App) typedOpens(said room.Passphrase) bool {
	if a.store == nil {
		return true
	}

	account, ok := a.store.AccountBySignature(room.Trip(a.tripKey, strings.TrimSpace(string(said))))

	return !ok || account.May(store.PermOpen)
}
