package store

import (
	"encoding/json"
	"math"
	"path/filepath"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
What these guard is a chart that draws perfectly and says something false.

Every fault in this file is silent by construction. A bucket that sums a gauge
instead of averaging it draws a room count climbing all evening. A fold that
averages the averages is wrong only when two buckets hold different numbers of
readings, which is exactly what happens either side of a restart. A peak taken
as a mean flattens the one spike somebody opened the page to find. None of these
throw, none of them fail a type check, and all of them produce a chart that
looks entirely reasonable to whoever is reading it.

So the assertions here are about arithmetic rather than about shape: a known set
of readings has one correct mean, one correct peak, and one correct count at
every resolution, and the fold has to produce them however many levels it passes
through on the way.

The ages are chosen deliberately. Which resolution answers a range is decided by
how far back the range begins, so a test that wants to see the minute buckets
writes its readings three hours ago, where the ten-second buckets have already
aged out of the question.
*/

// trendAt opens a store and hands back a fixed path, so a test can close it and
// open it again to prove that six months of history survives a restart.
func trendAt(t *testing.T) (*Store, string) {
	t.Helper()

	path := filepath.Join(t.TempDir(), "meet.db")

	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	return st, path
}

// bucketAt reads one bucket at one resolution straight out of the file, for the
// assertions that are about what was written rather than about what is served.
func bucketAt(t *testing.T, st *Store, name []byte, at time.Time) (interval, bool) {
	t.Helper()

	var held interval
	found := false

	if err := st.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(name)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get(stamp(at))
		if raw == nil {
			return nil
		}

		found = true

		return json.Unmarshal(raw, &held)
	}); err != nil {
		t.Fatalf("read %s: %v", name, err)
	}

	return held, found
}

// keysIn counts what a resolution is holding.
func keysIn(t *testing.T, st *Store, name []byte) int {
	t.Helper()

	count := 0

	if err := st.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(name)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func([]byte, []byte) error {
			count++
			return nil
		})
	}); err != nil {
		t.Fatalf("count %s: %v", name, err)
	}

	return count
}

func near(got, want float64) bool {
	return math.Abs(got-want) < 1e-6
}

/*
A rate is averaged and a gauge is not added up.

The reading that matters is the third one: three rooms held for the whole minute
are three rooms, not thirty-six. Summing a gauge is the single easiest mistake
to make here — the sums are right there in the record, and dividing is a
separate decision — and its result is a management page reporting a server
carrying hundreds of meetings it has never held.
*/
func TestABucketAveragesRatesAndGauges(t *testing.T) {
	st, _ := trendAt(t)

	// Three hours back, so the minute buckets are what answers.
	base := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Minute)

	for i := range 12 {
		out := 100.0
		if i == 7 {
			// One burst, which is the thing a mean is capable of hiding.
			out = 1300
		}

		if err := st.Record(Reading{
			At: base.Add(time.Duration(i) * 5 * time.Second),
			In: 10, Out: out, Rooms: 3, Clients: 9, Nack: 2,
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}

	points, step, err := st.Trend(base, base.Add(time.Minute))
	if err != nil {
		t.Fatalf("Trend: %v", err)
	}

	if step != time.Minute {
		t.Fatalf("step = %s, want 1m", step)
	}

	if len(points) != 1 {
		t.Fatalf("got %d points, want the one minute they were all recorded in", len(points))
	}

	one := points[0]

	// Eleven readings at 100 and one at 1300.
	if !near(one.Out, 200) {
		t.Errorf("out = %v, want the mean of the readings, 200", one.Out)
	}

	if !near(one.OutPeak, 1300) {
		t.Errorf("out peak = %v, want the highest reading, 1300", one.OutPeak)
	}

	if !near(one.Rooms, 3) || !near(one.Clients, 9) {
		t.Errorf("rooms = %v and clients = %v, want the 3 and 9 that were held throughout "+
			"rather than a total of them", one.Rooms, one.Clients)
	}

	if !near(one.Nack, 2) || !near(one.NackPeak, 2) {
		t.Errorf("nack = %v peaking at %v, want 2 both ways", one.Nack, one.NackPeak)
	}

	if one.Readings != 12 {
		t.Errorf("readings = %d, want 12", one.Readings)
	}

	if !one.At.Equal(base) {
		t.Errorf("at = %s, want the moment the bucket opened, %s", one.At, base)
	}
}

/*
The fold is exact all the way up.

Six hours of readings pass through four folds before they reach the coarsest
resolution, and the coarsest bucket has to hold the mean of all of them and the
highest one — not the mean of the means, which is a different number the moment
two buckets hold different counts, and not the mean of the peaks, which is a
number with no meaning at all.

The readings deliberately do not divide evenly into the buckets below: the
cadence is five minutes, so some quarter-hours hold three readings and the hour
holds twelve, which is the uneven case an average of averages gets wrong.
*/
func TestFoldingKeepsTheMeanAndThePeakThroughEveryResolution(t *testing.T) {
	st, _ := trendAt(t)

	// A hundred days back, where only the six-hour buckets are still kept.
	base := time.Now().UTC().Add(-100 * 24 * time.Hour).Truncate(6 * time.Hour)

	const cadence = 5 * time.Minute
	count := int(6 * time.Hour / cadence)

	total, highest := 0.0, 0.0

	for i := range count {
		// A ramp with one spike in it, so the mean and the peak are different
		// numbers and neither is the last reading.
		out := float64(10 + i)
		if i == 40 {
			out = 5000
		}

		total += out
		highest = max(highest, out)

		if err := st.Record(Reading{
			At: base.Add(time.Duration(i) * cadence),
			In: out / 2, Out: out, Rooms: 2, Clients: 4, Nack: 1,
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}

	points, step, err := st.Trend(base, base.Add(6*time.Hour))
	if err != nil {
		t.Fatalf("Trend: %v", err)
	}

	if step != 6*time.Hour {
		t.Fatalf("step = %s, want 6h", step)
	}

	if len(points) != 1 {
		t.Fatalf("got %d points, want the one six-hour bucket", len(points))
	}

	one := points[0]

	if want := total / float64(count); !near(one.Out, want) {
		t.Errorf("out = %v, want the mean of every reading, %v", one.Out, want)
	}

	if !near(one.OutPeak, highest) {
		t.Errorf("out peak = %v, want the highest single reading, %v", one.OutPeak, highest)
	}

	if !near(one.In, total/float64(count)/2) {
		t.Errorf("in = %v, want the mean of the readings in", one.In)
	}

	if int(one.Readings) != count {
		t.Errorf("readings = %d, want %d", one.Readings, count)
	}

	// A gauge held steady through four folds is still itself.
	if !near(one.Rooms, 2) || !near(one.Clients, 4) {
		t.Errorf("rooms = %v and clients = %v, want 2 and 4", one.Rooms, one.Clients)
	}
}

/*
A coarse bucket is recomputed rather than added to.

The distinction is invisible until a second reading lands in a bucket that has
already been folded once, which is every reading after the first. Folding by
adding the new fine bucket to the coarse one that is already there counts
everything before it again: two readings become three, three become six, and the
chart climbs for no reason anybody can see.
*/
func TestASecondReadingDoesNotCountTheFirstTwice(t *testing.T) {
	st, _ := trendAt(t)

	base := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Minute)

	for i := range 2 {
		if err := st.Record(Reading{
			At: base.Add(time.Duration(i) * 30 * time.Second), Out: 100, Rooms: 1,
		}); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}

	minute, found := bucketAt(t, st, resolutions[1].name, base)
	if !found {
		t.Fatal("no minute bucket was written")
	}

	if minute.N != 2 {
		t.Errorf("the minute holds %d readings, want 2: the fold added to what was already "+
			"there instead of recomputing it", minute.N)
	}

	if !near(minute.Out, 200) {
		t.Errorf("summed out = %v, want 200", minute.Out)
	}
}

/*
Six months of history survives the thing it exists to survive.

The whole reason this moved out of memory is that the buffer it replaced started
empty on every restart, and an afternoon of deployments is several restarts. A
store that held the readings only until the process ended would be the same
thing with more machinery.
*/
func TestTheTrendOutlivesTheProcess(t *testing.T) {
	st, path := trendAt(t)

	at := time.Now().UTC().Add(-20 * 24 * time.Hour).Truncate(time.Hour)

	if err := st.Record(Reading{At: at, In: 40, Out: 80, Rooms: 1, Clients: 2}); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	again, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer again.Close()

	points, step, err := again.Trend(at, at.Add(time.Hour))
	if err != nil {
		t.Fatalf("Trend: %v", err)
	}

	if step != time.Hour {
		t.Fatalf("step = %s, want 1h", step)
	}

	if len(points) != 1 || !near(points[0].Out, 80) {
		t.Fatalf("got %#v, want the reading that was written before the restart", points)
	}
}

/*
Which resolution answers a question is decided by how far back it reaches.

Asking for the last hour at six-hour buckets would draw one point; asking for
six months at ten-second buckets would ask for a million and a half of them and
find the two hours that are kept. Both are the same mistake — reading a range
against a resolution that has nothing to say about it — and neither would look
like an error from the outside.
*/
func TestTheResolutionFollowsHowFarBackTheQuestionReaches(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)

	for _, one := range []struct {
		back time.Duration
		step time.Duration
	}{
		{back: 10 * time.Minute, step: 10 * time.Second},
		{back: time.Hour, step: 10 * time.Second},
		{back: 24 * time.Hour, step: time.Minute},
		{back: 7 * 24 * time.Hour, step: 15 * time.Minute},
		{back: 31 * 24 * time.Hour, step: time.Hour},
		{back: 92 * 24 * time.Hour, step: 6 * time.Hour},
		{back: 183 * 24 * time.Hour, step: 6 * time.Hour},
		// Further back than anything is kept: the coarsest is the only one that
		// could answer at all.
		{back: 5 * 365 * 24 * time.Hour, step: 6 * time.Hour},
	} {
		if got := coarseEnough(now.Add(-one.back), now).step; got != one.step {
			t.Errorf("a range beginning %s ago is answered at %s, want %s", one.back, got, one.step)
		}
	}
}

/*
Ageing out is per resolution, and it is the only thing bounding any of this.

The ten-second buckets alone are eight and a half thousand a day. Sweeping them
all on one retention would either throw away the six months this exists for or
keep the fine detail for it, and the second is the three million rows the whole
design avoids.
*/
func TestTheSweepAgesOutEachResolutionOnItsOwnRetention(t *testing.T) {
	st, _ := trendAt(t)

	now := time.Now().UTC()

	// Old enough that the ten-second buckets have expired and the minutes have
	// not, which is the boundary that has to be per resolution to exist at all.
	old := now.Add(-5 * time.Hour).Truncate(time.Minute)

	if err := st.Record(Reading{At: old, Out: 100, Rooms: 1}); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if err := st.Record(Reading{At: now.Add(-30 * time.Second), Out: 100, Rooms: 1}); err != nil {
		t.Fatalf("Record: %v", err)
	}

	gone, err := st.SweepTrend(now)
	if err != nil {
		t.Fatalf("SweepTrend: %v", err)
	}

	if gone != 1 {
		t.Errorf("swept %d buckets, want the one ten-second bucket that had aged out", gone)
	}

	if _, found := bucketAt(t, st, resolutions[0].name, old.Truncate(10*time.Second)); found {
		t.Error("a ten-second bucket five hours old is still there, and they are kept for two")
	}

	if _, found := bucketAt(t, st, resolutions[1].name, old); !found {
		t.Error("the minute bucket went with it, and minutes are kept for thirty hours")
	}

	// The recent reading is untouched at every resolution.
	if keysIn(t, st, resolutions[0].name) != 1 {
		t.Error("the reading from thirty seconds ago was swept")
	}
}

/*
A resolution this build no longer keeps is dropped rather than left.

Retention lives in the code and the data lives in the file, so removing a
resolution — or changing a step, which changes its name — orphans every bucket
it ever wrote. Nothing reads them and nothing ages them out, and the file keeps
them for the life of the deployment.
*/
func TestTheSweepDropsAResolutionThatIsNoLongerKept(t *testing.T) {
	st, _ := trendAt(t)

	if err := st.db.Update(func(tx *bolt.Tx) error {
		orphan, err := tx.CreateBucketIfNotExists([]byte(trendPrefix + "45s"))
		if err != nil {
			return err
		}

		return orphan.Put(stamp(time.Now().UTC()), []byte(`{"n":1}`))
	}); err != nil {
		t.Fatalf("write an orphaned resolution: %v", err)
	}

	if _, err := st.SweepTrend(time.Now().UTC()); err != nil {
		t.Fatalf("SweepTrend: %v", err)
	}

	if err := st.db.View(func(tx *bolt.Tx) error {
		if tx.Bucket([]byte(trendPrefix+"45s")) != nil {
			t.Error("a resolution nothing keeps any more is still in the file")
		}

		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

/*
And nothing else in the file goes with it.

The sweep finds orphans by a prefix, which is a rule about names, and the file
holds three other buckets whose names were chosen before this one existed. A
prefix that matched too widely would take the rooms, the sessions or the
settings with it, and the settings are the one record here that is part of the
access control.
*/
func TestTheSweepLeavesEveryOtherBucketAlone(t *testing.T) {
	st, _ := trendAt(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	if err := st.KeepSession("a-token", Session{
		Trip: "4qu3mryghn", Expires: time.Now().Add(time.Hour).UTC(),
	}); err != nil {
		t.Fatalf("KeepSession: %v", err)
	}

	if _, err := st.SweepTrend(time.Now().UTC()); err != nil {
		t.Fatalf("SweepTrend: %v", err)
	}

	if rooms, err := st.Rooms(); err != nil || len(rooms) != 1 {
		t.Errorf("rooms = %v (%v), want the one that was opened", rooms, err)
	}

	if _, ok := st.Session("a-token"); !ok {
		t.Error("the session went with the trend")
	}
}
