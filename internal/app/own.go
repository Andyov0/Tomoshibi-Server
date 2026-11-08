package app

import (
	"net/http"
	"strings"

	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
Relays somebody has of their own, as the choosing sees them. store/own.go says
what one is and why the rules are the ones they are; this is where they are
applied, and they are applied at every place a relay is chosen or handed out
rather than only where the list is drawn, for the reason a relay kept for
administrators is: the list is a courtesy and the join is the rule.

Who is asking is worked out once per request (callerOf) and carried as a
caller, so that the list a client is shown and the relay its join is given are
decided by the same answer to the same question.
*/

// reasonOwnRelayDown is a join by somebody with relays of their own when none
// of them can take the call: all out of service, none answering, or the one
// they would come in through unable to carry a meeting held elsewhere. Said
// rather than worked around, since working around it would mean sending them
// through a machine that is not theirs.
const reasonOwnRelayDown = "own_relay_unavailable"

// caller is who is asking, as far as relays are concerned.
type caller struct {
	// admin may use every relay, kept for administrators or anybody's own.
	admin bool

	// account is the account asking, where one is known; own is the relays it
	// has of its own, which is empty for nearly everybody.
	account string
	own     map[string]bool
}

// restricted reports whether this caller may use only its own relays.
func (c caller) restricted() bool { return !c.admin && len(c.own) > 0 }

// callerOf works out who is asking: an administrator, by a management session
// or by an account session or a passphrase that is one; and otherwise an
// account, by its session or by its passphrase.
//
// The session before the passphrase, as everywhere else here. Somebody signed
// in who types nothing is still themselves, and the apps never type it at all
// — they hold the account's session and nothing else.
//
// typedAdmin is what the join has already worked out from the passphrase, so
// that it is not asked twice and charged twice.
func (a *App) callerOf(r *http.Request, passphrase room.Passphrase, typedAdmin bool) caller {
	c := caller{admin: typedAdmin}

	if !c.admin && a.admin != nil {
		if _, ok := a.admin.SessionOf(r); ok {
			c.admin = true
		}
	}

	var account store.Account
	known := false

	if signed, ok := a.signedIn(r); ok {
		account, known = signed, true

		// An administrator who signed in at the front, which is how the apps
		// carry one: whoever returns them as an account with nothing on it, and
		// being one is decided by the administrator list, every time.
		if a.isAdministrator(room.Signature{Trip: signed.Trip, Proven: true}) {
			c.admin = true
		}
	} else if !passphrase.Empty() && a.store != nil {
		trip := room.Trip(a.tripKey, strings.TrimSpace(string(passphrase)))
		account, known = a.store.AccountBySignature(trip)
	}

	if known {
		c.account = account.Name

		if len(account.Relays) > 0 {
			c.own = make(map[string]bool, len(account.Relays))
			for _, name := range account.Relays {
				c.own[name] = true
			}
		}
	}

	return c
}

// mayUse reports whether a caller may be sent to a relay, shown it, or ask for
// it by name. owners is relays.owners().
func mayUse(c caller, relay store.Relay, owners map[string][]string) bool {
	switch {
	case c.admin:
		return true
	case relay.AdminOnly:
		return false
	case c.restricted():
		return c.own[relay.Name]
	default:
		return len(owners[relay.Name]) == 0
	}
}

// usable keeps the relays a caller may use, out of a list.
func usable(c caller, list []store.Relay, owners map[string][]string) []store.Relay {
	kept := make([]store.Relay, 0, len(list))
	for _, relay := range list {
		if mayUse(c, relay, owners) {
			kept = append(kept, relay)
		}
	}

	return kept
}

// mayHoldOn reports whether somebody may say a meeting is held on a relay:
// moving one there, or arranging one there.
//
// Narrower than mayUse, deliberately. Where a meeting is held is not the door
// anybody comes in through — somebody with relays of their own reaches a
// meeting held anywhere through them — so an account with relays of its own is
// not refused a public relay here. What is refused is somebody else's relay,
// and one kept for administrators, as before.
func (a *App) mayHoldOn(r *http.Request, mark room.Signature, relay store.Relay) bool {
	if a.administrating(r, mark) {
		return true
	}

	if relay.AdminOnly {
		return false
	}

	owners := a.relays.owners()[relay.Name]
	if len(owners) == 0 {
		return true
	}

	if !mark.Proven || a.store == nil {
		return false
	}

	account, ok := a.store.AccountBySignature(mark.Trip)
	if !ok {
		return false
	}

	for _, owner := range owners {
		if strings.EqualFold(owner, account.Name) {
			return true
		}
	}

	return false
}
