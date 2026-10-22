package store

import (
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
A copy of the database must not be a set of working cookies.

Sessions are written down so that restarting the process does not sign everybody
out, and the moment they are written down the file becomes worth stealing — it
would hold, verbatim, the value of every administrator's cookie. What is stored
is the token's hash instead: an attacker who reads the file holds the hash of a
cookie somebody else has, which is worth nothing without the cookie.

It is asserted by looking for the token in the file, because that is the failure:
not that the hashing is wrong, but that somebody later finds it easier to store
the token and nothing anywhere says why not to.
*/

func TestASessionTokenIsNotStoredAsItself(t *testing.T) {
	st := open(t)

	const token = "a-token-somebodys-browser-is-holding"

	if err := st.KeepSession(token, Session{
		Trip: "4qu3mryghn", Name: "andy",
		Opened:  time.Now().UTC(),
		Expires: time.Now().Add(time.Hour).UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	// Read back by token, which must work.
	if _, ok := st.Session(token); !ok {
		t.Fatal("a session written down could not be read back")
	}

	// And not findable by scanning the file for the token itself.
	found := false
	if err := st.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(sessionsBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(key, _ []byte) error {
			if string(key) == token {
				found = true
			}

			return nil
		})
	}); err != nil {
		t.Fatal(err)
	}

	if found {
		t.Error("the token was stored as itself; whoever reads this file holds " +
			"everybody's cookie")
	}
}

func TestAnExpiredSessionIsSweptAway(t *testing.T) {
	st := open(t)

	past := time.Now().Add(-time.Hour).UTC()
	future := time.Now().Add(time.Hour).UTC()

	_ = st.KeepSession("stale", Session{Trip: "a", Opened: past, Expires: past})
	_ = st.KeepSession("live", Session{Trip: "b", Opened: past, Expires: future})

	gone, err := st.SweepSessions(time.Now())
	if err != nil {
		t.Fatal(err)
	}

	if gone != 1 {
		t.Errorf("swept %d sessions, wanted 1", gone)
	}

	if _, ok := st.Session("live"); !ok {
		t.Error("a session that had not run out was swept away")
	}
}
