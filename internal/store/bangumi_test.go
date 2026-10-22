package store

import (
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
The bangumi relay's switch, and the mark of a bangumi episode in the ledger.

Unlike the other two switches this one starts on: the owner chose to relay
every bangumi episode (2026-10-14), and a deployment that never touched the
switch is one that has made no other choice. So the failure that would go
unseen here is the opposite of theirs — a switch that reads off until somebody
turns it on, and every series played at 360p with its members' episodes
refused, with nothing on any page saying why. Beside that, it still has to turn
off and stay off, and a value nobody wrote must not read as on; and its mark
must be told apart from a YouTube video's, since the two are relayed on
different switches.
*/

func TestTheBangumiRelayIsOnUntilTurnedOff(t *testing.T) {
	st := open(t)

	if !st.BangumiRelay() {
		t.Fatal("a deployment that never touched the switch does not relay bangumi")
	}

	// Its own key: the others start off and stay off.
	if st.YouTubeRelay() || st.EmbyRelay() {
		t.Error("the bangumi switch starting on turned another relay on")
	}

	if err := st.SetBangumiRelay(false); err != nil {
		t.Fatal(err)
	}

	if st.BangumiRelay() {
		t.Fatal("turning the bangumi relay off did not take")
	}

	// Off is remembered across the store being opened again: the default is
	// for a key that is not there, not for one that says off.
	path := st.db.Path()
	if err := st.db.Close(); err != nil {
		t.Fatal(err)
	}

	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = again.Close() })

	if again.BangumiRelay() {
		t.Fatal("the bangumi relay came back on after the store was opened again")
	}

	if err := again.SetBangumiRelay(true); err != nil {
		t.Fatal(err)
	}

	if !again.BangumiRelay() {
		t.Fatal("turning the bangumi relay back on did not take")
	}

	if again.YouTubeRelay() {
		t.Error("turning the bangumi relay on turned the YouTube relay on")
	}

	if err := again.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(settings).Put(bangumiRelay, []byte("yes"))
	}); err != nil {
		t.Fatal(err)
	}

	if again.BangumiRelay() {
		t.Error("a value that is neither \"on\" nor absent turned the bangumi relay on")
	}
}

func TestABangumiEpisodeKeepsItsOwnMark(t *testing.T) {
	st := open(t)
	expires := time.Now().Add(time.Hour).UTC()

	video := WatchGrant{Name: "ada", Trip: "tada", Expires: expires, Kind: WatchYouTube}
	episode := WatchGrant{Name: "ada", Trip: "tada", Expires: expires, Kind: WatchBangumi}

	if err := st.PutWatchTickets([]string{"a-shared-name-000002"}, video); err != nil {
		t.Fatal(err)
	}

	if err := st.PutWatchTickets([]string{"a-shared-name-000002"}, episode); err != nil {
		t.Fatal(err)
	}

	if grant, _ := st.WatchTicket("a-shared-name-000002"); grant.Kind != WatchBangumi {
		t.Errorf("a name written again as a bangumi episode still reads as %q", grant.Kind)
	}
}
