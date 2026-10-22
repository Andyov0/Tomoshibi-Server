package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
What these guard is the seam between the half hour in memory and the six months
on disk.

Two sources answer the same endpoint, and everything that can go wrong at the
join between them is quiet. Answering a six-month question out of a buffer that
holds thirty minutes draws a server that was switched off until this morning.
Answering a one-minute question out of the store throws away the finer readings
for no reason and nobody can tell from the picture. Taking a sample and not
writing it down leaves a history that is complete right up until the moment
anybody restarts the process, which is the failure the store was added to fix
and the one that only shows up weeks later.

The store is a hand-written stub here rather than a database, which is the whole
reason [Loads] is an interface: the endpoint has a gate in front of it, and a
gate that can only be exercised by standing up bbolt is a gate that goes
untested.
*/

// asked is one range the stub was asked for.
type asked struct {
	from time.Time
	to   time.Time
}

// written is a store that remembers what it was told and what it was asked.
type written struct {
	mu       sync.Mutex
	readings []store.Reading
	ranges   []asked
	points   []store.Point
	step     time.Duration
	refuses  error

	// arrived is closed once, when the first reading lands, so a test can wait
	// for the sampler rather than sleep for it.
	arrived chan struct{}
	once    sync.Once
}

func newWritten(step time.Duration, points ...store.Point) *written {
	return &written{points: points, step: step, arrived: make(chan struct{})}
}

func (k *written) Record(reading store.Reading) error {
	k.mu.Lock()
	k.readings = append(k.readings, reading)
	k.mu.Unlock()

	k.once.Do(func() { close(k.arrived) })

	return k.refuses
}

func (k *written) Trend(from, to time.Time) ([]store.Point, time.Duration, error) {
	k.mu.Lock()
	defer k.mu.Unlock()

	k.ranges = append(k.ranges, asked{from: from, to: to})

	if k.refuses != nil {
		return nil, 0, k.refuses
	}

	return k.points, k.step, nil
}

func (k *written) seen() ([]store.Reading, []asked) {
	k.mu.Lock()
	defer k.mu.Unlock()

	return append([]store.Reading(nil), k.readings...), append([]asked(nil), k.ranges...)
}

/*
A reading taken is a reading written down.

The sampler and the store were wired together in one line, and a line like that
either exists or it does not. Nothing else in this package would notice its
absence: the page keeps drawing, the buffer keeps filling, and the history is
perfect until the first restart.
*/
func TestASampleIsWrittenDownAsItIsTaken(t *testing.T) {
	held := newWritten(time.Minute)
	history := NewHistory(held)

	at := time.Now().UTC()
	stop := make(chan struct{})

	// Watch reads once before its first tick, so this does not wait five
	// seconds for anything.
	go history.Watch(stop, func() Sample {
		return Sample{At: at, In: 11, Out: 22, Rooms: 3, Clients: 7, Nack: 1.5}
	})

	select {
	case <-held.arrived:
	case <-time.After(2 * time.Second):
		t.Fatal("a sample was taken and never written down")
	}

	close(stop)

	readings, _ := held.seen()

	one := readings[0]
	if !one.At.Equal(at) || one.In != 11 || one.Out != 22 ||
		one.Rooms != 3 || one.Clients != 7 || one.Nack != 1.5 {
		t.Errorf("wrote down %#v, which is not the sample that was taken", one)
	}
}

/*
The finer source wins where it can, and only where it can.

Both halves matter. A buffer asked for more than it holds answers with a chart
that begins wherever the process started, which reads as an idle server rather
than as a young one — and it is right about neither, because the store has the
rest. A store asked for the last minute answers at ten seconds what memory holds
at five, which is worse for no reason.
*/
func TestTheBufferAnswersWhatItCoversAndTheStoreTheRest(t *testing.T) {
	held := newWritten(15*time.Minute, store.Point{At: time.Now().UTC(), Out: 999})
	history := NewHistory(held)

	now := time.Now().UTC()
	for i := range 24 {
		history.add(Sample{At: now.Add(time.Duration(i-24) * 5 * time.Second), Out: float64(i)})
	}

	// Two minutes of buffer, asked for one.
	points, step := history.Over(now.Add(-time.Minute), now)
	if step != every {
		t.Errorf("a minute was answered at %s, want the buffer's %s", step, every)
	}
	if len(points) == 0 || points[len(points)-1].Out != 23 {
		t.Errorf("a minute answered with %d points, the last of them %v, want the buffer's own",
			len(points), points[len(points)-1:])
	}

	if _, ranges := held.seen(); len(ranges) != 0 {
		t.Errorf("the store was asked for a range the buffer already held: %v", ranges)
	}

	// A week, which memory has never held.
	points, step = history.Over(now.Add(-7*24*time.Hour), now)
	if step != 15*time.Minute {
		t.Errorf("a week was answered at %s, want the store's step", step)
	}
	if len(points) != 1 || points[0].Out != 999 {
		t.Errorf("a week answered with %d points, want the one the store returned", len(points))
	}

	if _, ranges := held.seen(); len(ranges) != 1 {
		t.Fatalf("the store was asked %d times for one week", len(ranges))
	}
}

/*
A store that will not answer costs the long spans and nothing else.

The same rule the rest of this server is built on: a record that cannot be read
must not turn one broken thing into a page that will not open. What the reader
gets is the half hour memory still holds, which is less than they asked for and
is not nothing.
*/
func TestAStoreThatWillNotAnswerStillLeavesTheRecentReadings(t *testing.T) {
	held := newWritten(time.Hour)
	held.refuses = errors.New("the file is not readable")

	history := NewHistory(held)

	now := time.Now().UTC()
	history.add(Sample{At: now.Add(-10 * time.Second), Out: 42})

	points, step := history.Over(now.Add(-6*30*24*time.Hour), now)

	if step != every || len(points) != 1 || points[0].Out != 42 {
		t.Errorf("got %d points at %s, want the one reading memory still holds", len(points), step)
	}
}

/*
And a deployment with no store at all answers the same way.

A relay keeps nothing. Left unguarded this is a nil interface being called on a
timer and on every request, which is a page that cannot be opened and a process
that stops.
*/
func TestADeploymentWithNoStoreAnswersFromMemory(t *testing.T) {
	history := NewHistory(nil)

	now := time.Now().UTC()
	history.add(Sample{At: now.Add(-10 * time.Second), Out: 7})

	points, step := history.Over(now.Add(-183*24*time.Hour), now)

	if step != every || len(points) != 1 || points[0].Out != 7 {
		t.Errorf("got %d points at %s, want the one reading in memory", len(points), step)
	}
}

/*
What a span means is the server's to decide.

A page asking for six months and a page asking for six weeks must not both get
whatever the query string happened to parse into. The refusal is a code rather
than a sentence, because the page says this in a language this server does not
know which of four it is.
*/
func TestASpanThisServerDoesNotKeepIsRefused(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "watcher"), Name: "watcher"}})
	api.history = NewHistory(newWritten(6 * time.Hour))

	_, token, ok := api.sessions.Open("", "watcher")
	if !ok {
		t.Fatal("the configured passphrase was refused")
	}

	ask := func(query string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/api/admin/history"+query, nil)
		request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)

		return recorder
	}

	for _, query := range []string{"?span=6mo", "?span=10m", "?span=1w", ""} {
		if code := ask(query).Code; code != http.StatusOK {
			t.Errorf("%q answered %d, want 200", query, code)
		}
	}

	for _, query := range []string{"?span=1y", "?span=42", "?from=yesterday"} {
		recorder := ask(query)

		if recorder.Code != http.StatusBadRequest {
			t.Errorf("%q answered %d, want 400", query, recorder.Code)
			continue
		}

		var body struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("the refusal was not readable: %v", err)
		}

		if body.Error != "no_such_span" {
			t.Errorf("%q was refused with %q, want a code the page can translate", query, body.Error)
		}
	}
}

/*
The answer says what it is an answer to.

A list of points is unreadable without the width of a bucket and the range they
cover: the same array is an hour or half a year, and a page that assumed either
would label an axis with the wrong day and be believed. This was a bare array
when the only possible answer was the last half hour at five seconds, which is
exactly the assumption that stopped being safe.
*/
func TestTheAnswerCarriesItsSpanAndItsResolution(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "watcher"), Name: "watcher"}})

	held := newWritten(6*time.Hour, store.Point{At: time.Now().UTC().Add(-time.Hour), Out: 5, OutPeak: 50})
	api.history = NewHistory(held)

	_, token, _ := api.sessions.Open("", "watcher")

	request := httptest.NewRequest(http.MethodGet, "/api/admin/history?span=6mo", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	var body struct {
		Span   string        `json:"span"`
		Step   float64       `json:"step"`
		From   time.Time     `json:"from"`
		To     time.Time     `json:"to"`
		Points []store.Point `json:"points"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("the answer was not readable: %v", err)
	}

	if body.Span != "6mo" {
		t.Errorf("span = %q, want the one that was asked for", body.Span)
	}

	if body.Step != (6 * time.Hour).Seconds() {
		t.Errorf("step = %v seconds, want the store's own", body.Step)
	}

	// Half a year, give or take the time the request took.
	if covered := body.To.Sub(body.From); covered < 182*24*time.Hour || covered > 184*24*time.Hour {
		t.Errorf("the answer covers %s, want about six months", covered)
	}

	if len(body.Points) != 1 || body.Points[0].OutPeak != 50 {
		t.Errorf("points = %#v, want what the store held, peak and all", body.Points)
	}
}

/*
A custom range is the only way to ask about a window that has already passed.

Every named span ends at this instant, which is what makes them cheap to say and
useless for last Tuesday. The moments have to reach the store as they were
given: a range quietly rebased onto now answers a different question and looks
like a perfectly good chart of it.
*/
func TestACustomRangeIsAskedForExactly(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "watcher"), Name: "watcher"}})

	held := newWritten(time.Hour)
	api.history = NewHistory(held)

	_, token, _ := api.sessions.Open("", "watcher")

	from := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	to := time.Date(2026, 3, 1, 17, 0, 0, 0, time.UTC)

	request := httptest.NewRequest(http.MethodGet,
		"/api/admin/history?from="+from.Format(time.RFC3339)+"&to="+to.Format(time.RFC3339), nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("a custom range answered %d", recorder.Code)
	}

	_, ranges := held.seen()
	if len(ranges) != 1 {
		t.Fatalf("the store was asked %d times", len(ranges))
	}

	if !ranges[0].from.Equal(from) || !ranges[0].to.Equal(to) {
		t.Errorf("the store was asked for %s to %s, want %s to %s",
			ranges[0].from, ranges[0].to, from, to)
	}

	var body struct {
		Span string `json:"span"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)

	if body.Span != "custom" {
		t.Errorf("span = %q, want custom", body.Span)
	}
}

// A range that runs backwards is a mistake rather than an empty chart.
func TestARangeThatEndsBeforeItBeginsIsRefused(t *testing.T) {
	now := time.Now().UTC()

	if _, _, _, err := askedFor(map[string][]string{
		"from": {now.Format(time.RFC3339)},
		"to":   {now.Add(-time.Hour).Format(time.RFC3339)},
	}, now); err == nil {
		t.Error("a range ending before it began was accepted")
	}
}

/*
A deployment with no store is not handed one that is only shaped like one.

A nil *store.Store put into an interface is an interface that is not nil: it
carries the type, so every guard against it passes and the first method call
dereferences nothing at the far end. This package has been here once already,
with the media server, and the symptom was the same both times — a process that
comes up, runs for five seconds, and stops, at a moment detached from anything
anybody did.

Assembled through the constructor, because the guard is in the constructor and a
history built by hand in a test would never meet it.
*/
func TestAnAbsentStoreIsNotHandedToTheHistory(t *testing.T) {
	api := New(
		&config.Config{
			Meet:    config.Meet{Admins: []config.Admin{{Trip: room.Trip(key, "watcher")}}},
			LiveKit: livekitDefaults(),
		},
		nil, nil, key,
	)
	defer api.Close()

	// The sampler is already running against the same field.
	points, step := api.history.Over(time.Now().Add(-time.Hour).UTC(), time.Now().UTC())

	if step != every {
		t.Errorf("a deployment with no store answered at %s, want the buffer's %s", step, every)
	}

	if points == nil {
		t.Error("points came back nil, which a page reads as a fault rather than as an empty chart")
	}
}
