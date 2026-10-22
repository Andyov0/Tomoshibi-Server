package store

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
Asking to be let into a meeting that will not have you.

The door refuses somebody who has no invite, no account and no claim on the
room, and refusing is the right answer to a stranger who guessed a name. It is
the wrong answer to somebody who was told about the meeting in a way that did
not include a link — which happens constantly, because people say "we're on
Tomoshibi at four" to each other and the link is in a message somebody did not
read.

So they can knock, and somebody already in the room can answer. What answering
does is mint them an invite, which is why this is short: the door already knows
how to let in somebody with one, and a second way in would be a second thing to
get wrong. Admitting is not a special kind of entry, it is the ordinary kind,
arranged by hand.

These expire quickly and deliberately. A knock is somebody standing at a door
now; one from twenty minutes ago is somebody who gave up, and answering it
would put a stranger into a meeting that has moved on without them.
*/

var knocks = []byte("knocks")

// How long an unanswered knock stands.
//
// Short. Somebody waiting at a door waits for a minute or two and then does
// something else, and a list of knocks from the last hour is a list of people
// who are no longer there — which is worse than empty, because it invites
// somebody to admit them.
const knockFor = 5 * time.Minute

// What a knock is waiting on.
const (
	Knocking = "knocking"
	Admitted = "admitted"
	Refused  = "refused"
)

// Knock is somebody at the door.
type Knock struct {
	// ID is what somebody in the room answers with, and is not a secret.
	//
	// Separate from the token the knocker holds, because they have different
	// audiences: the token is how one person asks about their own knock and is
	// theirs alone, and this is how a roomful of people refer to a stranger
	// waiting outside. The store is keyed by the token's hash, so the token
	// cannot be recovered for a listing even if it should be — which it should
	// not.
	ID string `json:"id"`

	Room string `json:"room"`

	// Name is what they typed to be called, and is the only thing anybody
	// answering has to go on. Not a claim about who they are — nothing here is
	// — and shown as what it is.
	Name string `json:"name"`

	// Address is where they knocked from, which is the other half of what
	// somebody deciding needs and is not recoverable afterwards.
	Address string `json:"address,omitempty"`

	State string `json:"state"`

	// Invite is what admitting them minted, held so that the knocker's own
	// polling can be answered without a second lookup, and empty until then.
	Invite string `json:"invite,omitempty"`

	At time.Time `json:"at"`
}

// NewKnockToken is what a knocker holds to ask about their own knock.
//
// The same shape as an invite token and for the same reason: it is a secret
// handed to one person, and it is what stops anybody enumerating who is waiting
// at somebody else's door.
func NewKnockToken() (string, error) {
	return NewInviteToken()
}

// NewKnockID is what a room refers to a knock by. Random rather than counted,
// so that a listing says nothing about how many people have knocked.
func NewKnockID() (string, error) {
	return NewInviteToken()
}

// Knocked records somebody asking to be let in.
func (s *Store) Knocked(token string, knock Knock) error {
	encoded, err := json.Marshal(knock)
	if err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(knocks)
		if err != nil {
			return err
		}

		return bucket.Put(held(token), encoded)
	})
}

// Knocking reads who is waiting at one room's door, oldest first.
//
// Oldest first, because a queue is answered in the order people arrived and a
// list that reordered itself while somebody was reading it would have them
// admitting the wrong person.
func (s *Store) Knocking(room string, now time.Time) []Knock {
	found := make([]Knock, 0, 4)

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(knocks)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var knock Knock
			if err := json.Unmarshal(raw, &knock); err != nil {
				return nil
			}

			if knock.State != Knocking || !strings.EqualFold(knock.Room, room) {
				return nil
			}

			if now.Sub(knock.At) > knockFor {
				return nil
			}

			found = append(found, knock)

			return nil
		})
	})

	for at := 1; at < len(found); at++ {
		for back := at; back > 0 && found[back].At.Before(found[back-1].At); back-- {
			found[back], found[back-1] = found[back-1], found[back]
		}
	}

	return found
}

// Answered admits or refuses one knock, and says what it was.
//
// The invite is minted by the caller and handed in rather than made here: what
// an invite is and how long it lasts is the invite code's business, and a
// second place deciding it is a second place to get it wrong.
//
// Answering an answered knock is not an error and does not change it. Two
// people in a room may press at the same moment, and the second of them should
// not undo the first or be told they failed.
func (s *Store) Answered(id, room, state, invite string, now time.Time) (Knock, error) {
	var knock Knock

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(knocks)
		if bucket == nil {
			return ErrNoSuchInvite
		}

		// Found by walking rather than by key, because the key is the hash of a
		// secret this caller does not have and should not. The bucket holds a
		// few minutes of knocks, so the walk is over a handful of rows.
		var key []byte
		var raw []byte

		if err := bucket.ForEach(func(each, value []byte) error {
			if key != nil {
				return nil
			}

			var one Knock
			if err := json.Unmarshal(value, &one); err != nil || one.ID != id {
				return nil
			}

			key = append([]byte(nil), each...)
			raw = append([]byte(nil), value...)

			return nil
		}); err != nil {
			return err
		}

		if raw == nil {
			return ErrNoSuchInvite
		}

		if err := json.Unmarshal(raw, &knock); err != nil {
			return ErrNoSuchInvite
		}

		// Named rather than trusted from the request, for the reason redeeming
		// an invite checks the room: a token for one door must not open another.
		if !strings.EqualFold(knock.Room, room) {
			return ErrNoSuchInvite
		}

		if now.Sub(knock.At) > knockFor {
			return ErrInviteExpired
		}

		if knock.State != Knocking {
			return nil
		}

		knock.State = state
		knock.Invite = invite

		encoded, err := json.Marshal(knock)
		if err != nil {
			return err
		}

		return bucket.Put(key, encoded)
	})

	return knock, err
}

// AtTheDoor reads back one knock, for the person who made it.
func (s *Store) AtTheDoor(token string, now time.Time) (Knock, error) {
	var knock Knock

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(knocks)
		if bucket == nil {
			return ErrNoSuchInvite
		}

		raw := bucket.Get(held(token))
		if raw == nil {
			return ErrNoSuchInvite
		}

		if err := json.Unmarshal(raw, &knock); err != nil {
			return ErrNoSuchInvite
		}

		// An admitted knock is readable past the window, because the answer is
		// what the knocker came back for and a slow browser must not lose it.
		if knock.State == Knocking && now.Sub(knock.At) > knockFor {
			return ErrInviteExpired
		}

		return nil
	})

	return knock, err
}

// SweepKnocks removes the ones nobody is waiting on any more.
func (s *Store) SweepKnocks(now time.Time) (gone int, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(knocks)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var knock Knock

			// Kept a while past the window once answered, so that a knocker
			// whose browser asked a moment late is told they were let in rather
			// than told there is no such knock — which reads as a refusal.
			if err := json.Unmarshal(raw, &knock); err != nil ||
				now.Sub(knock.At) > knockFor*2 {
				stale = append(stale, append([]byte(nil), key...))
			}

			return nil
		}); err != nil {
			return err
		}

		for _, key := range stale {
			if err := bucket.Delete(key); err != nil {
				return err
			}

			gone++
		}

		return nil
	})

	if err != nil {
		return 0, fmt.Errorf("sweep knocks: %w", err)
	}

	return gone, nil
}
