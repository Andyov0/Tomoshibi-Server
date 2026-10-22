package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"

	"tomoshibi/internal/room"
)

/*
Accounts, for the people who are meant to be here.

Until now this deployment had two kinds of person: administrators, listed by the
signature their passphrase produces, and everybody else, who was whoever they
said they were. That is the right model for an anonymous meeting link and the
wrong one for a group of people who all come back — there was no way to give
somebody a name that was theirs without making them an administrator.

An account is a username bound to a signature. The passphrase is never stored
and never sent anywhere that keeps it: an administrator setting one has it
turned into a signature at the moment they type it, and from then on the account
is the signature. So the database holds nothing that can be used to sign in as
anybody, which is the same bargain the administrators have always had.

The username is the key because it is what a person types. The signature is
unique as well, and refused when it is not: two accounts producing the same
signature would be one identity wearing two names, and every place that
recognises somebody — the room, the register, the token — would have to pick one
of them.
*/

var accountsBucket = []byte("accounts")

// Account is somebody who was given a way in.
type Account struct {
	// Name is the username, as it was typed. The key is its lowercase form, so
	// signing in is not a spelling test.
	Name string `json:"name"`

	// Trip is the signature their passphrase produces.
	//
	// The whole of what is stored about their credential. It is also what a
	// room recognises them by, so an account and the person in the meeting are
	// the same person without anything having to be looked up mid-call.
	Trip string `json:"trip"`

	// Avatar is a small image, as a data URI, or empty.
	//
	// Held here rather than as a file because it is small, changes rarely, and
	// belongs to the record it is part of: a file would be one more thing to
	// back up, to serve, and to leave behind when an account is deleted.
	Avatar string `json:"avatar,omitempty"`

	Created  time.Time `json:"created"`
	LastSeen time.Time `json:"lastSeen,omitempty"`

	// Blocked refuses their joins, exactly as it does for anybody else.
	Blocked bool   `json:"blocked,omitempty"`
	Note    string `json:"note,omitempty"`

	// Scopes are the groups this person belongs to, each a name a room may be
	// held under after an `@`.
	//
	// A label on the account rather than a record of its own, and that is the
	// design. A scope with no members means nothing, so there is nothing to
	// keep about one that is not already here; and a membership kept on the
	// account goes wherever the account goes — renamed with it, deleted with
	// it, and never inherited by somebody given the same name later, which a
	// list of names kept elsewhere would hand straight to them.
	Scopes []string `json:"scopes,omitempty"`

	// Perms is what this person may use, where it differs from the defaults.
	// See perms.go, and ask May rather than reading this: a word missing from
	// it is not a "no".
	//
	// On the account for the reason Scopes are — renamed with it, deleted with
	// it, and never inherited by whoever is given the name next — and written
	// only by SetAccountPerms and ChangeAccountPerms, for the reason given at
	// the first.
	Perms map[string]bool `json:"perms,omitempty"`
}

var (
	ErrAccountExists    = errors.New("somebody already has that name")
	ErrAccountTripTaken = errors.New("somebody already uses that passphrase")
	ErrNoSuchAccount    = errors.New("nobody here has that name")
	ErrAccountNoName    = errors.New("an account needs a name")
	ErrAccountLongName  = errors.New("a name is at most 32 characters")
	ErrAccountBadName   = errors.New("a name may use letters, digits, dots, dashes and underscores")
	ErrAvatarTooLarge   = errors.New("an avatar is at most 64 kilobytes")
	ErrAccountBadScope  = errors.New("a scope uses lowercase letters, digits and inner dashes, at most 32 of them")
)

// How large an avatar may be.
//
// Sixty-four kilobytes, which is generous for the size it is shown at and small
// enough that a hundred accounts is a database somebody can still copy about.
// The client is expected to have scaled it down long before this; the limit is
// here because a limit the server does not enforce is a suggestion.
const maxAvatar = 64 << 10

// Key is what an account is stored and looked up under.
//
// Lowercase, because signing in should not be a spelling test and because two
// accounts differing only in case would be an invitation rather than a feature.
func accountKey(name string) []byte {
	return []byte(strings.ToLower(strings.TrimSpace(name)))
}

// Valid reports whether this is an account the deployment can use.
func (a Account) Valid() error {
	name := strings.TrimSpace(a.Name)

	switch {
	case name == "":
		return ErrAccountNoName

	case len([]rune(name)) > 32:
		return ErrAccountLongName

	case !plainName(name):
		return ErrAccountBadName

	case len(a.Avatar) > maxAvatar:
		return ErrAvatarTooLarge
	}

	// Each one by the rule a room's scope is read with, so a tag that could
	// never appear after an `@` cannot be given to anybody: it would be a
	// membership of a group no room can name.
	for _, scope := range a.Scopes {
		if !room.ValidScope(scope) {
			return ErrAccountBadScope
		}
	}

	if err := knownPerms(a.Perms); err != nil {
		return err
	}

	// The signature is checked by the same rule the administrators use, so a
	// name cannot be admitted with something that is not one.
	return Admin{Trip: a.Trip, Name: name}.Valid()
}

// InScope reports whether this account carries a scope.
//
// Only the tag. Whether a blocked account counts is the caller's question,
// because it is asked in more than one place: a blocked member is refused at the
// door, and so is a link they made, and each says so where it decides rather
// than here.
func (a Account) InScope(scope string) bool {
	if scope == "" {
		return false
	}

	for _, one := range a.Scopes {
		if one == scope {
			return true
		}
	}

	return false
}

// plainName keeps a username to what can be typed, said aloud and looked up.
//
// No spaces, because a name with one is a name somebody will type differently
// every time. Nothing exotic, because two names that look identical and are not
// is the oldest impersonation there is.
func plainName(name string) bool {
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '-' || r == '_':
		default:
			return false
		}
	}

	return true
}

// Accounts lists everybody, by name.
func (s *Store) Accounts() ([]Account, error) {
	var list []Account

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var account Account
			if err := json.Unmarshal(raw, &account); err == nil {
				list = append(list, account)
			}

			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("read the accounts: %w", err)
	}

	sort.Slice(list, func(i, j int) bool {
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})

	return list, nil
}

// AddAccount records a new one.
func (s *Store) AddAccount(account Account) error {
	if err := account.Valid(); err != nil {
		return err
	}

	account.Name = strings.TrimSpace(account.Name)
	account.Perms = accountPerms(account.Perms)

	if account.Created.IsZero() {
		account.Created = time.Now().UTC()
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(accountsBucket)
		if err != nil {
			return err
		}

		if bucket.Get(accountKey(account.Name)) != nil {
			return ErrAccountExists
		}

		if taken(bucket, account.Trip, "") {
			return ErrAccountTripTaken
		}

		encoded, err := json.Marshal(account)
		if err != nil {
			return err
		}

		return bucket.Put(accountKey(account.Name), encoded)
	})
}

// taken reports whether a signature already belongs to somebody else.
//
// Checked on every write rather than only on creation, because the way two
// accounts come to share a signature is not somebody typing the same password
// twice at the start — it is one of them changing theirs later to something
// another already uses.
func taken(bucket *bolt.Bucket, trip, except string) bool {
	found := false

	_ = bucket.ForEach(func(key, raw []byte) error {
		if string(key) == except {
			return nil
		}

		var other Account
		if err := json.Unmarshal(raw, &other); err == nil && other.Trip == trip {
			found = true
		}

		return nil
	})

	return found
}

// Account reads one by name.
//
// Not found where the store will not answer, which refuses the sign-in — the
// safe direction, and the one that reads as a wrong passphrase to whoever is
// typing. See Session for the same reasoning; both are said out loud so that a
// run of "wrong passphrase" from people who have not changed theirs has
// somewhere to be traced to.
func (s *Store) Account(name string) (Account, bool) {
	var account Account
	found := false

	if err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get(accountKey(name))
		if raw == nil {
			return nil
		}

		if err := json.Unmarshal(raw, &account); err != nil {
			// A record this build cannot read is one that is not there, which is
			// the rule for every record here. Worth a line for this one, because
			// what it refuses is somebody's own sign-in and the reason will not
			// occur to them.
			slog.Error("an account's record could not be read, so it cannot be signed in to",
				"account", name, "error", err)

			return nil
		}

		found = true

		return nil
	}); err != nil {
		slog.Error("could not look up an account, so the sign-in was refused",
			"account", name, "error", err)
	}

	return account, found
}

// AccountBySignature finds whoever a signature belongs to.
//
// Used where somebody is already recognised and the question is what to call
// them: a join carries a signature, and an account gives it a name and a face.
func (s *Store) AccountBySignature(trip string) (Account, bool) {
	var account Account
	found := false

	if strings.TrimSpace(trip) == "" {
		return account, false
	}

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			if found {
				return nil
			}

			var one Account
			if err := json.Unmarshal(raw, &one); err == nil && one.Trip == trip {
				account, found = one, true
			}

			return nil
		})
	})

	return account, found
}

// UpdateAccount writes a changed account back, keyed by its current name.
//
// The name may change: it is what somebody is called, not what they are, and a
// person who wants to be known differently should not need a new account. The
// signature may change too, which is what changing a passphrase is. Both are
// checked against everybody else first.
//
// Three fields are not the caller's to write, and are carried over from the
// stored record inside the transaction whatever the caller passed: Created,
// LastSeen and Perms. Every caller hands over a whole record it read some time
// before, so a field taken from the caller is a field put back to whatever it
// was then. For Perms that would be a revoked grant restored by a page that
// never knew it had been revoked. LastSeen has its own writer, AccountSeen, and
// Perms has SetAccountPerms and ChangeAccountPerms.
//
// The rest is written as passed, which is why the person's own changes do not
// come through here: a picture or a passphrase changed from the account page
// has SetAccountAvatar and SetAccountTrip, which touch the one field. The caller
// left is an administrator changing the account, whose request reads the record
// and writes it back within the same moment.
func (s *Store) UpdateAccount(was string, account Account) error {
	// Not validated as passed, since it is not what will be written: a stale
	// copy carrying a word this build has since dropped would otherwise refuse
	// somebody's change of picture over a field the change does not touch.
	account.Perms = nil

	if err := account.Valid(); err != nil {
		return err
	}

	account.Name = strings.TrimSpace(account.Name)

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return ErrNoSuchAccount
		}

		old := accountKey(was)

		raw := bucket.Get(old)
		if raw == nil {
			return ErrNoSuchAccount
		}

		var existing Account
		if err := json.Unmarshal(raw, &existing); err != nil {
			// Refused rather than written over. Carrying fields across from a
			// record that cannot be read would carry nothing, and the record
			// written in its place would hold every permission at its default
			// — which, for anybody who had one taken away, is giving it back.
			return err
		}

		account.Created = existing.Created
		account.LastSeen = existing.LastSeen
		account.Perms = existing.Perms

		key := accountKey(account.Name)

		if string(key) != string(old) && bucket.Get(key) != nil {
			return ErrAccountExists
		}

		if taken(bucket, account.Trip, string(old)) {
			return ErrAccountTripTaken
		}

		encoded, err := json.Marshal(account)
		if err != nil {
			return err
		}

		if err := bucket.Put(key, encoded); err != nil {
			return err
		}

		if string(key) != string(old) {
			return bucket.Delete(old)
		}

		return nil
	})
}

// SetAccountAvatar changes an account's picture, and nothing else.
//
// For the person changing their own, from the account page. That request reads
// their record when it begins and the picture after it — up to a hundred
// kilobytes, sent at whatever pace their connection manages — and handing the
// whole record back through UpdateAccount wrote every field as it was when the
// request began. An administrator who blocked them in between was undone by
// the picture arriving: the block gone, their films relayed again, their
// session working again. Its own transaction touching its own field, as
// SetAdminAvatar is for an administrator.
func (s *Store) SetAccountAvatar(name, avatar string) error {
	if len(avatar) > maxAvatar {
		return ErrAvatarTooLarge
	}

	return s.changeAccount(name, func(account *Account) error {
		account.Avatar = avatar
		return nil
	})
}

// SetAccountTrip moves an account from one signature to another, and changes
// nothing else: the person changing their own passphrase.
//
// Only from the signature they proved. The request checks their current
// passphrase against the record it read when it began, and an administrator
// may have set a new one since; written regardless, the person's change would
// undo the administrator's reset, which is usually the reason for it.
func (s *Store) SetAccountTrip(name, was, trip string) error {
	return s.changeAccount(name, func(account *Account) error {
		if account.Trip != was {
			return ErrNoSuchAccount
		}

		account.Trip = trip

		return nil
	})
}

// changeAccount reads one account, changes it, and writes it back, all in one
// transaction, under the key it was found at.
func (s *Store) changeAccount(name string, change func(*Account) error) error {
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
			// Left as it is for the build that can read it, as everywhere
			// else a record is changed.
			return err
		}

		if err := change(&account); err != nil {
			return err
		}

		if taken(bucket, account.Trip, string(key)) {
			return ErrAccountTripTaken
		}

		encoded, err := json.Marshal(account)
		if err != nil {
			return err
		}

		return bucket.Put(key, encoded)
	})
}

// RemoveAccount forgets somebody.
func (s *Store) RemoveAccount(name string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return ErrNoSuchAccount
		}

		key := accountKey(name)

		if bucket.Get(key) == nil {
			return ErrNoSuchAccount
		}

		return bucket.Delete(key)
	})
}

// AccountSeen notes that somebody used their account.
//
// The one field, in one transaction, rather than the whole record read and
// handed back. It used to be the second: found by signature, LastSeen set, and
// passed to UpdateAccount — which carries LastSeen over from the stored record,
// so what this wrote was the old value, every time, and the page said "never
// here" about everybody. It also meant every proven join rewrote the whole
// record from a copy read a moment earlier, which is the race an administrator
// blocking somebody as they joined would have lost.
//
// Never moved backwards, so two joins finishing out of order leave the later.
func (s *Store) AccountSeen(trip string, at time.Time) {
	if strings.TrimSpace(trip) == "" {
		return
	}

	_ = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return nil
		}

		var key []byte
		var account Account

		_ = bucket.ForEach(func(k, raw []byte) error {
			if key != nil {
				return nil
			}

			var one Account
			if err := json.Unmarshal(raw, &one); err == nil && one.Trip == trip {
				key, account = append([]byte(nil), k...), one
			}

			return nil
		})

		if key == nil || !at.After(account.LastSeen) {
			return nil
		}

		account.LastSeen = at

		encoded, err := json.Marshal(account)
		if err != nil {
			return err
		}

		return bucket.Put(key, encoded)
	})
}

// Answering reports whether the store can be read at all.
//
// For a refusal that has to say which kind it is. Every lookup here answers "not
// found" when the store fails, which is the safe direction for a sign-in and the
// wrong sentence for a room that turned somebody away: asked once, on the way
// out, so that an outage is logged as one and said as one.
func (s *Store) Answering() error {
	return s.db.View(func(*bolt.Tx) error { return nil })
}
