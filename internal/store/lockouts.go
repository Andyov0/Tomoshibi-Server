package store

import (
	"encoding/json"
	"sort"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
The callers shut out of signing in, kept so that a restart does not let them
back in.

The counting that leads to one of these is in memory (internal/lockout), and
losing it costs an attacker's progress towards a lockout, which is nothing
anybody minds. The lockout itself is not: it is thirty minutes during which a
caller who has been getting passphrases wrong at both doors is answered before
anything is checked, and a deployment restarted three times in an afternoon
would otherwise hand every one of them a fresh allowance three times over.

Keyed by the lockout's own key, which is a digest of the address and the
device together and holds neither, so a page can name one in a path. The
record beside it holds both, because an administrator deciding whether to
lift it needs to know whose it is.
*/

var lockouts = []byte("lockouts")

// Lockout is one caller shut out of signing in.
type Lockout struct {
	// Key is what the lockout is kept under and what a page lifts it by.
	Key string `json:"key"`

	// Address is what was shut out: an IPv4 address as it is, or the /64 an
	// IPv6 address belongs to, since a whole /64 is what one subscriber is
	// handed and counting them apart would let one machine rotate through it.
	Address string `json:"address"`
	// Seen is the address the last failure came from, exactly.
	Seen string `json:"seen,omitempty"`

	// Client is what the device said it was, read the way the joins read it.
	Client *Client `json:"client,omitempty"`

	// First and Last are the first and last failed sign-ins that led here.
	First time.Time `json:"first"`
	Last  time.Time `json:"last"`
	// Since and Until are when the lockout began and when it ends.
	Since time.Time `json:"since"`
	Until time.Time `json:"until"`

	// Failures is how many failed sign-ins were counted against the caller.
	Failures int `json:"failures"`
	// Doors is which sign-ins they were at: "account", "management" or both.
	Doors []string `json:"doors"`
}

// Live reports whether a lockout is still in force.
func (l Lockout) Live(now time.Time) bool {
	return now.Before(l.Until)
}

// KeepLockout writes one down, replacing whatever was kept under its key.
func (s *Store) KeepLockout(lockout Lockout) error {
	encoded, err := json.Marshal(lockout)
	if err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(lockouts)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(lockout.Key), encoded)
	})
}

// Lockouts lists the ones still in force, newest first, and clears away the
// ones that are not.
//
// Cleared here as well as by the sweep, because this is what a starting
// process reads, and one that has been down for an hour should not carry the
// lockouts that ended while it was.
func (s *Store) Lockouts(now time.Time) ([]Lockout, error) {
	live, _, err := s.lockoutsAt(now)

	return live, err
}

// lockoutsAt is Lockouts, and how many it cleared away.
func (s *Store) lockoutsAt(now time.Time) ([]Lockout, int, error) {
	var live []Lockout
	gone := 0

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(lockouts)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var lockout Lockout
			if err := json.Unmarshal(raw, &lockout); err != nil || !lockout.Live(now) {
				stale = append(stale, append([]byte(nil), key...))
				return nil
			}

			live = append(live, lockout)

			return nil
		}); err != nil {
			return err
		}

		for _, key := range stale {
			if err := bucket.Delete(key); err != nil {
				return err
			}
		}
		gone = len(stale)

		return nil
	})

	sort.Slice(live, func(i, j int) bool { return live[i].Since.After(live[j].Since) })

	return live, gone, err
}

// LiftLockout removes one, reporting whether there was one.
func (s *Store) LiftLockout(key string) (bool, error) {
	found := false

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(lockouts)
		if bucket == nil || bucket.Get([]byte(key)) == nil {
			return nil
		}

		found = true

		return bucket.Delete([]byte(key))
	})

	return found, err
}

// SweepLockouts clears the ones that have ended, reporting how many.
//
// A lockout past its end is already ignored by whoever reads it, so this is
// growth rather than enforcement: one row per caller ever shut out.
func (s *Store) SweepLockouts(now time.Time) (int, error) {
	_, gone, err := s.lockoutsAt(now)

	return gone, err
}
