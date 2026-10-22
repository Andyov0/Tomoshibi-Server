package store

import (
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
The YouTube relay's two facts in the store: its switch, and which ledgered
tickets are YouTube's.

The switch fails the way the Emby one does, to off, because "on" spends money
and nobody can see a key that will not read. And the kind is the thing that
decides which question the relay asks of a ticket — a film's grantor, or the
switch — so the two ways it could go wrong silently are both checked: an entry
written before there was a kind must still read as the film it is, and two
writes of the same name under different kinds must not leave the first standing
because the comparison that skips unchanged rows thought nothing had changed.
*/

func TestTheYouTubeRelayIsOffUntilTurnedOn(t *testing.T) {
	st := open(t)

	if st.YouTubeRelay() {
		t.Fatal("a deployment that never touched the switch relays YouTube")
	}

	if err := st.SetYouTubeRelay(true); err != nil {
		t.Fatal(err)
	}

	if !st.YouTubeRelay() {
		t.Fatal("turning the YouTube relay on did not take")
	}

	// Its own key: turning one relay on is not turning on the other.
	if st.EmbyRelay() {
		t.Error("turning the YouTube relay on turned the Emby relay on")
	}

	if err := st.SetYouTubeRelay(false); err != nil {
		t.Fatal(err)
	}

	if st.YouTubeRelay() {
		t.Fatal("turning the YouTube relay off did not take")
	}

	if err := st.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(settings).Put(youtubeRelay, []byte("yes"))
	}); err != nil {
		t.Fatal(err)
	}

	if st.YouTubeRelay() {
		t.Error("a value that is not \"on\" turned the YouTube relay on")
	}
}

func TestALedgeredTicketKeepsItsKind(t *testing.T) {
	st := open(t)
	expires := time.Now().Add(time.Hour).UTC()

	// What an entry looked like before there was a kind, written as that build
	// wrote it.
	if err := st.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(ticketsBucket)
		if err != nil {
			return err
		}

		return bucket.Put(held("an-old-film-ticket-0001"),
			[]byte(`{"name":"ada","trip":"tada","expires":"`+expires.Format(time.RFC3339Nano)+`"}`))
	}); err != nil {
		t.Fatal(err)
	}

	if grant, ok := st.WatchTicket("an-old-film-ticket-0001"); !ok || grant.Kind != "" {
		t.Errorf("an entry written before there was a kind read back as %+v (%v), want a film", grant, ok)
	}

	film := WatchGrant{Name: "ada", Trip: "tada", Expires: expires}
	video := WatchGrant{Name: "ada", Trip: "tada", Expires: expires, Kind: WatchYouTube}

	if err := st.PutWatchTickets([]string{"a-shared-name-000001"}, film); err != nil {
		t.Fatal(err)
	}

	if err := st.PutWatchTickets([]string{"a-shared-name-000001"}, video); err != nil {
		t.Fatal(err)
	}

	if grant, _ := st.WatchTicket("a-shared-name-000001"); grant.Kind != WatchYouTube {
		t.Errorf("a name written again as a YouTube video still reads as %q", grant.Kind)
	}
}
