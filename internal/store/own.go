package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	bolt "go.etcd.io/bbolt"
)

/*
A relay of somebody's own.

Somebody provides a machine for themselves, and it is theirs: they are offered
it and nothing else, and nobody else is offered it at all. Administrators may
use it as they may use anything. An account holding one still reaches meetings
held anywhere, because a call comes in through the relay somebody dialled and
is forwarded to the one holding the meeting (app.forwarding) — so having a relay
of one's own decides the door, not the meetings behind it.

Three rules follow, and each was asked of the person who runs this deployment
rather than inferred.

Only theirs. An account with relays of its own is not offered the others, and
is not sent to one of them when its own are down or out of service: it cannot
join until one of them is back. Falling back would make the machine somebody
paid for a preference, and the point of it was that their calls go through it.

Nobody else's. A relay that is somebody's own is left off everybody else's list,
guests included, and cannot be asked for by name. The meetings held on it are
not closed to the people invited to them: reserving a door is about who comes
in through it, which is the same rule a relay kept for administrators has.

Not also kept for administrators. Those are two answers to who may use a
machine, and one relay cannot have both. Refused in both directions, so that
neither change can make the other untrue.

Held on the account rather than on the relay, as scopes are: a relay is renamed
in one transaction that rewrites every reference to it (RenameRelay), and an
account is renamed without anything else needing to know.
*/

var (
	// ErrAccountNoSuchRelay is an account being given a relay this deployment
	// does not have.
	ErrAccountNoSuchRelay = errors.New("an account can only be given a relay that is here")

	// ErrAccountRelayReserved is an account being given a relay kept for
	// administrators.
	ErrAccountRelayReserved = errors.New("a relay kept for administrators cannot be somebody's own")

	// ErrRelayIsSomebodys is a change to a relay that it being somebody's own
	// rules out: keeping it for administrators, or removing it.
	ErrRelayIsSomebodys = errors.New("this relay is somebody's own")
)

// ownRelays tidies a list of relay names: trimmed, each once, in the order
// given.
func ownRelays(names []string) []string {
	var out []string

	seen := map[string]bool{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			continue
		}

		seen[name] = true
		out = append(out, name)
	}

	return out
}

// mayOwn reports whether an account may be given these relays, asking only
// about the ones it does not already hold.
func mayOwn(tx *bolt.Tx, wanted, held []string) error {
	already := map[string]bool{}
	for _, name := range held {
		already[name] = true
	}

	bucket := tx.Bucket(relaysBucket)

	for _, name := range wanted {
		if already[name] {
			continue
		}

		if bucket == nil {
			return ErrAccountNoSuchRelay
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return ErrAccountNoSuchRelay
		}

		var relay Relay
		if err := json.Unmarshal(raw, &relay); err != nil {
			return ErrAccountNoSuchRelay
		}

		if relay.AdminOnly {
			return ErrAccountRelayReserved
		}
	}

	return nil
}

// ownersOf is the accounts holding a relay as their own, by name.
func ownersOf(tx *bolt.Tx, relay string) []string {
	bucket := tx.Bucket(accountsBucket)
	if bucket == nil {
		return nil
	}

	var owners []string

	_ = bucket.ForEach(func(_, raw []byte) error {
		var account Account
		if json.Unmarshal(raw, &account) != nil {
			return nil
		}

		for _, name := range account.Relays {
			if name == relay {
				owners = append(owners, account.Name)
				break
			}
		}

		return nil
	})

	return owners
}

// renameOwned rewrites a relay's name on every account holding it.
//
// Reads finished before writes, as eachRelay does, since bolt forbids changing
// a bucket while a cursor over it is open.
func renameOwned(tx *bolt.Tx, from, to string) error {
	bucket := tx.Bucket(accountsBucket)
	if bucket == nil {
		return nil
	}

	type rewrite struct {
		key     []byte
		account Account
	}

	var changed []rewrite

	if err := bucket.ForEach(func(key, raw []byte) error {
		var account Account
		if json.Unmarshal(raw, &account) != nil {
			return nil
		}

		touched := false
		for i, name := range account.Relays {
			if name == from {
				account.Relays[i], touched = to, true
			}
		}

		if touched {
			account.Relays = ownRelays(account.Relays)
			changed = append(changed, rewrite{append([]byte(nil), key...), account})
		}

		return nil
	}); err != nil {
		return err
	}

	for _, one := range changed {
		encoded, err := json.Marshal(one.account)
		if err != nil {
			return err
		}

		if err := bucket.Put(one.key, encoded); err != nil {
			return err
		}
	}

	return nil
}

// RelayOwners is every relay that is somebody's own, and whose.
//
// One read of the accounts for the whole list, which is what the list clients
// are offered and every join need: which relays to leave off for everybody
// else.
func (s *Store) RelayOwners() (map[string][]string, error) {
	owners := map[string][]string{}

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var account Account
			if json.Unmarshal(raw, &account) != nil {
				return nil
			}

			for _, name := range account.Relays {
				owners[name] = append(owners[name], account.Name)
			}

			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("read whose relays are whose: %w", err)
	}

	return owners, nil
}
