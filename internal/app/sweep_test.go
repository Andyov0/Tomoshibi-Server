package app

import (
	"path/filepath"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
What these guard is housekeeping that is switched off by a setting about
something else.

The hourly timer began as the thing that ages out room names, so it was started
only where a retention for room names had been set. Three other records were
later swept on the same timer — the sessions, the arrivals, and now six months
of trend — and none of them has anything to do with how long a name is kept. A
deployment that chose to keep its names for ever, which is an offered setting
and a reasonable one, therefore swept nothing at all, and the only symptom is a
file that grows for months.

Its mirror image is worse and is the reason the guard cannot simply move to the
caller. The cutoff is now minus the retention, so a retention of zero is a
cutoff of this instant, and a sweep that ran under it would take every name the
deployment has ever seen — turning "keep them for ever" into "keep none of
them" by arithmetic, in a single pass, with no error anywhere.

These start the real application rather than calling the sweep, because what is
being tested is whether the timer runs at all.
*/

// eventually waits for something a goroutine does, rather than sleeping for as
// long as it might take.
func eventually(t *testing.T, within time.Duration, done func() bool) bool {
	t.Helper()

	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if done() {
			return true
		}

		time.Sleep(5 * time.Millisecond)
	}

	return done()
}

func keeping(t *testing.T, remember time.Duration) (*App, *store.Store) {
	t.Helper()

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			TokenTTL:  5 * time.Minute,
			JoinRate:  1000,
			JoinBurst: 1000,
			Admins:    []config.Admin{{Trip: room.Trip(tripKey, passphrase), Name: "adam"}},
			SourceURL: source,
			Rooms:     config.Rooms{OpenedBy: room.ByAnyone, Remember: remember},
		},
	}

	// No media server and no client: a control node is assembled exactly this
	// way, and neither is any part of what the timer does.
	//
	// Watching after New, which is also how a control node does it. It used to
	// be started inside New, where it raced the fields UseCluster assigns — so
	// the sampler could read three of them while another goroutine wrote them.
	// This line is the ordering, and this test is what says the ordering still
	// leaves the sampling switched on.
	app := New(conf, st, nil, nil, tripKey)
	t.Cleanup(app.Close)
	app.Watching()

	return app, st
}

func TestHousekeepingRunsWhereNamesAreKeptForEver(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meet.db")

	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	// One session that ran out an hour ago, which is what a sweep is for.
	if err := st.KeepSession("a-spent-token", store.Session{
		Trip:    room.Trip(tripKey, passphrase),
		Opened:  time.Now().Add(-2 * time.Hour).UTC(),
		Expires: time.Now().Add(-time.Hour).UTC(),
	}); err != nil {
		t.Fatalf("KeepSession: %v", err)
	}

	// And one name, which under a retention of zero must still be there
	// afterwards.
	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			TokenTTL:  5 * time.Minute,
			JoinRate:  1000,
			JoinBurst: 1000,
			Admins:    []config.Admin{{Trip: room.Trip(tripKey, passphrase), Name: "adam"}},
			SourceURL: source,
			// For ever, which is what this is about.
			Rooms: config.Rooms{OpenedBy: room.ByAnyone, Remember: 0},
		},
	}

	app := New(conf, st, nil, nil, tripKey)
	t.Cleanup(app.Close)

	if !eventually(t, 2*time.Second, func() bool {
		_, held := st.Session("a-spent-token")
		return !held
	}) {
		t.Error("an expired session was still there, so nothing was swept at all")
	}

	rooms, err := st.Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}

	if len(rooms) != 1 {
		t.Errorf("%d names are left, want the one that was opened: a retention of for ever "+
			"was read as a cutoff of this instant", len(rooms))
	}
}

/*
The load is written down without anybody asking for it.

The sampler and the store are joined in [admin.New], and a deployment where they
are not joined is indistinguishable from one that is until it restarts. Started
here the way a deployment starts it, because the guard against handing the
history a nil store is in that constructor and nowhere else — and a nil store
inside a non-nil interface is a nil dereference on a timer, five seconds after
the process comes up, which is a crash detached from anything anybody did.
*/
func TestTheLoadIsWrittenDownWithoutAnybodyAsking(t *testing.T) {
	_, st := keeping(t, 30*24*time.Hour)

	if !eventually(t, 2*time.Second, func() bool {
		points, _, err := st.Trend(time.Now().Add(-time.Minute).UTC(), time.Now().UTC())
		return err == nil && len(points) > 0
	}) {
		t.Error("the server ran for two seconds and wrote down nothing about its load")
	}
}
