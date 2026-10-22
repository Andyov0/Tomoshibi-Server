package store

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
A link that lets one person into one room, once, without a passphrase.

The two ways in here are otherwise both about knowing something: a passphrase, or
a name nobody has told anybody else. Neither suits somebody being invited to one
meeting — handing over a passphrase gives them the account, and handing over the
room name gives them every future meeting held under it, because a room here is a
name and nothing else.

So an invite is a third thing, and its whole value is in what it does not carry.
It names one room, it stops working, and it proves nothing about who redeems it:
whoever arrives gets an issued mark, which says only that they are not the other
people in the call. It is not a credential and it is not an identity, which is
exactly right for somebody who was sent a link.

It lasts as long as the meeting does, and that is the only limit worth having.
It was single use to begin with, on the reasoning that a link pasted into a group
chat should let in the person it was meant for and nobody else. That is a fine
rule for a link and a bad one for a meeting: the person it was meant for reloads,
their phone sleeps, they are asked to bring a colleague, and each of those is the
link failing at the only thing it is for. Worse, a host with six guests had to
mint six links and keep track of which had been spent.

So the meeting is the boundary. While the room is running the link works, for
whoever has it; when the room ends the link is worth nothing, and closing the room
throws the links away outright. What that gives away is that anybody the link
reaches during the meeting can join it — which is what a meeting link means
everywhere else, and what somebody pasting one into a group chat is doing on
purpose.

The ceiling below is a backstop, not the rule. It exists because "while the room
is running" is answered by asking the media server, and a link should not
outlive that conversation being possible.

A room held under a scope may also have standing invitations, which are the
exception to all of that. A member makes one on their own page rather than from
inside a meeting, for a time they choose or for good — a client's call next
Tuesday, a supplier's every week — and ending one meeting does not throw it away,
because the person who made Tuesday's link may not be in Monday's call at all.
It carries a name to be worn and a time to begin.

A link made from inside a scoped room's call is the ordinary kind and goes with
the meeting, exactly as a plain room's does. The panel in a call is where a host
shares the meeting they are in; a press there that made a link outliving it
would be a key handed out by somebody who meant to share one call.
*/

var invites = []byte("invites")

// What an invite can be wrong in, from the point of view of somebody holding one.
//
// Three answers rather than one, because they are three different sentences to
// the person reading them and only one of them means "ask for another link".
var (
	ErrNoSuchInvite  = errors.New("no invite by that token is here")
	ErrInviteExpired = errors.New("that invite has run out")
	// ErrInviteNotYet is a link used before the time it was made for. Its own
	// answer rather than "no such invite", because the person holding it has
	// the right link and only needs to come back later.
	ErrInviteNotYet = errors.New("that invite does not open yet")
)

// Invite is a one-off way into one room.
type Invite struct {
	// Room is the only room it opens. Checked on redemption rather than trusted
	// from the request, or a token for one meeting would open any of them.
	Room string `json:"room"`
	// By is the signature of whoever made it, for a log and for a page that
	// wants to say who invited whom.
	By string `json:"by,omitempty"`
	// Created and Expires bound it in time.
	//
	// Expires may be zero, which is a link that lasts until somebody revokes
	// it. Only a standing invitation is given one: it is made on purpose by a
	// member, outside any meeting, for people who will use it again — a
	// client's weekly call — and a ceiling there would be a link that stops
	// working on a schedule nobody chose.
	Created time.Time `json:"created"`
	Expires time.Time `json:"expires"`
	// Standing is a link into a scoped room made to outlast the meeting, which
	// ending the meeting therefore leaves alone. Only a revocation takes it.
	Standing bool `json:"standing,omitempty"`
	// From is when it begins to work, or zero for at once. Checked when it is
	// used and at no other time: somebody already in the call is not put out
	// when the window closes, and nothing here tries to.
	From time.Time `json:"from,omitempty"`
	// Name is what whoever comes through it is called, where the person who
	// made it said. Signed into the token instead of whatever the guest typed,
	// so a link made for one person is worn under that person's name.
	Name string `json:"name,omitempty"`
	// Spent is how many have come through. Written on every redemption and read
	// by nothing yet: it is what a page showing a host their outstanding links
	// would put beside each one, and it is kept because the count cannot be
	// recovered later if it stops being taken.
	//
	// Counted rather than limited. It says how far a link travelled, which is
	// worth seeing on a page and is not a thing anything decides on.
	Spent int `json:"spent,omitempty"`
}

// Live reports whether an invite is still within its ceiling.
//
// Not the whole question. Whether the meeting is still running is asked of the
// media server, which is the only thing that knows, and this is the backstop
// underneath it.
func (i Invite) Live(now time.Time) bool {
	return i.Expires.IsZero() || now.Before(i.Expires)
}

// Begun reports whether an invite has reached the time it was made for.
func (i Invite) Begun(now time.Time) bool {
	return i.From.IsZero() || !now.Before(i.From)
}

// NewInviteToken draws one nobody can guess.
//
// Long, and from crypto/rand, because this is the whole of the check: an invite
// carries no second factor and names no person, so a token somebody could
// enumerate would be a room anybody could walk into.
func NewInviteToken() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// KeepInvite writes one down.
func (s *Store) KeepInvite(token string, invite Invite) error {
	encoded, err := json.Marshal(invite)
	if err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(invites)
		if err != nil {
			return err
		}

		return bucket.Put(held(token), encoded)
	})
}

// Invite reads one back without spending it.
//
// For the page somebody lands on, which has to say which room they were invited
// to before they have typed a name — and must not consume the invite for having
// been looked at, or a preview would burn the link.
func (s *Store) Invite(token string) (Invite, bool) {
	var invite Invite
	found := false

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get(held(token))
		if raw == nil {
			return nil
		}

		if err := json.Unmarshal(raw, &invite); err == nil {
			found = true
		}

		return nil
	})

	return invite, found
}

// Redeem records somebody coming through an invite, or says why they may not.
func (s *Store) Redeem(token, room string, now time.Time) (Invite, error) {
	var invite Invite

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return ErrNoSuchInvite
		}

		raw := bucket.Get(held(token))
		if raw == nil {
			return ErrNoSuchInvite
		}

		if err := json.Unmarshal(raw, &invite); err != nil {
			return ErrNoSuchInvite
		}

		// The room the invite names, never the room that was asked for. Without
		// this a token for one meeting would open any of them, which is the
		// difference between an invitation and a key.
		if invite.Room != room {
			return ErrNoSuchInvite
		}

		if !invite.Live(now) {
			return ErrInviteExpired
		}

		if !invite.Begun(now) {
			return ErrInviteNotYet
		}

		invite.Spent++

		encoded, err := json.Marshal(invite)
		if err != nil {
			return err
		}

		return bucket.Put(held(token), encoded)
	})

	return invite, err
}

// Invites lists the live ones for a room, with their tokens.
//
// The token is returned because whoever made an invite has to be able to copy
// the link again, and it is not recoverable any other way — what is stored is
// its hash. So this is only ever answered to somebody who may already read the
// room, and it returns nothing for a room that has none.
func (s *Store) Invites(room string, now time.Time) []Invite {
	var live []Invite

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var invite Invite
			if err := json.Unmarshal(raw, &invite); err != nil {
				return nil
			}

			if invite.Room == room && invite.Live(now) {
				live = append(live, invite)
			}

			return nil
		})
	})

	return live
}

// DropInvites throws away every invite to a room.
//
// Called when a room is closed, which is the moment its links stop meaning
// anything. Left in place they would be a way back into a name the host
// deliberately ended — and because a room here is a name, the next meeting held
// under it would inherit them.
//
// Except a standing invitation, unless standing says to take those too. Those
// were made for other days and other people and are not the meeting's to end;
// a revocation is somebody asking for every link to stop, and takes them.
func (s *Store) DropInvites(room string, standing bool) (gone int, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return nil
		}

		var theirs [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var invite Invite
			if err := json.Unmarshal(raw, &invite); err == nil && invite.Room == room && (standing || !invite.Standing) {
				theirs = append(theirs, append([]byte(nil), key...))
			}

			return nil
		}); err != nil {
			return err
		}

		for _, key := range theirs {
			if err := bucket.Delete(key); err != nil {
				return err
			}
		}

		gone = len(theirs)

		return nil
	})

	return gone, err
}

// SweepInvites removes the ones nobody can use.
func (s *Store) SweepInvites(now time.Time) (gone int, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			// Live, not a comparison against Expires: one that never expires
			// has a zero there, which every instant is after, so comparing
			// against it would sweep every lasting link on the first hourly pass.
			var invite Invite
			if err := json.Unmarshal(raw, &invite); err != nil || !invite.Live(now) {
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

/*
DropInvite withdraws one invitation by its token.

DropInvites takes every invitation to a room, which is right for a room being
closed and wrong for a meeting being cancelled: the host may have made others
on purpose, and cancelling one arrangement is not closing the room.
*/
func (s *Store) DropInvite(token string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return nil
		}

		return bucket.Delete(held(token))
	})
}
