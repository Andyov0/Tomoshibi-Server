package room

/*
Who may walk into a meeting that is already happening.

A room here is a name and nothing else, and for a long time that was the whole
of the door: knowing the name let you in. The invite mechanism was built around
that — an invite exists so that somebody can be let into one call without being
handed the name of every future instance of it — but nothing ever required one.
So a name short enough to guess was a meeting anybody could walk into, and the
people already in it would see somebody arrive with no way to tell how they got
there.

That is a defensible design for a deployment where the names are long and shared
carefully, and an indefensible one for a deployment whose rooms are called
things like 223223. Hence a setting rather than a change.

Separate from Opening, which is about *creating* a name. The two questions look
alike and are not: a deployment may well want anybody with an account to be able
to hold a meeting, and still not want a stranger who guessed the name to be in
it. Answering both with one setting is what made the weaker of the two invisible.
*/

// Joining is who may enter a room that already exists.
type Joining string

const (
	// ByWhoeverKnows is retired and is not offered.
	//
	// It let anybody who had the name in, which is what this deployment did
	// before the setting existed, and it is kept only so that a configuration
	// file still saying it starts rather than refusing to boot — read as
	// ByInvitation, and said out loud.
	//
	// Offered as a choice it was a setting whose right value was never the
	// permissive one: a room here is a name, so "anyone with the name" is
	// "anyone who guesses", and a deployment whose rooms are called things like
	// 223223 was one press away from an open door. The invite mechanism exists
	// precisely so that somebody can be let into one call without being handed a
	// name — offering to turn it off was offering to undo the reason it is
	// there.
	ByWhoeverKnows Joining = "anyone"

	// ByInvitation asks for something the room itself gave out: an invite, an
	// account on this deployment, an administrator's passphrase, or being the
	// person who opened the room.
	//
	// The host is in that list because they must be. A host comes back to their
	// own meeting with the passphrase they opened it with and no invite — they
	// were never sent one — and a rule that locked them out of the room they
	// are running would be worse than the one it replaced.
	ByInvitation Joining = "invited"

	// ByAccount asks for an account and takes nothing else, invites included.
	// For a deployment where everybody who is meant to be in a call has one.
	ByAccount Joining = "accounts"
)

// Valid reports whether this is a setting this server understands.
func (j Joining) Valid() bool {
	return j == ByWhoeverKnows || j == ByInvitation || j == ByAccount
}

// Offered reports whether this is a setting the management pages put in front
// of somebody.
//
// ByWhoeverKnows is understood and is not offered, and the difference is the
// point. A room here is a name, so "anybody with the name" is "anybody who
// guesses it", and the invite mechanism exists precisely so that one person can
// be let into one call without being handed a name that lets them into every
// future one. A button that turns that off is a button that undoes the reason
// it is there, and a button is pressed by whoever is looking at the page rather
// than by whoever thought about the deployment.
//
// Written in a file it is a deliberate act by somebody editing configuration,
// and it is said at startup every time. That is a different thing from a radio
// button, and it is the difference between a deployment that has chosen to
// treat room names as secrets and one where somebody clicked the top option.
func (j Joining) Offered() bool {
	return j == ByInvitation || j == ByAccount
}

// InEffect resolves a policy against whether anybody could satisfy it.
//
// A deployment set to accounts with no accounts is a deployment nobody can join
// — including whoever set it, who is then locked out of the pages that would
// let them set it back. Read as invitation instead, which is the nearest thing
// that leaves a way in, and said out loud at startup.
func (j Joining) InEffect(accounts int) Joining {
	// Anything unrecognised reads as invitation. The old reading was "leave the
	// door open", which is the wrong direction for a value nobody set on purpose.
	if !j.Valid() {
		return ByInvitation
	}

	if j == ByAccount && accounts == 0 {
		return ByInvitation
	}

	return j
}
