package store

import (
	"encoding/json"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
What was seen of somebody at the door.

The media server knows who is in a room and what they are sending, and it does
not know either of the two things an operator asks first: where they came from,
and which machine they came in through. It cannot — by the time it sees them
they arrived over a signalling socket from a relay, and the relay is what it
would report.

This server saw both, once, at the join: the address the request came from, and
the machine it chose for them. Neither is recoverable afterwards, so it is
written down there and nowhere else.

Kept against the identity rather than the name. A name is typed and can be
anything; the identity is signed into the token and is the one field about a
participant that nobody, including them, can change afterwards — which is what
makes the row worth reading at all.

These expire. An arrival is a note about a call in progress and stops being true
the moment somebody leaves, and nothing tells this server when that happens: the
media server holds the room and this one is not in it. So they are swept on age
rather than on departure, and a row older than a long meeting is a row about
nobody.
*/

var arrivals = []byte("arrivals")

// Where an operator has said somebody should come in next time.
//
// Its own bucket rather than a field on their last arrival, which is where it
// lived while there was one arrival per person. There is now one per join, and
// a pin is not about a join that has happened — it is about the next one — so
// writing it onto a past row meant choosing which past row, and reading it back
// meant hoping the same one was still there.
//
// Spent when it is read, so it moves somebody once.
var pins = []byte("pins")

func pinKey(room, identity string) []byte {
	return []byte(room + "\x00" + identity)
}

// How long an arrival is kept.
//
// Longer than any meeting anybody holds here, because the cost of keeping one
// too long is a stale line on a management page and the cost of dropping one too
// early is a person in a call with no address beside their name.
const arrivalFor = 12 * time.Hour

// The longest these are kept, whatever the deployment says.
//
// A deployment may keep room names for ever, and that is a tally. This is a
// list of addresses, and keeping one of those for ever is a different promise
// than the one that setting was making.
const maxArrivalFor = 30 * 24 * time.Hour

// Arrival is what was known about somebody when they were let in.
type Arrival struct {
	// Address is where the request came from, as the deployment resolved it —
	// through a proxy where one is trusted, and from the socket where none is.
	Address string `json:"address,omitempty"`
	// Relay is the machine they were sent to: the door, not necessarily the room.
	Relay string `json:"relay,omitempty"`
	// Holding is the machine the meeting is on, where that is a different one.
	Holding string `json:"holding,omitempty"`
	// Forwarded says their media is being carried through Relay to Holding.
	Forwarded bool `json:"forwarded,omitempty"`
	// Pinned is a relay an operator has said this person should come in
	// through next time, and is cleared the moment it is used.
	//
	// Once rather than for good: moving somebody out of a bad path is about the
	// call they are in, and a pin that outlived it would quietly overrule every
	// choice they made afterwards without appearing anywhere they could see.
	Pinned string `json:"pinned,omitempty"`

	// Name is what they called themselves, which the identity does not say.
	//
	// Added when these became a history rather than a note about who is in the
	// room: for a call in progress the media server supplies the name and this
	// only had to supply what the media server cannot know. Read back weeks
	// later there is no media server to ask, and a page of addresses and hex
	// identities answers nobody's question.
	Name string `json:"name,omitempty"`

	// Client is what they came in with: a browser and the system under it,
	// or one of the apps and its version. Read from the request at the door,
	// as the address is, because the media server only ever learns the SDK.
	// Absent for joins from before it was kept.
	Client *Client `json:"client,omitempty"`

	// At is when they arrived, and is what orders the history.
	At time.Time `json:"at"`
}

// A Client is what somebody joined from, as their request named it.
//
// Taken on the request's word: a user agent is whatever the caller sends, so
// this answers "what were they using" for an operator helping somebody, and
// is no evidence of anything.
type Client struct {
	// Kind is "web" for a browser, the platform of one of the apps ("iphone",
	// "ipad", "mac", "android", "windows"), "app" for an app too old to say
	// which, or "other".
	Kind string `json:"kind"`
	// App is the app's version, for an app that says it.
	App string `json:"app,omitempty"`
	// Browser is the browser and its major version, such as "Chrome 155".
	Browser string `json:"browser,omitempty"`
	// System is the operating system as far as the request tells it, such as
	// "iOS 27.0.1" or "Windows". Browsers no longer say the version of a
	// desktop system, so for them it is usually the name alone.
	System string `json:"system,omitempty"`
	// Device is the model, where an app says it ("iPhone17,1", "SM-F956B").
	Device string `json:"device,omitempty"`
	// Agent is the user agent as sent, cut short, for whatever the fields
	// above did not catch.
	Agent string `json:"agent,omitempty"`
}

// arrivalKey is one join: a room, when it happened, and who.
//
// The time is in the key, and it is what turned these from a note into a
// history. Keyed by room and identity alone, a second join overwrote the first
// — so somebody who left and came back six times left one row, and the question
// an operator actually asks ("who has been in this room, and from where") had
// no answer at all once the call ended.
//
// RFC 3339 with nanoseconds because it sorts as a string in the order it sorts
// as a time, which is what lets a room's history be read off the cursor in
// order instead of gathered and sorted.
//
// A separator that cannot occur in any part: room names are checked against a
// narrow alphabet, an identity is a mark and hex, and the timestamp is digits
// and punctuation. Without one, two different triples could share a key.
func arrivalKey(room string, at time.Time, identity string) []byte {
	return []byte(room + "\x00" + at.UTC().Format(time.RFC3339Nano) + "\x00" + identity)
}

// arrivalOf reads the identity back out of a key.
func arrivalOf(key, prefix string) string {
	rest := strings.TrimPrefix(key, prefix)

	at := strings.IndexByte(rest, 0)
	if at < 0 {
		return rest
	}

	return rest[at+1:]
}

// Arrived writes down what was seen of somebody at the join.
func (s *Store) Arrived(room, identity string, arrival Arrival) error {
	encoded, err := json.Marshal(arrival)
	if err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(arrivals)
		if err != nil {
			return err
		}

		return bucket.Put(arrivalKey(room, arrival.At, identity), encoded)
	})
}

// Arrivals reads back everybody seen arriving at one room.
//
// Returned by identity, so a caller holding the media server's roster can put
// the two together without a second pass. A room nobody arrived at is an empty
// map rather than an error: the store is not the authority on who is in a room
// and must not answer as if it were.
func (s *Store) Arrivals(room string) map[string]Arrival {
	found := make(map[string]Arrival)
	prefix := room + "\x00"

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(arrivals)
		if bucket == nil {
			return nil
		}

		cursor := bucket.Cursor()
		for key, raw := cursor.Seek([]byte(prefix)); key != nil &&
			strings.HasPrefix(string(key), prefix); key, raw = cursor.Next() {
			var arrival Arrival
			if err := json.Unmarshal(raw, &arrival); err != nil {
				continue
			}

			if time.Since(arrival.At) > arrivalFor {
				continue
			}

			// The most recent, because the cursor walks them in time order and a
			// person who left and came back has more than one. This answers
			// "who is here", and the row that describes that is the last one.
			found[arrivalOf(string(key), prefix)] = arrival
		}

		return nil
	})

	return found
}

// SweepArrivals removes the ones that have aged out.
//
// On the same timer as the sessions, and for the same reason: without it the
// file grows by one entry per join forever, and the entries are about calls that
// ended months ago.
//
// The caller passes how long to keep them rather than this using the twelve
// hours that decides who counts as present. The two were the same number while
// these were a note about a call in progress; they are not the same question
// now that they are also a history, and sweeping the history on the presence
// clock would have left every room's past stopping twelve hours ago while
// looking complete.
//
// Ordinarily nothing here reaches this: a room's arrivals go when the room is
// forgotten. What is left for this to find is the orphans — a name that was
// joined but never opened, or rows left by a version that keyed them
// differently.
func (s *Store) SweepArrivals(now time.Time, keepFor time.Duration) (gone int, err error) {
	// A deployment that keeps room names for ever still bounds this. Addresses
	// are not a tally and a file that grows by a row per join with nothing ever
	// taking one out is a different promise than the one that setting makes.
	if keepFor <= 0 || keepFor > maxArrivalFor {
		keepFor = maxArrivalFor
	}

	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(arrivals)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var arrival Arrival
			if err := json.Unmarshal(raw, &arrival); err != nil ||
				now.Sub(arrival.At) > keepFor {
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
		}

		gone = len(stale)

		return nil
	})

	return gone, err
}

// Visit is one join, as a history reads it.
//
// The identity is carried alongside rather than folded away: two people can
// type the same display name, and the identity is the half nobody can choose.
type Visit struct {
	Identity string `json:"identity"`
	Arrival
}

// Visits reads every join recorded against one room, newest first.
//
// Distinct from Arrivals, which answers "who is in this room" and therefore
// keeps one row per person and drops anything older than a long meeting. This
// answers "who has been in this room", which is a different question with a
// different shape: every join, in order, for as long as the room itself is
// remembered.
//
// No age filter. What bounds this is the sweep and the room's own life — a
// history that quietly stopped at twelve hours would be worse than none, because
// it would look complete.
//
// The count is returned with the rows for the same reason. There is a ceiling,
// because this is drawn on a page, and a page showing five hundred rows of a
// thousand while saying nothing is a history that looks complete and is not —
// which is the fault above with a different cause.
func (s *Store) Visits(room string, limit int) (found []Visit, total int) {
	if limit <= 0 {
		limit = 500
	}

	found = make([]Visit, 0, 32)
	prefix := room + "\x00"

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(arrivals)
		if bucket == nil {
			return nil
		}

		cursor := bucket.Cursor()

		// Walked forwards and reversed at the end rather than seeking to the
		// end of the range: bolt's Prev from a Seek that landed past the prefix
		// is fiddly to get right, and a room's history is small enough that the
		// simple walk costs nothing worth the risk of getting it subtly wrong.
		for key, raw := cursor.Seek([]byte(prefix)); key != nil &&
			strings.HasPrefix(string(key), prefix); key, raw = cursor.Next() {
			var arrival Arrival
			if err := json.Unmarshal(raw, &arrival); err != nil {
				continue
			}

			found = append(found, Visit{Identity: arrivalOf(string(key), prefix), Arrival: arrival})
		}

		return nil
	})

	for left, right := 0, len(found)-1; left < right; left, right = left+1, right-1 {
		found[left], found[right] = found[right], found[left]
	}

	total = len(found)

	if len(found) > limit {
		found = found[:limit]
	}

	return found, total
}

// forgetArrivals removes every join recorded against one room.
//
// Called where the room record itself is removed, so that a history does not
// outlive the room it is about — and so that the addresses in it are not kept
// after the last thing that referred to them has gone.
func forgetArrivals(tx *bolt.Tx, room string) error {
	bucket := tx.Bucket(arrivals)
	if bucket == nil {
		return nil
	}

	prefix := room + "\x00"

	var stale [][]byte
	cursor := bucket.Cursor()

	for key, _ := cursor.Seek([]byte(prefix)); key != nil &&
		strings.HasPrefix(string(key), prefix); key, _ = cursor.Next() {
		stale = append(stale, append([]byte(nil), key...))
	}

	for _, key := range stale {
		if err := bucket.Delete(key); err != nil {
			return err
		}
	}

	return nil
}
