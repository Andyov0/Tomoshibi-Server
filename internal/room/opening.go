package room

// Opening is who may use a name nobody has used before.
//
// The distinction exists only because a room here is a name and nothing else.
// There is no object to create and no membership to join, so opening a room is
// not an operation anybody performs — it is what happens the first time a name
// is spoken, and the only trace of it is a tally written down afterwards. A
// policy about it is therefore a policy about first use, and the one place it
// can be enforced is the one place that tally is written.
//
// Which is also its whole scope. A name already in use is untouched by any of
// this: a meeting in progress can never be interrupted by a policy that only
// ever looks at names nobody has spoken.
type Opening string

const (
	// ByAnyone leaves a name nobody has used free to whoever asks for it. What
	// this server has always done, and what an anonymous meeting link means
	// everywhere it appears.
	ByAnyone Opening = "anyone"

	// BySigned refuses one unless whoever asked can prove a name.
	//
	// The middle setting, and the one most deployments actually want. An
	// anonymous visitor has a signature drawn from nothing that changes on every
	// tab, so they can join any room somebody tells them about but cannot make
	// one; anybody who has set a passphrase can. It costs nothing to satisfy and
	// it is the whole of the difference between a meeting server and a thing
	// that gets found and used by strangers.
	BySigned Opening = "signed"

	// ByAccounts refuses one unless whoever asked is signed in.
	//
	// The setting BySigned reads as and is not. "Signed" there means a
	// signature, which anybody makes by typing anything into the passphrase
	// box — so a deployment that had thought about who may start a meeting was
	// still one where a stranger could start one and use the bandwidth. This is
	// the one that means what that sounds like: an account on this deployment,
	// which somebody has to have been given.
	//
	// Between the two rather than replacing either. A deployment where the
	// people who hold meetings are the people with accounts wants this;
	// BySigned is still right where a passphrase is the whole identity model
	// and there are no accounts at all.
	ByAccounts Opening = "accounts"

	// ByAdmins refuses one unless the passphrase that came with the request is
	// an administrator's.
	ByAdmins Opening = "admins"
)

// Valid reports whether this is a setting this server understands.
func (o Opening) Valid() bool {
	return o == ByAnyone || o == BySigned || o == ByAccounts || o == ByAdmins
}

// Offered reports whether this is a setting the management pages put in front
// of somebody.
//
// The two that are not offered both mean "anybody may start a meeting here",
// and one of them looks as though it does not. ByAnyone says so plainly.
// BySigned asks for a signature, which is made by typing anything at all into
// the passphrase box — so as a barrier to starting a meeting it is the same
// barrier, and sitting between ByAnyone and ByAccounts in a list it reads as a
// step between them rather than as the other end.
//
// They stay settable in a file. A deployment whose identity model is a
// passphrase and which has no accounts wants BySigned, and one that is open on
// purpose wants ByAnyone — but both are then a line somebody wrote meaning it,
// said in the log at every start, rather than the first two options on a page.
func (o Opening) Offered() bool {
	return o == ByAccounts || o == ByAdmins
}

// InEffect resolves a policy against how many administrators there are to
// satisfy it.
//
// Asking for an administrator where nobody is configured as one is not a policy
// but a locked door with no key: no request could ever satisfy it, and every
// name nobody has used would be refused for as long as the deployment lasts.
// Read as ByAnyone instead, and said out loud at startup — the alternative is a
// server that looks like it is working and turns everybody away.
//
// Anything unrecognised is read the same way, on the same principle the store
// applies to a record it cannot parse: the default is the state a deployment
// that never touched this is in, and nothing here should be able to keep
// somebody out of a meeting by being unreadable.
func (o Opening) InEffect(admins int) Opening {
	if !o.Valid() || (o == ByAdmins && admins == 0) {
		return ByAnyone
	}

	return o
}
