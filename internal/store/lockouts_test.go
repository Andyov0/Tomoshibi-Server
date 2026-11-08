package store

import (
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
The sign-in lockouts as the store keeps them.

A lockout past its end is ignored by everything that reads one, so a store that
never cleared them would look right on every page and grow by a row for every
caller ever shut out. What these guard is the clearing, at both places it is
promised: the read a starting process makes, and the hourly sweep. Each is
asserted against the bucket itself, because asserting it through the other one
passes for a store that clears in neither — the sweep after a read that cleared
nothing finds nothing to clear only if it clears nothing either.
*/

// rows is how many lockouts the bucket holds, live or not.
func rows(t *testing.T, st *Store) int {
	t.Helper()

	held := 0
	if err := st.db.View(func(tx *bolt.Tx) error {
		if bucket := tx.Bucket(lockouts); bucket != nil {
			held = bucket.Stats().KeyN
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	return held
}

// keepBoth keeps one lockout that ended a minute ago and one that ends in
// twenty-nine.
func keepBoth(t *testing.T, st *Store, now time.Time) {
	t.Helper()

	for _, one := range []Lockout{
		{Key: "ended", Address: "192.0.2.1", Since: now.Add(-31 * time.Minute), Until: now.Add(-time.Minute)},
		{Key: "live", Address: "192.0.2.2", Since: now.Add(-time.Minute), Until: now.Add(29 * time.Minute)},
	} {
		if err := st.KeepLockout(one); err != nil {
			t.Fatalf("KeepLockout: %v", err)
		}
	}

	if got := rows(t, st); got != 2 {
		t.Fatalf("the bucket holds %d, want the 2 just kept", got)
	}
}

func TestReadingTheLockoutsClearsTheOnesThatEnded(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()
	keepBoth(t, st, now)

	held, err := st.Lockouts(now)
	if err != nil {
		t.Fatalf("Lockouts: %v", err)
	}
	if len(held) != 1 || held[0].Key != "live" {
		t.Errorf("read back %+v, want the one still in force", held)
	}

	if got := rows(t, st); got != 1 {
		t.Errorf("the bucket holds %d after the read, want 1: the one that ended was left", got)
	}
}

func TestTheSweepClearsTheLockoutsThatEnded(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()
	keepBoth(t, st, now)

	gone, err := st.SweepLockouts(now)
	if err != nil || gone != 1 {
		t.Errorf("SweepLockouts: %d, %v; want the 1 that ended", gone, err)
	}

	if got := rows(t, st); got != 1 {
		t.Errorf("the bucket holds %d after the sweep, want 1", got)
	}

	// And at the end of the other, nothing is left.
	if gone, err := st.SweepLockouts(now.Add(30 * time.Minute)); err != nil || gone != 1 || rows(t, st) != 0 {
		t.Errorf("SweepLockouts after the last ended: %d, %v, %d left", gone, err, rows(t, st))
	}
}

// A lift is a row gone, and lifting what is not there says so rather than
// failing.
func TestLiftingALockoutRemovesItsRow(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()
	keepBoth(t, st, now)

	if found, err := st.LiftLockout("live"); err != nil || !found {
		t.Fatalf("LiftLockout: %v, %v", found, err)
	}
	if found, err := st.LiftLockout("live"); err != nil || found {
		t.Errorf("lifting it again: %v, %v; want nothing found", found, err)
	}

	if held, _ := st.Lockouts(now); len(held) != 0 {
		t.Errorf("read back %+v after the lift", held)
	}
}
