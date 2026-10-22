package store

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"

	"tomoshibi/internal/room"
)

/*
Meetings arranged before anybody is in them.

A room here is a name and nothing else, and that is still true: this does not
create a room, it writes down that somebody means to use a name at a time, on a
machine of their choosing, and mints the one thing another person needs in order
to be there.

## Why this is not an invitation with a date on it

An invitation is redeemed at the door and lets somebody in. Half the point of
arranging a meeting is that the person arriving early must *not* be let in, so
what the link carries is a way to ask "has it begun", and the invitation is
minted at the moment the answer becomes yes.

That also settles what an early arrival does with their time: everything except
join. They choose a camera, a microphone and a way in, and none of that touches
the room, because there is no room to touch.

## When it begins

When its host walks into the room, inside the window around the time it was
arranged for. Not on a button: a host who is in the room is hosting, and a gate
they had to press would leave everybody outside while they sat inside wondering
why nobody came — which is the fault the waiting room's notice was added for.

The window is the other half of that rule. A host who uses a name every day and
arranges Thursday's meeting on it must not begin Thursday's meeting on Monday,
hand its invitation to people who then arrive into Monday's call, and have that
invitation expire before Thursday comes. So a join begins a meeting only from an
hour before its time until a day after it, and outside that window an arranged
meeting is simply not there to begin.

Which is also why one name holds one pending meeting. A second, later
arrangement on the same name is refused rather than queued: at the door there
would be no telling which meeting a person had come for, and the window rule
would begin whichever one was nearest.

## The name is the host's while the meeting is pending

Between arranging and beginning, nobody but the arranger may open the name. Not
because a room is anything more than a name — it is not — but because the
alternative was worse in both directions. Let anybody open it and an early
guest with an account becomes its host by walking in first, and then either the
meeting cannot begin or the arranger has to take the room from them; taking it
was tried, and it let any account take any room whose name had gone quiet for
three days. Refusing the door to everybody else for the length of the
arrangement is the smaller rule, and the join says what it always says about a
name that is not open: ask the organiser for the link.

Arranging is offered in the lobby, and the lobby exists only where opening a
room asks for an account. A deployment that lets anybody open anything has no
lobby and no arranging, which is consistent: it has no accounts to be a host.

## Who may start one

The host, meaning whoever arranged it, identified the way everybody here is
identified — by the signature their passphrase makes. Not by a session, which
expires, and not by the link, which is the thing everybody else has.

A person who changes their passphrase changes their signature, and with it
loses the arrangements made under the old one; the same is already true of the
rooms they host. Recorded here rather than fixed, because a passphrase change
is rare and an arrangement is short-lived.

## The link is derived, not stored

The token in the link is an HMAC of the meeting's id under the deployment's
tripcode key, and the record is kept against the hash of that token exactly as
an invite is. So a host can be shown the link again from the id alone, and a
copy of the store still holds no link to any meeting. Storing the token in the
clear would have made the store worth a day's entry to every meeting in it,
which is more than the header on the invite field below concedes.
*/

var meetings = []byte("meetings")

/*
How long a meeting outlives its own time.

A day, because the failure this bounds is somebody arranging a meeting, nobody
coming, and the record sitting in the store for as long as the deployment runs.
A day is also longer than any meeting anybody has been late to, so the link a
person opens an hour afterwards still says what it was rather than nothing at
all.

Counted from the later of when it was meant to start and when it did, so a
meeting that ran long is not swept out from under the people in it.
*/
const meetingFor = 24 * time.Hour

/*
BeginsFrom is how early a host may begin one.

An hour, because a host who arrives early to set the room up is the ordinary
case and must not find their own meeting refusing to begin; and not more,
because the bound exists to keep an unrelated call on the same name from
beginning the wrong meeting.
*/
const BeginsFrom = time.Hour

// ErrNoSuchMeeting is what a token nobody arranged answers, and what a room
// with no meeting to begin answers.
var ErrNoSuchMeeting = errors.New("no meeting has been arranged there; check the link, or arrange one")

// ErrNotTheHost is somebody trying to start a meeting they did not arrange.
var ErrNotTheHost = errors.New("only whoever arranged this meeting can begin it")

// ErrRoomArranged is a second meeting arranged on a name that has one pending.
var ErrRoomArranged = errors.New("that room already has a meeting arranged")

// Meeting is one arrangement, kept against the hash of the link's token.
type Meeting struct {
	// ID is the public name for it: safe to hand around, and what the link's
	// token is derived from.
	ID string `json:"id"`

	Room string `json:"room"`

	// At is when it is meant to start, which is a plan rather than a rule.
	At time.Time `json:"at"`

	// Held is where it is to be held, by relay name, or empty for wherever
	// suits.
	//
	// The host's choice of machine, which is a different question from the one
	// each guest answers for themselves. A guest picks the door they dial; this
	// is the room behind it.
	Held string `json:"held,omitempty"`

	// Host is the signature of whoever arranged it. Only they can start it.
	Host string `json:"host"`

	// Started is empty until the host has walked in. omitzero rather than
	// omitempty, which does nothing for a time: an earlier version of this
	// record carried "0001-01-01T00:00:00Z" as its idea of not yet.
	Started time.Time `json:"started,omitzero"`

	// Ended is set when the host closes the meeting, so a link opened
	// afterwards can say so rather than hand out a dead invitation.
	Ended time.Time `json:"ended,omitzero"`

	// Invite is the invitation everybody holding the link is handed once it has
	// begun.
	//
	// One per meeting rather than one per person asking, because the link is
	// one thing sent to everybody and the invitation it turns into can be the
	// same one — invites here are not single-use. Kept in the clear where every
	// other invite is kept as a hash, which is a real trade and is made on
	// purpose: this record is itself reachable only through the hash of a token
	// nobody stores, so reading it means reading the store, and what that buys
	// is a day's entry to meetings that have already begun. Minting a fresh one
	// per poll would keep the hash and fill the store with one invite per three
	// seconds per guest.
	Invite string `json:"invite,omitempty"`

	Made time.Time `json:"made"`
}

// Begun says whether this meeting has started.
func (m Meeting) Begun() bool { return !m.Started.IsZero() }

// Over says whether this meeting is done with, one way or another.
func (m Meeting) Over() bool { return !m.Ended.IsZero() }

// Outstanding says whether a meeting is still to come or still being held:
// neither ended nor so far past its time that nobody can be waiting for it.
// Asked of a link by the download of the apps (internal/app/apps.go), which
// offers the app to somebody waiting on a meeting as much as to somebody in it.
func (m Meeting) Outstanding(now time.Time) bool {
	return !m.Over() && !m.stale(now)
}

// pending is a meeting that could still begin.
func (m Meeting) pending(now time.Time) bool {
	return !m.Begun() && !m.Over() && !m.stale(now)
}

// CanBegin says whether now is inside the window a join may begin this in.
func (m Meeting) CanBegin(now time.Time) bool {
	return m.pending(now) && !now.Before(m.At.Add(-BeginsFrom)) && now.Sub(m.At) <= meetingFor
}

// going is a meeting that has begun and is still being held, as far as this
// store can tell.
func (m Meeting) going(now time.Time) bool {
	return m.Begun() && !m.Over() && !m.stale(now)
}

// stale is a meeting nobody can still be waiting for.
func (m Meeting) stale(now time.Time) bool {
	last := m.At
	if m.Started.After(last) {
		last = m.Started
	}

	return now.Sub(last) > meetingFor
}

// NewMeetingID mints the public name for one.
func NewMeetingID() (string, error) { return NewInviteToken() }

/*
MeetingToken derives the secret in an arranged meeting's link from its id.

Keyed on the tripcode key because that is the one secret a control node already
holds that nothing outside it ever sees, and because the derivation only has to
be unforgeable, not reversible: the id is public and the token must not be
computable from it by anybody but this deployment.
*/
func MeetingToken(key []byte, id string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("meeting\x00" + id))

	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))[:32]
}

/*
Arrange writes a meeting down against its token.

Refuses a name the join would refuse, so that a link is never handed out for a
room nobody can enter; and refuses a second pending meeting on a name, for the
reason given at the top of the file.
*/
func (s *Store) Arrange(token string, meeting Meeting, now time.Time) error {
	meeting.Room = strings.ToLower(strings.TrimSpace(meeting.Room))
	if !room.ValidName(meeting.Room) {
		return errors.New("a meeting needs a room name the door would accept")
	}

	if meeting.Made.IsZero() {
		meeting.Made = now
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(meetings)
		if err != nil {
			return err
		}

		var taken bool

		if err := bucket.ForEach(func(_, raw []byte) error {
			var other Meeting
			if json.Unmarshal(raw, &other) == nil && other.Room == meeting.Room && other.pending(now) {
				taken = true
			}

			return nil
		}); err != nil {
			return err
		}

		if taken {
			return ErrRoomArranged
		}

		encoded, err := json.Marshal(meeting)
		if err != nil {
			return err
		}

		return bucket.Put(held(token), encoded)
	})
}

// Arranged reads the meeting a link's token names.
func (s *Store) Arranged(token string) (Meeting, error) {
	var meeting Meeting

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(meetings)
		if bucket == nil {
			return ErrNoSuchMeeting
		}

		raw := bucket.Get(held(token))
		if raw == nil {
			return ErrNoSuchMeeting
		}

		return json.Unmarshal(raw, &meeting)
	})
	if err != nil {
		return Meeting{}, ErrNoSuchMeeting
	}

	return meeting, nil
}

/*
ArrangedFor is the meeting a room has, if it has one that still matters: the
one pending, or the one that has begun and not yet ended.

For the join, which needs to know whether the person walking in is the host of
something arranged here, and where it was to be held.
*/
func (s *Store) ArrangedFor(name string, now time.Time) (Meeting, bool) {
	name = strings.ToLower(strings.TrimSpace(name))

	var pending, going *Meeting

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(meetings)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var meeting Meeting
			if json.Unmarshal(raw, &meeting) != nil || meeting.Room != name {
				return nil
			}

			// The one still to come wins over the one under way, and the
			// soonest of several to come wins; among several under way — a
			// host who never closed yesterday's — the latest begun. Chosen
			// rather than left to bucket order, which is the hash of a token
			// and so is as good as random: an earlier version answered
			// yesterday's un-closed meeting about half the time, and today's
			// then could not begin.
			switch {
			case meeting.pending(now):
				if pending == nil || meeting.At.Before(pending.At) {
					m := meeting
					pending = &m
				}
			case meeting.going(now):
				if going == nil || meeting.Started.After(going.Started) {
					m := meeting
					going = &m
				}
			}

			return nil
		})
	})

	if pending != nil {
		return *pending, true
	}

	if going != nil {
		return *going, true
	}

	return Meeting{}, false
}

/*
Begin marks the meeting for a room as started, by its host.

Found by walking, because the key is the hash of a token the host does not have
in front of them — they have a room and a signature. There are never many of
these and they are swept, so a walk is cheaper than a second index that can
disagree with the first. The walk only reads; the write comes after it returns,
because a bucket must not be written from inside its own ForEach — bbolt calls
that undefined behaviour, and the rest of this store already goes to the same
trouble to avoid it.

Answers the meeting whether or not this call is what started it: a host whose
browser asks twice, or who rejoins, is not an error and must not read as one.

`invite` is the token to hand out from now on, and is written only by the call
that actually begins the meeting; a later call gets the one already written.
The caller can tell which happened by comparing, and only then stores the
invite proper — this cannot do that itself, because storing an invite is its
own transaction and a transaction inside a transaction is a deadlock in bolt.

A meeting outside its window answers ErrNoSuchMeeting rather than beginning,
which is the rule at the top of the file: a join on Monday is not Thursday's
meeting starting early.
*/
func (s *Store) Begin(name, host, invite string, now time.Time) (Meeting, error) {
	name = strings.ToLower(strings.TrimSpace(name))

	type held struct {
		key     []byte
		meeting Meeting
	}

	var (
		toBegin  *held // pending, inside its window, this host's
		begun    *held // already under way, this host's
		anybody  bool  // something on this name that is live in some sense
		answered Meeting
	)

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(meetings)
		if bucket == nil {
			return ErrNoSuchMeeting
		}

		if err := bucket.ForEach(func(at, raw []byte) error {
			var meeting Meeting
			if json.Unmarshal(raw, &meeting) != nil || meeting.Room != name {
				return nil
			}

			// Only a meeting that is live in some sense: under way, or inside
			// the window in which a join begins it. Anything else on this name
			// is not the meeting this person walked into.
			if !meeting.going(now) && !meeting.CanBegin(now) {
				return nil
			}

			anybody = true

			if meeting.Host != host || host == "" {
				return nil
			}

			one := &held{key: append([]byte(nil), at...), meeting: meeting}

			// The one to begin wins over the one already begun, and the
			// soonest wins among several to begin. A host who never closed
			// yesterday's meeting must still be able to begin today's.
			switch {
			case meeting.CanBegin(now):
				if toBegin == nil || meeting.At.Before(toBegin.meeting.At) {
					toBegin = one
				}
			default:
				if begun == nil || meeting.Started.After(begun.meeting.Started) {
					begun = one
				}
			}

			return nil
		}); err != nil {
			return err
		}

		if !anybody {
			return ErrNoSuchMeeting
		}

		if toBegin == nil && begun == nil {
			return ErrNotTheHost
		}

		if toBegin == nil {
			answered = begun.meeting
			return nil
		}

		answered = toBegin.meeting
		answered.Started = now
		answered.Invite = invite

		encoded, err := json.Marshal(answered)
		if err != nil {
			return err
		}

		return bucket.Put(toBegin.key, encoded)
	})
	if err != nil {
		return Meeting{}, err
	}

	return answered, nil
}

/*
End marks a room's begun meeting as over, so a link opened afterwards is told
so rather than handed the invitation to a room that has been closed.

Nothing to do where the room has no begun meeting, which is most rooms.
*/
func (s *Store) End(name string, now time.Time) error {
	name = strings.ToLower(strings.TrimSpace(name))

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(meetings)
		if bucket == nil {
			return nil
		}

		type held struct {
			key     []byte
			meeting Meeting
		}

		var open []held

		// Every one that is under way, because a name can carry more than one
		// — yesterday's that was never closed and today's — and closing the
		// room closes the room.
		if err := bucket.ForEach(func(at, raw []byte) error {
			var meeting Meeting
			if json.Unmarshal(raw, &meeting) == nil && meeting.Room == name && meeting.Begun() && !meeting.Over() {
				open = append(open, held{key: append([]byte(nil), at...), meeting: meeting})
			}

			return nil
		}); err != nil {
			return err
		}

		for _, one := range open {
			one.meeting.Ended = now

			encoded, err := json.Marshal(one.meeting)
			if err != nil {
				return err
			}

			if err := bucket.Put(one.key, encoded); err != nil {
				return err
			}
		}

		return nil
	})
}

// Arrangements lists what one host has arranged and not yet outlived, soonest
// first.
func (s *Store) Arrangements(host string, now time.Time) []Meeting {
	var all []Meeting

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(meetings)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var meeting Meeting
			if json.Unmarshal(raw, &meeting) != nil {
				return nil
			}

			if meeting.Host == host && host != "" && !meeting.stale(now) {
				all = append(all, meeting)
			}

			return nil
		})
	})

	for i := 1; i < len(all); i++ {
		for j := i; j > 0 && all[j].At.Before(all[j-1].At); j-- {
			all[j], all[j-1] = all[j-1], all[j]
		}
	}

	return all
}

/*
Cancel drops a meeting its host no longer means to hold, and answers what was
dropped so the caller can withdraw the invitation it may have handed out.
*/
func (s *Store) Cancel(id, host string) (Meeting, error) {
	var found Meeting

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(meetings)
		if bucket == nil {
			return ErrNoSuchMeeting
		}

		var key []byte

		if err := bucket.ForEach(func(at, raw []byte) error {
			var meeting Meeting
			if json.Unmarshal(raw, &meeting) == nil && meeting.ID == id && meeting.Host == host && host != "" {
				key = append([]byte(nil), at...)
				found = meeting
			}

			return nil
		}); err != nil {
			return err
		}

		if key == nil {
			return ErrNoSuchMeeting
		}

		return bucket.Delete(key)
	})
	if err != nil {
		return Meeting{}, err
	}

	return found, nil
}

// SweepMeetings drops the ones nobody can still be waiting for.
func (s *Store) SweepMeetings(now time.Time) (gone int, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(meetings)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var meeting Meeting

			// Anything unreadable goes with them: a record this cannot parse is
			// one nothing else can act on either.
			if json.Unmarshal(raw, &meeting) != nil || meeting.stale(now) {
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
