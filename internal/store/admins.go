package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"

	"tomoshibi/internal/config"
)

// adminsBucket holds the people who may open the management pages.
//
// In the store rather than only in the configuration file, for the reason the
// relays are: an administrator is added when somebody joins the team and removed
// when they leave, and both happen while the deployment is running. Editing a
// file and restarting to add one would drop every call in progress, which is a
// strange price for a change that alters nothing about the calls themselves.
//
// The configuration file remains the starting value, adopted the first time this
// runs. That matters more here than anywhere else: it is how the first
// administrator exists at all, and a deployment that lost its store must be able
// to get back in by editing a file on the host.
var adminsBucket = []byte("admins")

// Admin is one administrator, as the deployment knows them.
type Admin struct {
	// Trip is the signature their passphrase produces, and the key here.
	//
	// The passphrase itself is never stored, sent, or seen by this server: the
	// signature is what a client proves it can produce, and it is public — it
	// prints beside its owner's name in every room they join. Which is also how
	// somebody being added finds out what to hand over.
	Trip string `json:"trip"`

	// Name appears in the audit log and beside the entry on the page. Nothing
	// is authorised by it.
	Name string `json:"name"`

	// Can lists what they may do. Empty means observe alone, which is the safe
	// reading of an entry somebody wrote in a hurry.
	Can []string `json:"can"`

	// Avatar is the picture they chose, as a data URI, or empty.
	//
	// Here for the same reason it is on an account: an administrator is a person
	// in a call before they are an entry in a list, and the alternative was that
	// the one group of people who certainly have credentials on this deployment
	// were the one group who could not put a face beside their name. Bounded by
	// the same limit, in the same place.
	Avatar string `json:"avatar,omitempty"`

	// Added is when somebody put them here, for a page that wants to say so.
	Added time.Time `json:"added"`

	// Perms is what they may use beyond what every administrator holds — in
	// practice the Emby grant, which is withheld from administrators exactly as
	// it is from everybody else. See perms.go.
	//
	// Written only by SetAdminPerms, for the reason given there.
	Perms map[string]bool `json:"perms,omitempty"`
}

// What an administrator can be wrong in.
var (
	ErrAdminNoTrip   = errors.New("an administrator needs a signature")
	ErrAdminBadTrip  = errors.New("a signature is ten lowercase letters and digits")
	ErrAdminLongName = errors.New("an administrator name is at most 64 characters")
	ErrAdminBadCan   = errors.New("that is not something an administrator can be allowed")
	ErrAdminExists   = errors.New("somebody with that signature is already an administrator")
	ErrNoSuchAdmin   = errors.New("nobody with that signature is an administrator here")

	// ErrLastModerator guards the one mistake that cannot be undone from the page it
	// is made on: removing the last person who can add anybody back. Recovering
	// from it means editing a file on the host and restarting, which ends every
	// call in progress.
	ErrLastModerator = errors.New("this is the last administrator who can change anything")
)

// tripLength is what room.Trip produces, without the kind prefix.
const tripLength = 10

// Valid reports whether this is an administrator the deployment can use.
func (a Admin) Valid() error {
	switch {
	case strings.TrimSpace(a.Trip) == "":
		return ErrAdminNoTrip

	case len(a.Trip) != tripLength || strings.ToLower(a.Trip) != a.Trip || !alphanumeric(a.Trip):
		return ErrAdminBadTrip

	case len(a.Name) > 64:
		return ErrAdminLongName
	}

	for _, can := range a.Can {
		if !config.Known(can) {
			return ErrAdminBadCan
		}
	}

	return knownPerms(a.Perms)
}

func alphanumeric(s string) bool {
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}

	return true
}

// Admins lists everybody, by signature.
//
// Sorted so that a page redrawn after a change does not reorder itself under
// whoever is reading it.
func (s *Store) Admins() ([]Admin, error) {
	var list []Admin

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(adminsBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var admin Admin
			if err := json.Unmarshal(raw, &admin); err != nil {
				// One unreadable entry should not take the list with it, and a
				// list that came back short would lock everybody out.
				return nil
			}

			list = append(list, admin)
			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("read the administrators: %w", err)
	}

	sort.Slice(list, func(i, j int) bool { return list[i].Trip < list[j].Trip })

	return list, nil
}

// AddAdmin records a new one.
func (s *Store) AddAdmin(admin Admin) error {
	if err := admin.Valid(); err != nil {
		return err
	}

	admin.Trip = strings.TrimSpace(admin.Trip)
	admin.Name = strings.TrimSpace(admin.Name)
	admin.Perms = adminPerms(admin.Perms)

	if admin.Added.IsZero() {
		admin.Added = time.Now().UTC()
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(adminsBucket)
		if err != nil {
			return err
		}

		if bucket.Get([]byte(admin.Trip)) != nil {
			return ErrAdminExists
		}

		encoded, err := json.Marshal(admin)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(admin.Trip), encoded)
	})
}

// UpdateAdmin changes what somebody may do, or what they are called.
//
// The signature is the key and cannot be changed: it is not a label but the
// thing being recognised, and changing it would be removing one administrator
// and adding another under cover of an edit.
//
// Added, Avatar and Perms are carried over from the stored record inside the
// transaction, whatever the caller passed. Only Added was, and the role editor
// builds an administrator from what the page sent — a name and a role — so every
// change of role quietly took the person's picture away. Perms is carried for
// the reason UpdateAccount carries it: a whole record handed back from an older
// read must not restore a grant that was revoked in between. The picture has
// SetAdminAvatar and the grants have SetAdminPerms.
func (s *Store) UpdateAdmin(admin Admin) error {
	// Replaced below, so not validated as passed.
	admin.Perms = nil

	if err := admin.Valid(); err != nil {
		return err
	}

	admin.Name = strings.TrimSpace(admin.Name)

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(adminsBucket)
		if bucket == nil {
			return ErrNoSuchAdmin
		}

		raw := bucket.Get([]byte(admin.Trip))
		if raw == nil {
			return ErrNoSuchAdmin
		}

		var existing Admin
		if err := json.Unmarshal(raw, &existing); err != nil {
			// Refused rather than written over, for the reason UpdateAccount
			// refuses: nothing could be carried across from it.
			return err
		}

		admin.Added = existing.Added
		admin.Avatar = existing.Avatar
		admin.Perms = existing.Perms

		// Losing the last owner is checked here rather than at the API, because
		// the store is what the running deployment reads and this is the one
		// change that cannot be undone from the page that made it.
		if existing.Allows(config.Moderate) && !admin.Allows(config.Moderate) {
			if lastModerator(bucket, admin.Trip) {
				return ErrLastModerator
			}
		}

		encoded, err := json.Marshal(admin)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(admin.Trip), encoded)
	})
}

// ChangeAdminCan gives or takes away the finer capabilities named, and leaves
// the rest of what somebody may do as it is stored. It answers with what they may
// do afterwards, as written.
//
// What a capability's box sends, one box at a time. The page sent the whole list
// as it last drew it once, and UpdateAdmin replaced the stored list with that —
// so an administrator ticking Relays on a page polled a minute ago also sent back
// the list as it stood then, and took away the Settings another administrator
// had given in between, with nothing on either page to say so. Merged here,
// inside the transaction, so that two people pressing different boxes for the
// same administrator both have what they pressed.
//
// The four finer capabilities and nothing else. Moderate and observe are ends of
// the role control, which writes the whole list through UpdateAdmin and is
// where the guard against losing the last moderator lives. A box pressed for
// somebody who has since been made a moderator changes nothing: moderate holds
// every box already, and the four written beside it would be four words nobody
// chose (see clean in internal/admin/roster.go).
func (s *Store) ChangeAdminCan(trip string, changes map[string]bool) ([]string, error) {
	for capability := range changes {
		switch capability {
		case config.ManageRooms, config.ManageAccounts, config.ManageRelays, config.ManageSettings:
		default:
			return nil, ErrAdminBadCan
		}
	}

	var written []string

	err := s.changeAdmin(trip, func(admin *Admin) error {
		if admin.Allows(config.Moderate) {
			written = admin.Can
			return nil
		}

		held := make(map[string]bool, len(admin.Can)+len(changes))
		for _, one := range admin.Can {
			held[one] = true
		}

		for capability, on := range changes {
			held[capability] = on
		}

		// In the order a page lists them, each once, so the record says the
		// same thing however the boxes were pressed.
		can := []string{}
		for _, one := range config.Capabilities() {
			if held[one] {
				can = append(can, one)
			}
		}

		admin.Can, written = can, can

		return nil
	})

	return written, err
}

// ReplaceAdminTrip moves an administrator to a new signature.
//
// Which is how somebody changes their passphrase. There is no password here to
// change — the passphrase is never sent to this server and never stored, and
// what is kept is the signature it produces — so rotating one is not an edit to
// a field but a change of the key somebody is recognised by.
//
// Both halves in one transaction, because the two of them separately are a
// window in which the deployment has either two administrators where it had one
// or, far worse, none. The last-moderator guard is deliberately not consulted:
// this is the same person keeping the same capabilities, and a check that
// counted the old entry as leaving would refuse the one administrator on a
// deployment from ever changing their passphrase.
func (s *Store) ReplaceAdminTrip(from, to string) error {
	replacement := Admin{Trip: to}
	if err := replacement.Valid(); err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(adminsBucket)
		if bucket == nil {
			return ErrNoSuchAdmin
		}

		raw := bucket.Get([]byte(from))
		if raw == nil {
			return ErrNoSuchAdmin
		}

		if from != to && bucket.Get([]byte(to)) != nil {
			// Somebody else already answers to the new signature, which means
			// the new passphrase is one they are using. Refused rather than
			// merged: the alternative silently hands one person's access to
			// another.
			return ErrAdminExists
		}

		var admin Admin
		if err := json.Unmarshal(raw, &admin); err != nil {
			return err
		}

		admin.Trip = to

		encoded, err := json.Marshal(admin)
		if err != nil {
			return err
		}

		if err := bucket.Put([]byte(to), encoded); err != nil {
			return err
		}

		if from == to {
			return nil
		}

		return bucket.Delete([]byte(from))
	})
}

// SetAdminAvatar changes an administrator's picture, and nothing else.
//
// Its own transaction for the reason SetAdminPerms is: the picture is changed by
// the person from the account page, holding a copy of their record from when
// they signed in, and handing that copy back whole would restore whatever about
// them had changed since.
func (s *Store) SetAdminAvatar(trip, avatar string) error {
	// The same bound as an account's, in the same place: a limit the server
	// does not enforce is a suggestion.
	if len(avatar) > maxAvatar {
		return ErrAvatarTooLarge
	}

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

		admin.Avatar = avatar

		encoded, err := json.Marshal(admin)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(trip), encoded)
	})
}

// RemoveAdmin forgets somebody.
//
// Their open session is not ended here — the management sessions are held by
// whoever keeps them, and this list does not know where — but it ends within a
// minute: a session asks this list again at most once a minute, and one whose
// signature is no longer on it is dropped there. See Sessions.Of.
func (s *Store) RemoveAdmin(trip string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(adminsBucket)
		if bucket == nil {
			return ErrNoSuchAdmin
		}

		if bucket.Get([]byte(trip)) == nil {
			return ErrNoSuchAdmin
		}

		// Only where the one going is a moderator.
		//
		// The guard is about not leaving a deployment nobody can change
		// anything on, and removing somebody who could never change anything
		// cannot cause that. Asked unconditionally, it refused every removal on
		// a deployment whose administrators are all read-only — which is not a
		// hypothetical shape: a monitor signs in to read the fleet and should
		// hold nothing else, and a deployment can reasonably have one of those
		// and no moderator at all while somebody is setting it up.
		var going Admin
		if err := json.Unmarshal(bucket.Get([]byte(trip)), &going); err == nil &&
			going.Allows(config.Moderate) && lastModerator(bucket, trip) {
			return ErrLastModerator
		}

		return bucket.Delete([]byte(trip))
	})
}

// lastModerator reports whether removing this signature would leave nobody who
// can change anything.
func lastModerator(bucket *bolt.Bucket, trip string) bool {
	others := 0

	_ = bucket.ForEach(func(key, raw []byte) error {
		if string(key) == trip {
			return nil
		}

		var admin Admin
		if err := json.Unmarshal(raw, &admin); err != nil {
			return nil
		}

		if admin.Allows(config.Moderate) {
			others++
		}

		return nil
	})

	return others == 0
}

// Allows reports whether this administrator holds a capability.
//
// Delegated to the configuration's own answer so that there is one rule rather
// than two: the join endpoint asks the same question of the same shape, and two
// answers to one question is one of them waiting to drift.
func (a Admin) Allows(capability string) bool {
	return config.Admin{Trip: a.Trip, Can: a.Can}.Allows(capability)
}

// Configured turns a stored administrator into the shape the rest of the
// deployment recognises people by.
func (a Admin) Configured() config.Admin {
	return config.Admin{Trip: a.Trip, Name: a.Name, Can: a.Can}
}

// AdoptAdmins writes the configured administrators in, the first time this runs.
//
// The same bargain the relays strike, and the reason it matters more: this is
// how the first administrator comes to exist, and a deployment whose store was
// lost has to be able to get back in by editing a file on the host. Adopted only
// when the bucket has never existed, so that a deployment which deliberately
// removed somebody does not have them put back on the next restart.
func (s *Store) AdoptAdmins(configured []config.Admin) (adopted bool, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(adminsBucket) != nil {
			return nil
		}

		bucket, err := tx.CreateBucketIfNotExists(adminsBucket)
		if err != nil {
			return err
		}

		for _, one := range configured {
			admin := Admin{Trip: one.Trip, Name: one.Name, Can: one.Can, Added: time.Now().UTC()}

			if err := admin.Valid(); err != nil {
				return fmt.Errorf("administrator %q from the configuration: %w", one.Name, err)
			}

			encoded, err := json.Marshal(admin)
			if err != nil {
				return err
			}

			if err := bucket.Put([]byte(admin.Trip), encoded); err != nil {
				return err
			}
		}

		adopted = true
		return nil
	})

	if err != nil {
		return false, fmt.Errorf("adopt the configured administrators: %w", err)
	}

	return adopted, nil
}

// AdminNamed finds an administrator by the name they are listed under.
//
// By name rather than by signature, because this answers the front page's
// sign-in, where somebody types a name and a passphrase. The signature is
// derived from what they typed and compared afterwards; looking up by it instead
// would mean a wrong passphrase found nobody and a right one found somebody,
// which is the same answer arrived at more confusingly.
//
// The comparison is case-insensitive on the name and exact on nothing else. Two
// administrators listed under names differing only in case would be a list
// somebody cannot read, and this is not the place to discover that.
func (s *Store) AdminNamed(name string) (Admin, bool) {
	wanted := strings.ToLower(strings.TrimSpace(name))

	if wanted == "" {
		return Admin{}, false
	}

	list, err := s.Admins()
	if err != nil {
		return Admin{}, false
	}

	for _, one := range list {
		if strings.ToLower(one.Name) == wanted {
			return one, true
		}
	}

	return Admin{}, false
}

// AdminBySignature finds one by the mark they carry.
func (s *Store) AdminBySignature(trip string) (Admin, bool) {
	list, err := s.Admins()
	if err != nil {
		return Admin{}, false
	}

	for _, one := range list {
		if one.Trip == trip {
			return one, true
		}
	}

	return Admin{}, false
}
