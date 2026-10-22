// Package store keeps the few facts that have to survive a restart.
//
// Most of what is here is observation and could be lost without changing what
// the server does: how many times a name has been joined, and when. Two things
// could not, and both arrived with the setting that limits who may open a room.
// One is that setting itself, which is changed from the management pages and so
// has nowhere else to live. The other is whether a name has ever been used,
// because under that setting it is what decides whether somebody is let in.
//
// So this file is a tally on one deployment and part of the access control on
// another, and one setting is the whole difference. Losing it where anybody may
// open a room costs the figures on a management page. Losing it where only
// administrators may turns people out of rooms they were in the middle of using.
//
// What has not changed is that there is no migration framework, no schema
// version, and no startup check. A record this build cannot read is treated as
// one that is not there — a lost tally in the first case, a closed room in the
// second — which is why fields here are only ever added, and why forgetting
// leaves a record it could not read exactly where it is.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"time"

	"tomoshibi/internal/room"

	bolt "go.etcd.io/bbolt"
)

// The buckets. Named once, here, because these names live in the file and
// outlive any refactor of this package.
var (
	// rooms holds one tally per name somebody used.
	rooms = []byte("rooms")

	// settings holds the handful of choices made from the management pages,
	// which have no configuration file to write to.
	settings = []byte("settings")
)

// openedBy is where settings keeps a room.Opening.
var openedBy = []byte("rooms.opened_by")
var joinedBy = []byte("rooms.joined_by")

// embyRelay is where settings keeps whether a media server's films may be
// relayed at all. "on" or "off"; see EmbyRelay.
var embyRelay = []byte("watch.emby_relay")

// youtubeRelay is where settings keeps whether YouTube is relayed for the
// viewers who cannot reach it. "on" or "off"; see YouTubeRelay.
var youtubeRelay = []byte("watch.youtube_relay")

// bangumiRelay is where settings keeps whether Bilibili's bangumi are relayed
// for everybody. "on" or "off", and on where nothing is written; see
// BangumiRelay.
var bangumiRelay = []byte("watch.bangumi_relay")

// ErrNotOpen refuses a name nobody has used to somebody who may not open one.
var ErrNotOpen = errors.New("that room has not been opened")

// Room is what is known about a name somebody used.
//
// A room has no existence beyond its name, so this is a tally rather than a
// definition: it records that the name was used, not that anything exists
// because of it. Fields are only ever added, never renamed or removed, which is
// the whole of the schema-evolution story here.
//
// That the record is here at all is the second fact it carries, and the one
// that is load-bearing: where only administrators may open a room, a name with
// no record is a name nobody may use. Which is why Seen is not only a figure on
// a management page — it is how long the room has left. See Forget.
type Room struct {
	// HeldAt is when the relay above was noted.
	//
	// Its own field rather than Seen, which is what made the expiry below dead
	// code: a join refreshes Seen before it reads the note, so the note was
	// always a moment old and never aged out. Nothing said so — the timer simply
	// never fired, and the store's own test aged Seen by hand and passed.
	HeldAt time.Time `json:"heldAt,omitempty"`

	// Placed marks a note somebody made on purpose.
	//
	// A note left by a join is a guess about where the next person should go and
	// is worth nothing once the meeting has ended. A note left by an operator
	// moving a room is an instruction, and is worth exactly as much when there
	// is no meeting — which is the moment it is read, because moving a room ends
	// the call it is moving. Read as a guess, an instruction was thrown away
	// each time and every move silently undone.
	Placed bool `json:"placed,omitempty"`

	// Host is the mark of whoever the room answers to.
	//
	// Set to whoever first spoke the name, because somebody has to be able to
	// quiet a room and there is nobody else it could reasonably be. Transferable,
	// because the person who opened a recurring meeting is not always the person
	// running it, and because they leave.
	//
	// The mark rather than the identity: an identity is minted fresh whenever a
	// passphrase changes and carries a random tail, so a host who reloaded into a
	// new one would stop being host without anybody doing anything. A mark is the
	// same on every visit for somebody who can prove a name, and lasts a session
	// for somebody who cannot — which is the whole of what can honestly be
	// promised to an anonymous host.
	Host string `json:"host,omitempty"`

	// Created is when the name was first seen.
	Created time.Time `json:"created"`
	// Seen is when it was last joined.
	Seen time.Time `json:"seen"`
	// Joins counts every join since the beginning.
	Joins uint64 `json:"joins"`

	// Relay is the machine this room was last held on.
	//
	// Recorded because a meeting lives on one server and the rule about who may
	// use a reserved one is about starting a call there, not about the people
	// invited to it: a room an administrator opened on their own relay has to
	// let in everybody they sent the link to. Knowing where it is is the whole
	// of what that needs.
	//
	// Last rather than first, so a room that emptied and came back somewhere
	// else is recorded where it now is. It is a note about where to find a
	// meeting, not a claim of ownership.
	Relay string `json:"relay,omitempty"`
}

// Store is the database.
//
// Safe for concurrent use: bbolt serialises writers itself and reads run in
// their own transactions, so there is no lock here to hold and no pool to size.
type Store struct {
	db *bolt.DB
}

// Open the store, creating the file and its parent directory.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}

	// Long enough to outlast a restart, and short enough to be an answer.
	//
	// The file is locked exclusively, so without any timeout a second process
	// waits for ever with no indication of why. With two seconds it gave up
	// inside the window the process it is replacing is still draining: shutdown
	// waits up to ten for calls to end, so `systemctl restart` produced a run of
	// "held by another process" failures and a restart counter climbing, until
	// one attempt happened to land after the old process let go.
	//
	// That is a working restart which reads like a broken one, and the log it
	// leaves is the same shape as the log of a genuine second copy — which is
	// what this message exists to name. Fifteen covers the drain with room, and
	// a process genuinely fighting another for the file waits fifteen seconds
	// and is then told exactly that.
	//
	// Reasoned from the two numbers rather than reproduced. An idle deployment
	// lets go at once, so the overlap only appears where there are calls to
	// drain — which is the restart nobody schedules and everybody eventually
	// does.
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 15 * time.Second})
	if errors.Is(err, bolt.ErrTimeout) {
		return nil, fmt.Errorf(
			"%s is held by another process, almost certainly the server itself. "+
				"Stop it and try again: the store admits one process at a time", path)
	}
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}

	return &Store{db: db}, nil
}

// Close releases the file.
func (s *Store) Close() error {
	return s.db.Close()
}

// OpenRoom records a join, refusing a name nobody has used when mayOpen is
// false. Returns the tally including this join.
//
// The refusal and the tally are one transaction because they are one question.
// bbolt admits a single writer at a time, so two people arriving at a fresh name
// in the same instant are put in an order: the first opens it, and the second
// finds it already open and is let in whoever they are. Asked separately — read,
// decide, write — both would find nothing there and the answer would depend on
// which of them the scheduler ran first.
//
// The name is what "existing" means here, and nothing else could be. Whether
// anybody is in the room at this moment is the media server's to know and its
// answer changes every time the last participant leaves, so a policy resting on
// it would turn everybody out of their own meeting the moment it emptied for a
// second. This asks whether the name was ever used, which only becomes true and
// never goes back.
func (s *Store) OpenRoom(name string, mayOpen bool) (Room, error) {
	var tally Room
	now := time.Now().UTC()

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(rooms)
		if err != nil {
			return err
		}

		raw := bucket.Get([]byte(name))
		if raw == nil && !mayOpen {
			return ErrNotOpen
		}

		// A record this build cannot read is treated as one that is not there.
		// Losing a tally is the whole cost, and it beats refusing to let anybody
		// into a meeting over a stale row.
		if raw != nil {
			if err := json.Unmarshal(raw, &tally); err != nil {
				tally = Room{}
			}
		}

		tally.Joins++
		tally.Seen = now
		if tally.Created.IsZero() {
			tally.Created = now
		}

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})

	// Returned bare rather than wrapped: this one is an answer the caller sends
	// on to somebody, not a failure to report.
	if errors.Is(err, ErrNotOpen) {
		return Room{}, ErrNotOpen
	}

	if err != nil {
		return Room{}, fmt.Errorf("record a join for %q: %w", name, err)
	}

	return tally, nil
}

// Forget removes names nobody has joined since the given moment, at most limit
// of them, and reports how many went.
//
// Bounded because bbolt admits one writer at a time and a join is a write. A
// single transaction clearing a bucket that has been allowed to grow would hold
// that writer for the whole of it, and every person trying to join a call would
// wait. So a sweep is a series of small transactions with room between them,
// and the caller comes back for more.
//
// Why there is anything to sweep at all: a name is written down the first time
// somebody joins it and nothing has ever taken one away. Where anybody may open
// a room the only door to that is the rate limiter, which bounds how fast names
// arrive and not how many — measured at four hundred bytes apiece, a script
// spending its whole allowance writes a few hundred megabytes a day and nothing
// says a word.
//
// Ageing them is not merely a way of keeping the file small, though. A name
// nobody has spoken in a month is not a room in use, and calling it one is the
// less honest reading of the two: it leaves a room open for good because
// somebody said its name once, last year.
//
// A record this build cannot read is left exactly where it is. Its age is
// unknown, and under a policy where a missing record is a closed door, deleting
// on an unknown age is the wrong way to be wrong.
func (s *Store) Forget(since time.Time, limit int) (int, error) {
	if limit <= 0 {
		return 0, nil
	}

	// Found in a read transaction and removed in a write one. bbolt lets any
	// number of readers run beside its one writer, so the search, which has to
	// look at every name because the bucket is ordered by name and not by age,
	// no longer holds the door while it does. It once ran inside the write
	// transaction: the batch bounded how many names were deleted but not how
	// many were read, so every sweep walked and decoded the whole bucket with
	// every join waiting behind it — the very thing the batch was there to
	// prevent, on exactly the store that had grown large enough to need it.
	stale, err := s.stale(since, limit)

	gone := 0
	if err == nil && len(stale) > 0 {
		gone, err = s.drop(stale, since)
	}

	if err != nil {
		return 0, fmt.Errorf("forget rooms last joined before %s: %w", since.Format(time.RFC3339), err)
	}

	return gone, nil
}

// stale finds up to limit names last joined before since, without taking the
// writer.
func (s *Store) stale(since time.Time, limit int) ([][]byte, error) {
	found := make([][]byte, 0, limit)

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		err := bucket.ForEach(func(name, raw []byte) error {
			if len(found) >= limit {
				return errEnough
			}

			if staleSince(raw, since) {
				found = append(found, append([]byte(nil), name...))
			}

			return nil
		})
		if errors.Is(err, errEnough) {
			return nil
		}

		return err
	})

	return found, err
}

// drop removes the named records that are still stale.
//
// Asked again, because somebody may have joined one between the search and
// this, and a room somebody just walked into is the last one to forget. Under
// the admins policy that is not a tidiness question: a forgotten name is a
// closed door, and it would have closed on a meeting as it began.
func (s *Store) drop(names [][]byte, since time.Time) (int, error) {
	gone := 0

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		for _, name := range names {
			if !staleSince(bucket.Get(name), since) {
				continue
			}
			if err := bucket.Delete(name); err != nil {
				return err
			}

			// And what was seen of the people who were in it. A history must not
			// outlive the room it is about, and the addresses in it must not be
			// kept after the last thing that referred to them has gone.
			if err := forgetArrivals(tx, string(name)); err != nil {
				return err
			}

			gone++
		}

		return nil
	})

	return gone, err
}

// staleSince reports whether a record was last joined before since. A record that
// is missing or cannot be read is not stale: its age is unknown.
func staleSince(raw []byte, since time.Time) bool {
	if raw == nil {
		return false
	}

	var tally Room
	if err := json.Unmarshal(raw, &tally); err != nil {
		return false
	}

	return tally.Seen.Before(since)
}

// errEnough stops a walk that has found as much as it was asked for. Never
// returned to a caller: a full batch is an ordinary outcome, and the caller
// learns of it from the count.
var errEnough = errors.New("enough")

// Opening is who may use a name nobody has used before.
//
// Kept here rather than in the configuration because it is changed from the
// management pages, and those cannot edit a file. What the configuration holds
// is the value this answers before anybody has changed it — see AdoptOpening.
//
// An absent or unreadable setting reads as room.ByAnyone, on the same principle
// as an unreadable tally reading as absent. The default is the state every
// deployment that never touched this is in, and a failure to read one key is
// not a reason to start turning people away from meetings.
func (s *Store) Opening() room.Opening {
	var opening room.Opening

	_ = s.db.View(func(tx *bolt.Tx) error {
		if bucket := tx.Bucket(settings); bucket != nil {
			opening = room.Opening(bucket.Get(openedBy))
		}

		return nil
	})

	if !opening.Valid() {
		return room.ByAnyone
	}

	return opening
}

// Joining is who may enter a room that already exists.
//
// Falls back to the configuration's value rather than to a constant, which is
// the difference between this and Opening: opening has had a stored value since
// it existed and a deployment that has never set one meant the default. Joining
// is new, so an unset value has to mean "whatever the file says" or every
// deployment that configured it would find the setting ignored.
func (s *Store) Joining(configured room.Joining) room.Joining {
	var joining room.Joining

	_ = s.db.View(func(tx *bolt.Tx) error {
		if bucket := tx.Bucket(settings); bucket != nil {
			joining = room.Joining(bucket.Get(joinedBy))
		}

		return nil
	})

	if !joining.Valid() {
		if configured.Valid() {
			return configured
		}

		return room.ByWhoeverKnows
	}

	return joining
}

// SetJoining changes who may enter a room that already exists.
func (s *Store) SetJoining(joining room.Joining) error {
	if !joining.Valid() {
		return fmt.Errorf("%q is not a way of joining rooms", joining)
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(settings)
		if err != nil {
			return err
		}

		return bucket.Put(joinedBy, []byte(joining))
	})
}

// EmbyRelay reports whether a film chosen from a media server may be relayed
// through this deployment, for the people who were granted that.
//
// The switch above every individual grant, and off unless somebody turned it on
// from the management pages: absent, unreadable, or anything but "on" reads as
// off. That is the opposite of how the room policies fail, and on purpose. A
// room policy that cannot be read and fails closed turns people away from their
// own meetings; this one failing closed means a film plays from where each
// viewer is, or does not play, and nobody's bandwidth is spent on a setting
// nobody can see.
//
// In the store and not the configuration file, so that an old binary — which
// refuses a file holding a key it does not know — still starts on a deployment
// that has turned this on.
func (s *Store) EmbyRelay() bool {
	on := false

	_ = s.db.View(func(tx *bolt.Tx) error {
		if bucket := tx.Bucket(settings); bucket != nil {
			on = string(bucket.Get(embyRelay)) == "on"
		}

		return nil
	})

	return on
}

// SetEmbyRelay turns the media server relay on or off for the whole deployment.
//
// Written as a word rather than a byte, so that somebody reading the file with
// a bolt browser while working out why films stopped playing can read it.
func (s *Store) SetEmbyRelay(on bool) error {
	value := []byte("off")
	if on {
		value = []byte("on")
	}

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(settings)
		if err != nil {
			return err
		}

		return bucket.Put(embyRelay, value)
	})

	if err != nil {
		return fmt.Errorf("set whether the media server relay is on: %w", err)
	}

	return nil
}

// YouTubeRelay reports whether a YouTube video may be relayed through this
// deployment, for whoever in the call cannot reach YouTube: in practice, the
// people watching from mainland China.
//
// The second exception a deployment that relays nothing can make, beside
// EmbyRelay and kept the same way: off unless somebody turned it on, and off
// for anything but "on", so that a key nobody can read spends nothing. Unlike
// the Emby relay it stands above no grant. Nobody chooses to need it — a viewer
// is behind a border or is not — so there is nobody to give it to, and the
// switch is the whole of the decision.
func (s *Store) YouTubeRelay() bool {
	on := false

	_ = s.db.View(func(tx *bolt.Tx) error {
		if bucket := tx.Bucket(settings); bucket != nil {
			on = string(bucket.Get(youtubeRelay)) == "on"
		}

		return nil
	})

	return on
}

// SetYouTubeRelay turns the YouTube relay on or off for the whole deployment,
// written as a word for the reason SetEmbyRelay's is.
func (s *Store) SetYouTubeRelay(on bool) error {
	value := []byte("off")
	if on {
		value = []byte("on")
	}

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(settings)
		if err != nil {
			return err
		}

		return bucket.Put(youtubeRelay, value)
	})

	if err != nil {
		return fmt.Errorf("set whether the YouTube relay is on: %w", err)
	}

	return nil
}

// BangumiRelay reports whether Bilibili's bangumi -- the series, films and
// documentaries it licenses -- may be relayed through this deployment, for
// everybody in the call.
//
// The third exception a deployment that relays nothing can make, and the one
// that starts on. The owner chose it (2026-10-14): an episode for members plays
// whole, and anything above 720p plays at all, only through the relay, so a
// series not relayed is mostly a series not watched. On, therefore, where the
// switch was never moved, and off only where somebody turned it off. A value
// that is neither reads as off, as an unreadable one does for the other two,
// so that a damaged key spends nothing.
//
// Starting on spends nothing by itself either. An episode is read to be relayed
// only by a gateway started with RELAY_BANGUMI, which is the deployment's own
// decision on the machine; a gateway without it reads bangumi as before, and
// nothing here relays an episode that gateway did not read as one.
func (s *Store) BangumiRelay() bool {
	on := true

	_ = s.db.View(func(tx *bolt.Tx) error {
		if bucket := tx.Bucket(settings); bucket != nil {
			if value := bucket.Get(bangumiRelay); value != nil {
				on = string(value) == "on"
			}
		}

		return nil
	})

	return on
}

// SetBangumiRelay turns the bangumi relay on or off for the whole deployment,
// written as a word for the reason SetEmbyRelay's is.
func (s *Store) SetBangumiRelay(on bool) error {
	value := []byte("off")
	if on {
		value = []byte("on")
	}

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(settings)
		if err != nil {
			return err
		}

		return bucket.Put(bangumiRelay, value)
	})

	if err != nil {
		return fmt.Errorf("set whether the bangumi relay is on: %w", err)
	}

	return nil
}

// SetOpening changes who may open a room.
func (s *Store) SetOpening(opening room.Opening) error {
	if !opening.Valid() {
		return fmt.Errorf("%q is not a way of opening rooms", opening)
	}

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(settings)
		if err != nil {
			return err
		}

		return bucket.Put(openedBy, []byte(opening))
	})

	if err != nil {
		return fmt.Errorf("set who may open a room: %w", err)
	}

	return nil
}

// AdoptOpening takes the configured value where nothing has been chosen yet, and
// returns what is in effect either way.
//
// So that a configuration file still describes what a fresh deployment does,
// without a file being able to quietly undo a choice somebody made from the
// management pages. The file is where this starts; after that the store is the
// answer, and the runtime panel shows both so that the difference is visible to
// whoever is reading the file and wondering why it is not being obeyed.
func (s *Store) AdoptOpening(configured room.Opening) (room.Opening, error) {
	var opening room.Opening

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(settings)
		if err != nil {
			return err
		}

		if held := room.Opening(bucket.Get(openedBy)); held.Valid() {
			opening = held
			return nil
		}

		opening = configured

		return bucket.Put(openedBy, []byte(configured))
	})

	if err != nil {
		return room.ByAnyone, fmt.Errorf("adopt who may open a room: %w", err)
	}

	return opening, nil
}

// Named pairs a room with the name it is filed under.
type Named struct {
	Name string
	Room Room
}

// Rooms lists every room ever joined, most recently seen first.
func (s *Store) Rooms() ([]Named, error) {
	var found []Named

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			// Nothing has ever been written, so there is nothing to list.
			return nil
		}

		return bucket.ForEach(func(name, raw []byte) error {
			var tally Room
			if err := json.Unmarshal(raw, &tally); err != nil {
				return nil
			}
			found = append(found, Named{Name: string(name), Room: tally})
			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("list rooms: %w", err)
	}

	sort.Slice(found, func(a, b int) bool {
		return found[a].Room.Seen.After(found[b].Room.Seen)
	})

	return found, nil
}

// HoldRoom records which relay a room is being held on.
//
// Written after a join is authorised, so it reflects where somebody was
// actually sent. Failure is not reported upward: this is a note that makes a
// later join tidier, and a call should not be refused because a note could not
// be kept.
func (s *Store) HoldRoom(name, relay string) error {
	return s.hold(name, relay, false)
}

func (s *Store) hold(name, relay string, placed bool) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			return nil
		}

		// A join may not demote an instruction to a guess.
		//
		// The two callers write the same field for different reasons: one is
		// somebody saying where the room goes, the other is a join recording
		// where it went. The second runs on every arrival, and while it cleared
		// the flag the instruction survived exactly until the first person
		// walked in — which is the same "works once, ignored afterwards" fault
		// as the one the join path used to cause deliberately, reached by a
		// route nobody was looking at.
		//
		// Only PlaceRoom sets this, and only ReleaseRoom clears it — and the
		// name goes with the flag. Keeping the flag while letting the join
		// overwrite the name would be worse than the fault it replaces: the
		// record would read as a placement onto a machine nobody chose, which
		// is a lie with a confident face on it. It happens whenever a join
		// lands somewhere other than the placement, which is exactly the case
		// where the placement matters.
		if !placed && tally.Placed {
			return nil
		}

		if tally.Relay == relay && tally.Placed == placed {
			return nil
		}

		tally.Relay = relay
		tally.Placed = placed
		tally.HeldAt = time.Now().UTC()

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})
}

// How long a note about where a room is stays worth believing.
//
// A meeting lives on one server for as long as somebody is in it, and this
// server has no cheap way to ask whether anybody still is — the media server
// knows, and asking it means a request to every relay on every join.
//
// So the note expires instead. Two hours without anybody joining is a room that
// has almost certainly emptied, and the cost of being wrong either way is
// small: too eager, and somebody is sent to a relay the meeting is not on, where
// the media server forwards them to it and only their measurement was wasted;
// too patient, and a room that ended hours ago sends the next meeting of the
// same name back to a machine it need not use.
//
// What must not happen is a *guess* lasting forever, which is what it did when
// it was first written: every room would return to whichever relay it first
// landed on, for good, and choosing a server would stop meaning anything the
// second time a name was used.
//
// A placement is not a guess and is not aged out on this clock. Somebody chose
// it, and it stands until somebody chooses otherwise — an expiry on it would be
// this server overruling an operator on a timer, which is the same fault seen
// from the other side. The price is that a pin is invisible unless it is shown,
// so it is shown: the rooms page marks a placed room and offers to hand it back
// to the policy.
//
// It is not eternal, though, and must not be. What bounds it is the room record
// it lives in: a name nobody has joined for `rooms.remember` is forgotten
// whole, and the placement goes with it. So a room in use keeps the machine it
// was given, and a name used once keeps it for three days and then stops
// existing — rather than sitting in the list for ever with a pin on it, waiting
// to decide something about a meeting nobody is going to hold.
const heldFor = 2 * time.Hour

// HeldOn says which relay a room is being held on, and whether somebody chose
// it rather than a join leaving it behind.
//
// The second half is what the caller needs to know before deciding whether to
// check it against the media server: a guess about a meeting that has ended is
// worth nothing, and an instruction is worth the same whether a meeting is
// running or not.
func (s *Store) HeldOn(name string) (string, bool) {
	var relay string
	var placed bool

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			return nil
		}

		// An instruction does not age out, and is not spent by being obeyed.
		// It stood for one join once — the join that carried it out cleared it
		// — so a room came back to the chosen machine and every later meeting
		// of that name went wherever the policy pointed. An operator who has
		// said where a room goes has said it about the room, not about the next
		// person through the door.
		if !tally.Placed && time.Since(tally.HeldAt) > heldFor {
			return nil
		}

		relay, placed = tally.Relay, tally.Placed

		return nil
	})

	return relay, placed
}

// PlaceRoom says where a room is to be held, on purpose.
//
// Distinct from HoldRoom, which is what a join leaves behind. The difference is
// not the value written but how long it is believed: a guess is checked against
// whether the meeting is still running, and an instruction is carried out.
func (s *Store) PlaceRoom(name, relay string) error {
	return s.hold(name, relay, true)
}

// ReleaseRoom forgets where a room was being held.
//
// The timed expiry in HeldOn is what covers the ordinary case — a meeting that
// ends leaves nobody to say so — and this is for the cases a clock cannot
// answer. An operator taking a relay out of service wants the rooms on it picked
// again now rather than in two hours; a placement is given back to the policy
// only here, because nothing else may undo one; and a test needs to arrange a
// room that has gone quiet without waiting for it to.
func (s *Store) ReleaseRoom(name string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			return nil
		}

		tally.Relay = ""

		// And the flag with it. Left standing, the record reads as a placement
		// onto nowhere: HeldOn answers ("", true), which is inert today only
		// because every caller checks the name first.
		tally.Placed = false

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})
}

// SetHost records who a room answers to.
//
// Written against a room that already exists and quietly does nothing where one
// does not: the caller is either the join that just opened it or a transfer from
// somebody already in it, and neither should create a record by asking.
func (s *Store) SetHost(name, mark string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			return nil
		}

		tally.Host = mark

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})
}

// ClaimHost records who a room answers to, but only where nobody holds it yet.
//
// One transaction, because the alternative is two: reading whether a room has a
// host and then setting one is a pair of statements with a gap between them, and
// two people opening the same name at the same moment both find it empty and
// both write. The room then answers to whichever write landed second, which is
// not the person who opened it and is not anybody's idea of the rule.
//
// The window is small and the room is a name anybody may use, so this is not
// somebody stealing a room — it is the room quietly belonging to the wrong one
// of two people who arrived together, which is exactly the kind of thing that is
// never reproduced and never believed.
//
// Says whether it took, so the caller can tell being first from being second.
func (s *Store) ClaimHost(name, mark string) (bool, error) {
	var claimed bool

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			return nil
		}

		if tally.Host != "" {
			return nil
		}

		tally.Host = mark

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		if err := bucket.Put([]byte(name), encoded); err != nil {
			return err
		}

		claimed = true

		return nil
	})

	return claimed, err
}

// HostOf says which mark a room answers to, or "" where it answers to nobody.
//
// A room this cannot read answers to nobody, which is the safe direction: the
// alternative is a room that answers to whoever asks. But it is also the
// direction that says nothing, and what it looks like from a chair is a host
// whose controls stop working in the middle of their own meeting, with no
// notice and nothing in any log. Both failures are said out loud for that
// reason, and neither is returned: there is nothing the caller could do with
// them that differs from what it does already.
func (s *Store) HostOf(name string) string {
	var mark string

	if err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			// A record this build cannot read is treated as one that is not
			// there, which is the rule for every record here. Worth saying for
			// this one, because the thing it decides is who may run a meeting.
			slog.Error("a room's record could not be read, so it answers to nobody",
				"room", name, "error", err)

			return nil
		}

		mark = tally.Host

		return nil
	}); err != nil {
		slog.Error("could not look up who a room answers to, so it answers to nobody",
			"room", name, "error", err)
	}

	return mark
}

// PinEntry records which relay somebody should come in through next time.
//
// Against the room and the identity together, because that is what it is about:
// where a person enters is theirs, separately from where the room is held, and
// the same person in two meetings may want two different doors.
//
// Written onto the arrival, which already holds what was seen of them at the
// last one. It is read at the next join and cleared there, so it moves somebody
// once rather than pinning them for good — an operator moving a person out of a
// bad path means this call, and a pin that outlived it would quietly overrule
// every choice they made afterwards.
func (s *Store) PinEntry(room, identity, relay string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(pins)
		if err != nil {
			return err
		}

		return bucket.Put(pinKey(room, identity), []byte(relay))
	})
}

// TakePin reads a pin and spends it, so it moves somebody once.
func (s *Store) TakePin(room, identity string) string {
	var relay string

	_ = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(pins)
		if bucket == nil {
			return nil
		}

		key := pinKey(room, identity)

		raw := bucket.Get(key)
		if raw == nil {
			return nil
		}

		relay = string(raw)

		return bucket.Delete(key)
	})

	return relay
}

// Used reports whether this name has ever been opened.
//
// Read rather than inferred from HeldOn, which answers about a relay and is
// empty for a room nobody has joined since the note aged out. The question here
// is whether the name exists at all, and the record is what says so.
//
// A store that will not answer says the name is unused. That is the safe
// direction for the caller: an unused name is an opening, and an opening is
// already gated by whoever may open one.
func (s *Store) Used(name string) bool {
	var used bool

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		used = bucket.Get([]byte(name)) != nil

		return nil
	})

	return used
}

// AccountCount is how many accounts exist, for a policy that asks for one.
//
// A count rather than the list: the only caller wants to know whether a rule
// asking for an account is a rule anybody could satisfy, and reading every
// account to answer that on every join would be a waste of the store's one
// reader.
func (s *Store) AccountCount() int {
	count := 0

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return nil
		}

		count = bucket.Stats().KeyN

		return nil
	})

	return count
}

// ForgetRoom removes one name and everything written against it.
//
// The record holds three things and all three go: that the name has been used,
// where an operator said the room goes, and what was seen of the people who
// were in it. Removing only the placement is a different action and has its own
// control — this one is for a name somebody wants gone.
//
// Reports whether there was anything to remove, so a page can tell "done" from
// "that was already not there" instead of showing success for a name that never
// existed.
func (s *Store) ForgetRoom(name string) (bool, error) {
	found := false

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		if bucket.Get([]byte(name)) == nil {
			return nil
		}

		found = true

		if err := bucket.Delete([]byte(name)); err != nil {
			return err
		}

		// And the history, for the reason the sweep does it: a record of who was
		// in a room must not outlive the room, and the addresses in it must not
		// be kept once the last thing referring to them has gone.
		return forgetArrivals(tx, name)
	})

	if err != nil {
		return false, fmt.Errorf("forget the room %s: %w", name, err)
	}

	return found, nil
}
