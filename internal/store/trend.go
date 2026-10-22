package store

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
The shape of the load, kept for six months.

It was thirty minutes of five-second readings in memory, which answered the
question somebody has while standing at the page and no other. The question it
could not answer is the one an operator asks after the fact — was last Tuesday
evening like this one, is the link busier this month than last — and a buffer
that empties on restart cannot begin to.

Six months of five-second readings is three million rows, so this does not keep
them. It keeps five resolutions, each folded from the one below: fine detail
recently, coarse detail further back, which is the shape every time-series store
arrives at because it is what the question actually needs. Nobody asks what the
uplink was doing for one particular second in April; they ask what April looked
like.

The two hard parts are both silent when they are wrong.

The first is what a bucket means. Throughput in and out are rates, so a bucket's
value is the mean of the readings in it — and the mean alone hides exactly what
somebody opens this page to find, because a two-second burst to the ceiling
inside a six-hour bucket is a rounding error in its average. So each rate also
keeps the highest single reading it saw. Rooms and clients are gauges and keep
only a mean: they move on the timescale of a meeting rather than of a packet, so
even a six-hour average describes their shape honestly, and a peak of them would
be a second number saying nearly the same thing.

The second is that folding has to be exact. What is written down is sums and a
count, never means: adding a reading to a bucket and folding six buckets into
one are then the same operation, that operation is addition, and it cannot
drift. The mean is computed when it is read. Had the means been stored, folding
would have been an average of averages — which is wrong the moment two buckets
hold different numbers of readings, and wrong in a way that looks entirely
plausible on a chart.

A coarse bucket is recomputed from the buckets beneath it rather than added to,
so a bucket half-filled before a restart is corrected rather than doubled, and a
process that was down for an hour leaves a gap rather than a lie.
*/

// trendPrefix names every bucket this file owns, so a resolution a later build
// stopped keeping can be found and dropped rather than left in the file for
// ever holding data nothing will ever read.
const trendPrefix = "trend."

// A resolution is one row of the fold: how wide a bucket is, and how long
// buckets that wide are kept.
//
// The name carries the step because the name is what lives in the file. A build
// that changes a step must change the name with it, or it reads buckets written
// under the old one and quietly averages ten-second buckets as though they were
// minutes.
type resolution struct {
	name []byte
	step time.Duration
	keep time.Duration
}

// The resolutions, finest first.
//
// The steps are chosen so that every span the management page offers lands
// between about three hundred and about two thousand points: enough that the
// shape of an evening survives, few enough that the answer is a few tens of
// kilobytes of JSON and a chart that does not draw eight readings into one
// column of pixels.
//
//	10s over an hour     360 points
//	1m  over a day      1440
//	15m over a week      672
//	1h  over a month     744
//	6h  over six months  744
//
// Ten seconds is the finest worth writing down. It is two readings, and going
// finer means storing the reading itself, which is the three million rows this
// exists to avoid — while the half hour of five-second detail that answers
// "what is happening right now" is already held in memory, where a restart
// losing it costs nothing.
//
// Each is kept a little longer than the longest span it answers, so that a
// custom range ending in the past still lands on the resolution that suits its
// length instead of falling through to a coarser one at the boundary. At full
// retention that is about five thousand buckets altogether, a few hundred
// kilobytes, and a small fraction of that on a server that spends most of its
// time idle: an idle bucket encodes to almost nothing, because every field of
// it is zero and is left out.
var resolutions = []resolution{
	{name: []byte(trendPrefix + "10s"), step: 10 * time.Second, keep: 2 * time.Hour},
	{name: []byte(trendPrefix + "1m"), step: time.Minute, keep: 30 * time.Hour},
	{name: []byte(trendPrefix + "15m"), step: 15 * time.Minute, keep: 9 * 24 * time.Hour},
	{name: []byte(trendPrefix + "1h"), step: time.Hour, keep: 40 * 24 * time.Hour},
	{name: []byte(trendPrefix + "6h"), step: 6 * time.Hour, keep: 190 * 24 * time.Hour},
}

// A Reading is one moment as the media server measured it.
//
// The rates are the server's own, over its own window, rather than a difference
// computed here — the difference between two byte totals divided by the time
// between two ticks is a rate that is wrong by however late the second tick was.
type Reading struct {
	At time.Time
	// Bytes per second, in and out.
	In  float64
	Out float64
	// What was happening, so a spike can be read against it.
	Rooms   int32
	Clients int32
	// Retransmissions asked for, per second.
	Nack float32
}

// interval is one bucket as it is written down: sums and peaks, never means.
//
// Fields are only ever added, as everywhere else in this package. Every one of
// them is omitted when it is zero, which is what makes an idle deployment's six
// months of history cost almost nothing.
type interval struct {
	// N is how many readings are behind this bucket, and it is what makes the
	// means fold exactly. Without it a bucket cannot be combined with another
	// one at all.
	N int32 `json:"n"`

	In      float64 `json:"in,omitempty"`
	Out     float64 `json:"out,omitempty"`
	Rooms   float64 `json:"rooms,omitempty"`
	Clients float64 `json:"clients,omitempty"`
	Nack    float64 `json:"nack,omitempty"`

	// The highest single reading in the bucket, for the three figures that are
	// rates. A mean of a rate hides a burst; a mean of a gauge does not.
	InPeak   float64 `json:"inPeak,omitempty"`
	OutPeak  float64 `json:"outPeak,omitempty"`
	NackPeak float64 `json:"nackPeak,omitempty"`
}

// A Point is one bucket as anybody reads it: means where a mean is the honest
// answer, and the peak beside the two rates that are drawn.
//
// At is the moment the bucket opened rather than its middle or its end, so a
// point sits at the start of the period it describes and the last point on a
// chart is the period in progress.
type Point struct {
	At time.Time `json:"at"`

	In      float64 `json:"in"`
	Out     float64 `json:"out"`
	Rooms   float64 `json:"rooms"`
	Clients float64 `json:"clients"`
	Nack    float64 `json:"nack"`

	InPeak   float64 `json:"inPeak"`
	OutPeak  float64 `json:"outPeak"`
	NackPeak float64 `json:"nackPeak"`

	// Readings says how much is behind the point. A bucket holding one reading
	// out of a possible thirty-six is not wrong, but it is not the same claim
	// as a full one, and only this says which it is.
	Readings int32 `json:"n"`
}

// interval turns one reading into a bucket of one, so that recording and
// folding are the same operation.
func (r Reading) interval() interval {
	return interval{
		N:        1,
		In:       r.In,
		Out:      r.Out,
		Rooms:    float64(r.Rooms),
		Clients:  float64(r.Clients),
		Nack:     float64(r.Nack),
		InPeak:   r.In,
		OutPeak:  r.Out,
		NackPeak: float64(r.Nack),
	}
}

// absorb folds another bucket into this one.
//
// Sums add and peaks take the larger, which is what makes the fold associative:
// six ten-second buckets into a minute and sixty minutes into an hour give the
// same answer as every reading folded into the hour directly.
func (i *interval) absorb(other interval) {
	i.N += other.N
	i.In += other.In
	i.Out += other.Out
	i.Rooms += other.Rooms
	i.Clients += other.Clients
	i.Nack += other.Nack
	i.InPeak = max(i.InPeak, other.InPeak)
	i.OutPeak = max(i.OutPeak, other.OutPeak)
	i.NackPeak = max(i.NackPeak, other.NackPeak)
}

// point divides the sums by the count, which is the only place a mean is made.
func (i interval) point(at time.Time) Point {
	if i.N == 0 {
		return Point{At: at}
	}

	n := float64(i.N)

	return Point{
		At:       at,
		In:       i.In / n,
		Out:      i.Out / n,
		Rooms:    i.Rooms / n,
		Clients:  i.Clients / n,
		Nack:     i.Nack / n,
		InPeak:   i.InPeak,
		OutPeak:  i.OutPeak,
		NackPeak: i.NackPeak,
		Readings: i.N,
	}
}

// stamp is the key a bucket is filed under: the second it opened, big-endian.
//
// Big-endian because bbolt sorts keys as bytes, and this is what makes that
// order the order of time — which is the whole of how a range is read and how
// the sweep finds what has aged out. Written as a fixed eight bytes rather than
// as a formatted time for the same reason: any text encoding sorts wrongly
// somewhere, usually across a digit-count boundary nobody thinks to test.
func stamp(at time.Time) []byte {
	seconds := at.UTC().Unix()
	if seconds < 0 {
		seconds = 0
	}

	key := make([]byte, 8)
	binary.BigEndian.PutUint64(key, uint64(seconds))

	return key
}

// stamped reads a key back.
func stamped(key []byte) time.Time {
	if len(key) != 8 {
		return time.Time{}
	}

	return time.Unix(int64(binary.BigEndian.Uint64(key)), 0).UTC()
}

// Record writes one reading down and refolds every bucket above it.
//
// One transaction per reading rather than a batch flushed when the finest
// bucket closes. Buffering was considered and rejected twice over: it would put
// the bucket boundary in two places that have to agree, and it would lose the
// last few seconds on every restart — which is the one window somebody
// restarting a server actually wants to look at afterwards. What it costs is a
// small write every five seconds, which is less than one join.
func (s *Store) Record(reading Reading) error {
	at := reading.At.UTC()

	err := s.db.Update(func(tx *bolt.Tx) error {
		fine := resolutions[0]

		bucket, err := tx.CreateBucketIfNotExists(fine.name)
		if err != nil {
			return err
		}

		// Truncate rounds down to a multiple of the step measured from the zero
		// time, which is midnight UTC. Every step here divides a day, so a
		// bucket begins on a boundary an operator would recognise: on the hour,
		// on the quarter hour, at six.
		start := at.Truncate(fine.step)

		open := interval{}
		if raw := bucket.Get(stamp(start)); raw != nil {
			// A bucket this build cannot read is started again rather than
			// abandoned, on the same principle as an unreadable tally: the cost
			// is a few seconds of a chart, and the alternative is a bucket that
			// can never be written to again.
			if err := json.Unmarshal(raw, &open); err != nil {
				open = interval{}
			}
		}

		open.absorb(reading.interval())

		if err := keep(bucket, start, open); err != nil {
			return err
		}

		for i := 1; i < len(resolutions); i++ {
			if err := fold(tx, resolutions[i-1], resolutions[i], at); err != nil {
				return err
			}
		}

		return nil
	})

	if err != nil {
		return fmt.Errorf("record the load at %s: %w", at.Format(time.RFC3339), err)
	}

	return nil
}

// fold recomputes the coarse bucket holding at from the fine buckets inside it.
//
// Recomputed rather than added to, and that is the whole reason this is cheap
// to get right. A bucket that was half filled when the process stopped is
// finished correctly when it starts again; a reading that arrives late lands in
// the bucket it belongs to; and nothing can be counted twice, however many
// times this runs.
//
// Every resolution is kept for longer than the width of the one above it, so
// the buckets a fold needs are always still there.
func fold(tx *bolt.Tx, from, into resolution, at time.Time) error {
	source := tx.Bucket(from.name)
	if source == nil {
		return nil
	}

	target, err := tx.CreateBucketIfNotExists(into.name)
	if err != nil {
		return err
	}

	start := at.Truncate(into.step)
	end := start.Add(into.step)

	var folded interval

	cursor := source.Cursor()
	for key, raw := cursor.Seek(stamp(start)); key != nil && stamped(key).Before(end); key, raw = cursor.Next() {
		var one interval
		if err := json.Unmarshal(raw, &one); err != nil {
			continue
		}

		folded.absorb(one)
	}

	if folded.N == 0 {
		return nil
	}

	return keep(target, start, folded)
}

func keep(bucket *bolt.Bucket, start time.Time, held interval) error {
	encoded, err := json.Marshal(held)
	if err != nil {
		return err
	}

	return bucket.Put(stamp(start), encoded)
}

// Trend returns the load between two moments, and says how wide the buckets it
// answered with are.
//
// The width is returned rather than left to be inferred, because a list of
// points without it cannot be read: the same array is an hour or a fortnight
// depending on a number the caller has no other way to know, and a page that
// guesses wrongly labels an axis with the wrong day.
//
// The resolution is the finest one whose retention reaches back as far as the
// range asked for. A range that begins before every resolution's retention gets
// the coarsest, which is the only one that could have anything to say about it.
func (s *Store) Trend(from, to time.Time) ([]Point, time.Duration, error) {
	pick := coarseEnough(from, time.Now().UTC())
	points := []Point{}

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(pick.name)
		if bucket == nil {
			// Nothing has been recorded at this resolution yet, which is a
			// young deployment rather than a fault.
			return nil
		}

		last := to.UTC()

		cursor := bucket.Cursor()
		for key, raw := cursor.Seek(stamp(from.UTC().Truncate(pick.step))); key != nil; key, raw = cursor.Next() {
			at := stamped(key)
			if at.After(last) {
				break
			}

			var one interval
			if err := json.Unmarshal(raw, &one); err != nil || one.N == 0 {
				continue
			}

			points = append(points, one.point(at))
		}

		return nil
	})

	if err != nil {
		return nil, pick.step, fmt.Errorf("read the load since %s: %w", from.Format(time.RFC3339), err)
	}

	return points, pick.step, nil
}

// coarseEnough picks the finest resolution that still reaches back to from.
func coarseEnough(from, now time.Time) resolution {
	age := now.Sub(from)

	for _, one := range resolutions {
		if age <= one.keep {
			return one
		}
	}

	return resolutions[len(resolutions)-1]
}

// SweepTrend removes the buckets that have aged out.
//
// On the same timer as the sessions and the arrivals, and it is the only thing
// bounding this at all: the finest resolution alone writes eight and a half
// thousand buckets a day, for ever, and nothing else would ever take one away.
//
// Unbounded, unlike the room sweep beside it, and deliberately: retention holds
// the whole of this to about five thousand buckets, so the transaction is
// small by construction rather than by being cut into batches. The room sweep
// is bounded because nothing bounds how many names a deployment accumulates.
func (s *Store) SweepTrend(now time.Time) (gone int, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		known := make(map[string]bool, len(resolutions))

		for _, one := range resolutions {
			known[string(one.name)] = true

			bucket := tx.Bucket(one.name)
			if bucket == nil {
				continue
			}

			edge := stamp(now.UTC().Add(-one.keep))

			// Gathered before anything is removed. Deleting through a cursor
			// while walking it is behaviour bbolt declines to define.
			var stale [][]byte

			cursor := bucket.Cursor()
			for key, _ := cursor.First(); key != nil && bytes.Compare(key, edge) < 0; key, _ = cursor.Next() {
				stale = append(stale, append([]byte(nil), key...))
			}

			for _, key := range stale {
				if err := bucket.Delete(key); err != nil {
					return err
				}

				gone++
			}
		}

		// A resolution this build no longer keeps.
		//
		// Retention is written in the code and the data is written in the file,
		// so a build that drops a resolution leaves its buckets behind with
		// nothing to age them out and nothing that will ever read them. Found
		// by the prefix every one of these names carries.
		var orphans [][]byte

		if err := tx.ForEach(func(name []byte, bucket *bolt.Bucket) error {
			if strings.HasPrefix(string(name), trendPrefix) && !known[string(name)] {
				orphans = append(orphans, append([]byte(nil), name...))
				gone += bucket.Stats().KeyN
			}

			return nil
		}); err != nil {
			return err
		}

		for _, name := range orphans {
			if err := tx.DeleteBucket(name); err != nil {
				return err
			}
		}

		return nil
	})

	if err != nil {
		return 0, fmt.Errorf("sweep the trend: %w", err)
	}

	return gone, nil
}
