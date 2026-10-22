package store

import (
	"encoding/json"
	"errors"
	"strings"

	bolt "go.etcd.io/bbolt"
)

/*
What somebody with an account may use.

Every account could use every feature an account opens, because an account was
the only line drawn: signed in, or a guest. That stopped being enough when one of
those features began to cost something per person. Relaying a film from a media
server is every byte of it, for every viewer, through whatever this deployment
pays for — and "anybody we gave a name to may spend that" is not a decision an
owner made so much as one that was never asked.

So an account carries a short list of permissions, each a word with a default.
The list is kept as overrides: a word absent from the record means its default,
which is what makes the change free for every account that existed before it —
they decode with nothing and mean exactly what they meant. Every default is
"yes" except Emby, which is "no", because Emby is the one that spends money and
the one that nobody had before this anyway.

Administrators carry the same field and read it differently. Everything that
defaults to "yes" they hold whatever the record says, because an administrator
who could be denied the music library is a curiosity rather than a control and a
page that offered the checkbox would be offering nothing. What defaults to "no"
they have to be given like anybody else, and that is the point of it: the Emby
grant spends bandwidth, and being trusted to close rooms is not the same as
being trusted to spend that.

What decides who may tick the boxes is the management API's business, not this
file's. What this file guarantees is narrower and is the part that would go wrong
silently: that a permission is only ever written by something that meant to
write it. A whole-record rewrite — somebody changing their own picture, with the
record they read when they signed in — carries the stored permissions over
rather than the ones it read, so a grant taken away a moment earlier is not put
back by a page that never knew about it.
*/

// The permissions an account can hold.
const (
	// PermWatch is starting a watch-together showing and resolving links.
	PermWatch = "watch"

	// PermEmby is choosing films from a media server's library and having this
	// deployment relay them to the room.
	PermEmby = "emby"

	// PermMusic is the music library and opening a jukebox.
	PermMusic = "music"

	// PermArrange is arranging a meeting for later.
	PermArrange = "arrange"

	// PermInvite is minting standing links into the rooms of one's own scopes.
	PermInvite = "invite"

	// PermOpen is opening a room nobody has used before.
	PermOpen = "open"
)

// permissions is every one of them, with what it means when a record says
// nothing, in the order a page lists them.
//
// The one table. Validation, the defaults, the order on the page and what an
// administrator holds implicitly are all read from here, so that a permission
// added to the list is a permission everything knows about at once.
var permissions = []struct {
	name      string
	byDefault bool
}{
	{PermWatch, true},
	{PermEmby, false},
	{PermMusic, true},
	{PermArrange, true},
	{PermInvite, true},
	{PermOpen, true},
}

// ErrUnknownPermission refuses a word the store would keep without knowing what
// it meant, which is a grant waiting for a later version to give it a meaning.
var ErrUnknownPermission = errors.New("that is not a permission this deployment knows")

// Permissions lists every permission there is, in the order a page shows them.
func Permissions() []string {
	out := make([]string, 0, len(permissions))
	for _, one := range permissions {
		out = append(out, one.name)
	}

	return out
}

// Permission reports what a permission means when nothing says otherwise, and
// whether it is one at all.
func Permission(name string) (byDefault, known bool) {
	for _, one := range permissions {
		if one.name == name {
			return one.byDefault, true
		}
	}

	return false, false
}

// May reports whether this account holds a permission.
//
// A word nobody knows is held by nobody, so a caller that misspells one fails
// closed rather than opening something to everybody.
func (a Account) May(permission string) bool {
	byDefault, known := Permission(permission)
	if !known {
		return false
	}

	if held, said := a.Perms[permission]; said {
		return held
	}

	return byDefault
}

// Granted lists the permissions this account holds, in the page's order.
func (a Account) Granted() []string {
	return granted(a.May)
}

// Effective is every permission and whether this account holds it.
//
// What a page draws its checkboxes from. The stored record says only where it
// differs from the defaults, which is the right thing to keep and the wrong
// thing to draw: a page reading it would have to know every default, and would
// be wrong the day one changed.
func (a Account) Effective() map[string]bool {
	return effective(a.May)
}

// May reports whether this administrator holds a permission.
//
// Whatever defaults to yes is held regardless of the record, and cannot be
// taken away: see the file comment. What defaults to no is held only where it
// was granted.
func (a Admin) May(permission string) bool {
	byDefault, known := Permission(permission)
	if !known {
		return false
	}

	if byDefault {
		return true
	}

	return a.Perms[permission]
}

// Granted lists the permissions this administrator holds, in the page's order.
func (a Admin) Granted() []string {
	return granted(a.May)
}

// Effective is every permission and whether this administrator holds it.
func (a Admin) Effective() map[string]bool {
	return effective(a.May)
}

func granted(may func(string) bool) []string {
	out := []string{}

	for _, one := range permissions {
		if may(one.name) {
			out = append(out, one.name)
		}
	}

	return out
}

func effective(may func(string) bool) map[string]bool {
	out := make(map[string]bool, len(permissions))

	for _, one := range permissions {
		out[one.name] = may(one.name)
	}

	return out
}

// knownPerms refuses a record carrying a word this build does not know.
func knownPerms(perms map[string]bool) error {
	for name := range perms {
		if _, known := Permission(name); !known {
			return ErrUnknownPermission
		}
	}

	return nil
}

// accountPerms keeps only what differs from the defaults.
//
// So that the record says what somebody chose about this person rather than a
// snapshot of what every default was on the day the box was ticked. A page that
// sends the whole set back — which is what a page drawing checkboxes does — and
// one that sends only the box that moved store the same thing.
func accountPerms(perms map[string]bool) map[string]bool {
	var out map[string]bool

	for name, held := range perms {
		if byDefault, known := Permission(name); known && held != byDefault {
			if out == nil {
				out = make(map[string]bool)
			}

			out[name] = held
		}
	}

	return out
}

// adminPerms keeps only grants of what is withheld by default.
//
// An administrator holds every default-yes permission whatever is written, so a
// "no" against one of those would be a record that says something nobody acts
// on — and a page that read it back would draw a box as unticked that is, in
// every way that matters, ticked.
func adminPerms(perms map[string]bool) map[string]bool {
	var out map[string]bool

	for name, held := range perms {
		if byDefault, known := Permission(name); known && !byDefault && held {
			if out == nil {
				out = make(map[string]bool)
			}

			out[name] = true
		}
	}

	return out
}

// SetAccountPerms replaces what an account may use, and nothing else.
//
// Its own transaction touching its own field, rather than a whole record handed
// to UpdateAccount, because a whole record is what a permission change has to be
// protected from: anything holding an older copy of this account — the person
// changing their own picture, a join noting when they were last seen — would
// otherwise write the older permissions back over this one.
//
// The map replaces the stored one entirely, which is what a page of checkboxes
// means by it; an empty or nil one puts every permission back to its default.
func (s *Store) SetAccountPerms(name string, perms map[string]bool) error {
	if err := knownPerms(perms); err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return ErrNoSuchAccount
		}

		key := accountKey(name)

		raw := bucket.Get(key)
		if raw == nil {
			return ErrNoSuchAccount
		}

		var account Account
		if err := json.Unmarshal(raw, &account); err != nil {
			// Not rewritten from nothing: a record this build cannot read is
			// left exactly as it is, for the build that can.
			return err
		}

		account.Perms = accountPerms(perms)

		encoded, err := json.Marshal(account)
		if err != nil {
			return err
		}

		return bucket.Put(key, encoded)
	})
}

// ChangeAccountPerms changes the permissions named, and leaves every other one
// as it is stored.
//
// What a page of checkboxes sends, one box at a time. A page used to send the
// whole set as it last drew it, and SetAccountPerms replaced the stored set
// with it — so a page that last asked half a minute ago, ticking Music, also
// sent back the Emby it had last seen, and undid another administrator's grant
// of it in between with nothing to say so. Merged here, inside the
// transaction, so that two administrators pressing different boxes on the same
// account at the same moment both have what they pressed.
func (s *Store) ChangeAccountPerms(name string, changes map[string]bool) error {
	if err := knownPerms(changes); err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return ErrNoSuchAccount
		}

		key := accountKey(name)

		raw := bucket.Get(key)
		if raw == nil {
			return ErrNoSuchAccount
		}

		var account Account
		if err := json.Unmarshal(raw, &account); err != nil {
			// Left as it is, for the reason SetAccountPerms leaves it.
			return err
		}

		merged := account.Effective()
		for permission, held := range changes {
			merged[permission] = held
		}

		account.Perms = accountPerms(merged)

		encoded, err := json.Marshal(account)
		if err != nil {
			return err
		}

		return bucket.Put(key, encoded)
	})
}

// SetAdminPerms replaces what an administrator may use, and nothing else.
//
// For the reason SetAccountPerms is its own transaction: the administrator's
// record is rewritten whole when they change their picture or their passphrase,
// and when another administrator renames them or changes their role.
func (s *Store) SetAdminPerms(trip string, perms map[string]bool) error {
	if err := knownPerms(perms); err != nil {
		return err
	}

	trip = strings.TrimSpace(trip)

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(adminsBucket)
		if bucket == nil {
			return ErrNoSuchAdmin
		}

		raw := bucket.Get([]byte(trip))
		if raw == nil {
			return ErrNoSuchAdmin
		}

		var admin Admin
		if err := json.Unmarshal(raw, &admin); err != nil {
			return err
		}

		admin.Perms = adminPerms(perms)

		encoded, err := json.Marshal(admin)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(trip), encoded)
	})
}

// ChangeAdminPerms changes the grants named, and leaves every other one as it is
// stored: an administrator's box, pressed, for the reason ChangeAccountPerms is
// an account's. Only Emby can differ for an administrator today, which makes
// replacing and merging the same thing until a second permission withheld by
// default exists — and then a page that knew of one would take the other away.
func (s *Store) ChangeAdminPerms(trip string, changes map[string]bool) error {
	if err := knownPerms(changes); err != nil {
		return err
	}

	return s.changeAdmin(trip, func(admin *Admin) error {
		merged := admin.Effective()
		for permission, held := range changes {
			merged[permission] = held
		}

		admin.Perms = adminPerms(merged)

		return nil
	})
}

// changeAdmin reads one administrator, changes them, and writes them back, all
// in one transaction.
func (s *Store) changeAdmin(trip string, change func(*Admin) error) error {
	trip = strings.TrimSpace(trip)

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(adminsBucket)
		if bucket == nil {
			return ErrNoSuchAdmin
		}

		raw := bucket.Get([]byte(trip))
		if raw == nil {
			return ErrNoSuchAdmin
		}

		var admin Admin
		if err := json.Unmarshal(raw, &admin); err != nil {
			// Left as it is for the build that can read it, as everywhere a
			// record is changed.
			return err
		}

		if err := change(&admin); err != nil {
			return err
		}

		encoded, err := json.Marshal(admin)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(trip), encoded)
	})
}
