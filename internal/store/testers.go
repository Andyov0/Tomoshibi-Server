package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
Which addresses each account has had invited to test the iOS app.

Kept because an invitation costs something that is not this deployment's to
spend freely. Every address Apple accepts is a tester counted against a ceiling
Apple sets for the app, and is somebody Apple mails in the app's name. One
account is allowed a few (the caller decides how many), and this is the count.

Keyed by the account's signature, like everything here worth remembering about
somebody, and carried across when they change their own passphrase — otherwise
changing it would be a way to start the count again. Whoever an administrator
gives a new passphrase starts a fresh one, which is the administrator's call.

The addresses are kept in full, because the question asked of this record is
whether one is already in it. They are written by the account inviting them,
and shown to nobody — not even that account. Nothing sweeps them: a
tester stays a tester at Apple until somebody removes them there, so the count
is the count for as long as the account exists.
*/

var testersBucket = []byte("apps.testers")

// Tester is one address an account had invited, and when.
type Tester struct {
	Address string    `json:"address"`
	At      time.Time `json:"at"`
}

// ErrNoTester refuses a record with nobody behind it or nothing in it.
var ErrNoTester = errors.New("a tester needs an account's signature and an address")

// Testers is what one account has invited, oldest first. A record this build
// cannot read is treated as one that is not there, which costs the count and
// nothing else.
func (s *Store) Testers(trip string) ([]Tester, error) {
	var list []Tester

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(testersBucket)
		if bucket == nil {
			return nil
		}

		if raw := bucket.Get([]byte(trip)); raw != nil {
			if err := json.Unmarshal(raw, &list); err != nil {
				list = nil
			}
		}

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("read who %s has invited to test: %w", trip, err)
	}

	return list, nil
}

// AddTester writes an address down against an account, unless it is there
// already, in which case it is left with the time it was first invited.
func (s *Store) AddTester(trip string, tester Tester) error {
	tester.Address = strings.ToLower(strings.TrimSpace(tester.Address))

	if strings.TrimSpace(trip) == "" || tester.Address == "" {
		return ErrNoTester
	}

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(testersBucket)
		if err != nil {
			return err
		}

		var list []Tester
		if raw := bucket.Get([]byte(trip)); raw != nil {
			_ = json.Unmarshal(raw, &list)
		}

		for _, one := range list {
			if one.Address == tester.Address {
				return nil
			}
		}

		encoded, err := json.Marshal(append(list, tester))
		if err != nil {
			return err
		}

		return bucket.Put([]byte(trip), encoded)
	})

	if err != nil {
		return fmt.Errorf("record an invitation to test for %s: %w", trip, err)
	}

	return nil
}

// MoveTesters carries an account's invitations from one signature to another,
// in one transaction, for a passphrase change.
//
// Merged into whatever the new signature already holds rather than written over
// it. Nothing should be there — a signature is a passphrase, and a passphrase
// somebody else holds is refused before this is reached — but merging is never
// wrong, and overwriting would be wrong in exactly the case nobody expected.
func (s *Store) MoveTesters(from, to string) error {
	if from == to || from == "" || to == "" {
		return nil
	}

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(testersBucket)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(from))
		if raw == nil {
			return nil
		}

		var moving, there []Tester
		_ = json.Unmarshal(raw, &moving)

		if held := bucket.Get([]byte(to)); held != nil {
			_ = json.Unmarshal(held, &there)
		}

		for _, one := range moving {
			known := false
			for _, already := range there {
				if already.Address == one.Address {
					known = true
					break
				}
			}

			if !known {
				there = append(there, one)
			}
		}

		encoded, err := json.Marshal(there)
		if err != nil {
			return err
		}

		if err := bucket.Put([]byte(to), encoded); err != nil {
			return err
		}

		return bucket.Delete([]byte(from))
	})

	if err != nil {
		return fmt.Errorf("carry invitations to test from %s to %s: %w", from, to, err)
	}

	return nil
}
