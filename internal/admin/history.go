package admin

import (
	"fmt"
	"log/slog"
	"net/url"
	"sync"
	"time"

	"tomoshibi/internal/store"
)

/*
How the trend is kept.

Two things, at two timescales, and they answer different questions.

In memory: five seconds apart for half an hour. That is what somebody standing
at the page is looking at, it is finer than anything worth writing to disk, and
losing it on a restart costs nothing — half an hour later it is back.

On disk, through [Loads]: the same readings folded into buckets that grow
coarser the further back they go, out to six months. That answers the question
the memory buffer could not, which is what last Tuesday was like. The folding is
the store's, and the argument for it is written where it happens.

The store is optional. A deployment without one keeps exactly what it always
kept — the last half hour — and every span longer than that comes back with
whatever the buffer holds rather than with an error, because a chart that is
short is readable and an error is not.
*/

const (
	every = 5 * time.Second
	// recent is how much five-second detail is held in memory.
	recent = 30 * time.Minute
	depth  = int(recent / every)
)

// A Sample is one moment.
type Sample struct {
	At time.Time `json:"at"`
	// Bytes per second, in and out, as the media server measured them over its
	// own window rather than as a difference computed here.
	In  float64 `json:"in"`
	Out float64 `json:"out"`
	// What was happening, so a spike can be read against it.
	Rooms   int32   `json:"rooms"`
	Clients int32   `json:"clients"`
	Nack    float32 `json:"nack"`
}

// point turns a reading into the shape a span is answered in.
//
// One reading is its own peak, which is the honest answer and not a placeholder:
// asked for five-second detail, the highest value in a bucket and the value are
// the same number.
func (s Sample) point() store.Point {
	return store.Point{
		At: s.At, In: s.In, Out: s.Out,
		Rooms: float64(s.Rooms), Clients: float64(s.Clients), Nack: float64(s.Nack),
		InPeak: s.In, OutPeak: s.Out, NackPeak: float64(s.Nack),
		Readings: 1,
	}
}

// Loads is the trend as it is written down.
//
// A narrow interface for the reason this package names them at all: the
// endpoint below has a gate in front of it, and a gate that can only be
// exercised by standing up a database is a gate nobody exercises. Nil where
// there is no store, which is a relay.
type Loads interface {
	Record(reading store.Reading) error
	Trend(from, to time.Time) ([]store.Point, time.Duration, error)
}

// History is the shape of the load.
//
// Kept in the server rather than in the page, and that is the whole design
// decision. A buffer in the browser starts empty on every load, so somebody
// opening this to find out what just happened would wait half an hour to be
// told. One buffer here means two administrators watching see the same picture
// and a reload keeps it.
type History struct {
	mu      sync.Mutex
	samples []Sample

	// kept is where a reading goes to outlive the process. Nil on a deployment
	// with no store.
	kept Loads
	// failing remembers whether the last write was refused, so a store that has
	// become unwritable is said once rather than twelve times a minute. A log
	// nobody can read past is a log nobody reads.
	failing bool
}

func NewHistory(kept Loads) *History {
	return &History{samples: make([]Sample, 0, depth), kept: kept}
}

// Watch fills the history until the channel closes.
//
// Its own ticker rather than sampling when a page asks: a trend with gaps
// wherever nobody was looking is not a trend, and the first thing anybody would
// do with one is misread the gap as quiet.
func (h *History) Watch(stop <-chan struct{}, read func() Sample) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()

	h.add(read())

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			h.add(read())
		}
	}
}

func (h *History) add(sample Sample) {
	h.mu.Lock()

	h.samples = append(h.samples, sample)
	if len(h.samples) > depth {
		// Copied down rather than resliced, so the array does not keep hold of
		// the samples that fell off the end.
		h.samples = append(h.samples[:0], h.samples[len(h.samples)-depth:]...)
	}

	h.mu.Unlock()

	// Fixed at construction and never assigned again, which is what makes it
	// safe to read from here without the lock.
	if h.kept == nil {
		return
	}

	// Written outside the lock. The store admits one writer and a page reading
	// the buffer should not queue behind it — and a store that has become slow
	// must not be able to stop the sampler, which is the only thing that knows
	// what the last half hour looked like.
	err := h.kept.Record(store.Reading{
		At: sample.At, In: sample.In, Out: sample.Out,
		Rooms: sample.Rooms, Clients: sample.Clients, Nack: sample.Nack,
	})

	h.saidSo(err)
}

// saidSo reports a store that stopped accepting the trend, once.
func (h *History) saidSo(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	switch {
	case err != nil && !h.failing:
		h.failing = true
		slog.Error("failed to write down the trend, so the history will have a gap", "error", err)
	case err == nil && h.failing:
		h.failing = false
		slog.Info("the trend is being written down again")
	}
}

// Over is the load between two moments, and how wide the buckets are.
//
// The buffer answers where it can, because five seconds beats ten and because
// it is the only thing a deployment without a store has. It answers only where
// it holds the whole range: a process that started two minutes ago holds two
// minutes, and answering a ten-minute question with it would draw a chart that
// says the server was idle for eight of them.
func (h *History) Over(from, to time.Time) ([]store.Point, time.Duration) {
	if points, whole := h.buffered(from, to); whole {
		return points, every
	}

	if h.kept != nil {
		points, step, err := h.kept.Trend(from, to)
		if err != nil {
			slog.Warn("failed to read the trend", "error", err)
		} else {
			return points, step
		}
	}

	// Whatever overlaps, which is what this endpoint answered before there was
	// anywhere to write a reading down. Short is readable; an error is not.
	points, _ := h.buffered(from, to)

	return points, every
}

// buffered is what memory holds of a range, and whether it holds all of it.
func (h *History) buffered(from, to time.Time) ([]store.Point, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	points := []store.Point{}

	for _, sample := range h.samples {
		if sample.At.Before(from) || sample.At.After(to) {
			continue
		}

		points = append(points, sample.point())
	}

	whole := len(h.samples) > 0 && !h.samples[0].At.After(from)

	return points, whole
}

/*
The spans a page may ask for.

Named rather than given as a number of seconds, so that the server and the page
agree on what "a month" is without either of them having to say it in a query
string. The page draws its own words for these; what travels is the key.

Two of the eight the deployment's owner asked for are the same length — a day
and twenty-four hours — and are one entry here rather than two buttons that do
the same thing.
*/

// A Span is a length of time with a name.
type Span struct {
	Key string
	For time.Duration
}

var spans = []Span{
	{Key: "10m", For: 10 * time.Minute},
	// What a caller that asks for nothing gets, which is what this endpoint
	// answered before there were spans at all.
	{Key: "30m", For: recent},
	{Key: "1h", For: time.Hour},
	{Key: "24h", For: 24 * time.Hour},
	{Key: "1w", For: 7 * 24 * time.Hour},
	{Key: "1mo", For: 31 * 24 * time.Hour},
	{Key: "3mo", For: 92 * 24 * time.Hour},
	{Key: "6mo", For: 183 * 24 * time.Hour},
}

const defaultSpan = "30m"

// askedFor reads the range a request wants.
//
// Either a named span ending now, or a pair of moments. The pair is what the
// page's custom range sends, and it is the only way to ask about a window that
// has already passed — every named span ends at this instant, which is what
// makes them cheap to say and useless for looking at last Tuesday.
func askedFor(query url.Values, now time.Time) (span string, from, to time.Time, err error) {
	if raw := query.Get("from"); raw != "" {
		from, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return "", time.Time{}, time.Time{}, fmt.Errorf("from: %w", err)
		}

		to := now
		if raw := query.Get("to"); raw != "" {
			if to, err = time.Parse(time.RFC3339, raw); err != nil {
				return "", time.Time{}, time.Time{}, fmt.Errorf("to: %w", err)
			}
		}

		if !from.Before(to) {
			return "", time.Time{}, time.Time{}, fmt.Errorf("from %s is not before to %s",
				from.Format(time.RFC3339), to.Format(time.RFC3339))
		}

		return "custom", from.UTC(), to.UTC(), nil
	}

	key := query.Get("span")
	if key == "" {
		key = defaultSpan
	}

	for _, one := range spans {
		if one.Key == key {
			return one.Key, now.Add(-one.For), now, nil
		}
	}

	return "", time.Time{}, time.Time{}, fmt.Errorf("%q is not a span this server keeps", key)
}
