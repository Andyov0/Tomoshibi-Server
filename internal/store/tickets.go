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
Which watch tickets this deployment agreed to relay, and on whose say-so.

A ticket is the gateway's name for one resolved video: whoever holds it can ask
for the video's description and, where relaying is allowed, its bytes. Under a
deployment that relays nothing, nothing is relayed for any ticket — except the
films somebody granted the Emby permission chose, which this deployment has
agreed to pay for. The ledger is how the server tells those tickets apart from
every other ticket the gateway ever minted, because a ticket itself says nothing
about who asked for it, and everybody in the room, guests included, plays the
film by it.

Kept in the store rather than in memory for the reason a session is. A viewer's
page remembers what each ticket answered for as long as the page is open, so a
ledger lost on a restart would turn every film being watched into one that
"cannot be played here" until everybody reloaded — and they would have no way of
knowing that reloading was the cure.

Each entry names its grantor, so that the server can ask again, as the film
plays, whether that person still holds the grant. Taking somebody's Emby away is
meant to stop what they started, not only what they would start next.

A YouTube video is another thing such a deployment may agree to relay, where
its switch says so, and its ticket is kept here too, marked as one. It answers
to no grant — only to the switch — and the person who resolved it is written
beside it only so that what it costs is counted against somebody. Bilibili's
bangumi — the series and films it licenses — are the third, kept the same way
under a mark of their own and a switch of their own.

The key is the ticket's hash, as a session's is: a copy of this file should not
be a list of working links.
*/

var ticketsBucket = []byte("watch.tickets")

// WatchYouTube marks a ledgered ticket as a YouTube video's; see WatchGrant.Kind.
const WatchYouTube = "youtube"

// WatchBangumi marks a ledgered ticket as a Bilibili bangumi episode's; see
// WatchGrant.Kind.
const WatchBangumi = "bangumi"

// WatchGrant is who a ticket was resolved for, and until when it is honoured.
type WatchGrant struct {
	// Name and Trip are the grantor's: the account, or the administrator, whose
	// Emby permission the ticket was minted under. Trip is what is asked again;
	// Name is for whoever reads the page or the log. For a YouTube video or a
	// bangumi episode they are whoever resolved it, and nothing is asked of
	// them.
	Name string `json:"name"`
	Trip string `json:"trip"`

	// Kind is what was ledgered: empty for a media server's film, which is
	// what every entry was before there was anything else, WatchYouTube for a
	// YouTube video, and WatchBangumi for a Bilibili bangumi episode. Empty
	// rather than a word for the film so that every entry already written
	// still reads as the film it is, and so that a film's playlist names,
	// compared byte for byte in PutWatchTickets, are written exactly as they
	// were.
	//
	// What it decides is which question the relay asks. A film is relayed
	// while its grantor holds Emby; a video while the YouTube switch is on; an
	// episode while the bangumi switch is. An entry read as the wrong kind
	// would be relayed on another's terms — a film on nobody's grant — so the
	// relay asks by this and by nothing else.
	Kind string `json:"kind,omitempty"`

	// Expires is when the ticket stops being relayed, whatever the gateway
	// thinks of it.
	Expires time.Time `json:"expires"`
}

// ErrNoTicket refuses an entry that would be a standing grant: one with no
// ticket, nobody behind it, or no end.
var ErrNoTicket = errors.New("a watch ticket needs a name, a grantor and an expiry")

// PutWatchTicket records that a ticket may be relayed on somebody's behalf,
// replacing whatever was recorded for it.
func (s *Store) PutWatchTicket(ticket string, grant WatchGrant) error {
	if strings.TrimSpace(ticket) == "" || strings.TrimSpace(grant.Trip) == "" || grant.Expires.IsZero() {
		return ErrNoTicket
	}

	encoded, err := json.Marshal(grant)
	if err != nil {
		return err
	}

	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(ticketsBucket)
		if err != nil {
			return err
		}

		return bucket.Put(held(ticket), encoded)
	})

	if err != nil {
		return fmt.Errorf("record a watch ticket: %w", err)
	}

	return nil
}

// PutWatchTickets records several tickets under one grant, in one transaction.
//
// For the names a relayed playlist lists — every segment of a film, a thousand
// or more — which are recorded under the film's own grant so that each segment
// is asked about its grantor as the film's ticket is. One transaction per name
// was the obvious way and is a disk flush per segment, seconds of them, on the
// request the player is waiting on before it can fetch the first.
//
// Names already recorded under this same grant are not written again. Every
// viewer's player reads the same playlists, and a write that changes nothing
// is still a flush.
func (s *Store) PutWatchTickets(tickets []string, grant WatchGrant) error {
	if strings.TrimSpace(grant.Trip) == "" || grant.Expires.IsZero() {
		return ErrNoTicket
	}

	encoded, err := json.Marshal(grant)
	if err != nil {
		return err
	}

	var missing [][]byte

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(ticketsBucket)

		for _, ticket := range tickets {
			if strings.TrimSpace(ticket) == "" {
				continue
			}

			key := held(ticket)
			if bucket == nil || string(bucket.Get(key)) != string(encoded) {
				missing = append(missing, key)
			}
		}

		return nil
	})

	if len(missing) == 0 {
		return nil
	}

	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(ticketsBucket)
		if err != nil {
			return err
		}

		for _, key := range missing {
			if err := bucket.Put(key, encoded); err != nil {
				return err
			}
		}

		return nil
	})

	if err != nil {
		return fmt.Errorf("record the watch tickets a playlist names: %w", err)
	}

	return nil
}

// WatchTicket reads back who a ticket was granted to, or says it was not.
//
// One past its expiry is not there, whether or not it has been swept: the sweep
// is housekeeping, and a gate that depended on it would open for as long as the
// timer happened to be late. A store that will not answer says not there as
// well, which relays nothing — the safe direction for something that costs money.
func (s *Store) WatchTicket(ticket string) (WatchGrant, bool) {
	var grant WatchGrant
	found := false

	if strings.TrimSpace(ticket) == "" {
		return grant, false
	}

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(ticketsBucket)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get(held(ticket))
		if raw == nil {
			return nil
		}

		if err := json.Unmarshal(raw, &grant); err == nil {
			found = true
		}

		return nil
	})

	if !found || !time.Now().Before(grant.Expires) {
		return WatchGrant{}, false
	}

	return grant, true
}

// SweepWatchTickets removes the ones that have run out.
//
// On the timer that sweeps the sessions, and for the same reason: an expired
// ticket is already refused by whoever reads it, so this only stops the bucket
// growing by one row per film for ever.
func (s *Store) SweepWatchTickets(now time.Time) (gone int, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(ticketsBucket)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var grant WatchGrant
			if err := json.Unmarshal(raw, &grant); err != nil || !now.Before(grant.Expires) {
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

	if err != nil {
		return 0, fmt.Errorf("sweep the watch tickets: %w", err)
	}

	return gone, nil
}
