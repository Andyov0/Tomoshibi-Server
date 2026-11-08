package lockout

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tomoshibi/internal/store"
)

/*
 * What these guard is the rule the owner gave, at its edges: more than ten
 * failed sign-ins inside five minutes shut one address and one device out for
 * half an hour. Each edge is the kind that goes wrong silently — a window that
 * does not slide, an off-by-one that makes it the twelfth, a lockout that ends
 * at a restart, two devices behind one address counted as one — and each is
 * asserted from a clock the test holds rather than the wall clock, so nothing
 * here passes or fails by how fast the machine is.
 */

// clock is a time the test moves by hand.
type clock struct{ at time.Time }

func (c *clock) now() time.Time { return c.at }

func (c *clock) wait(d time.Duration) { c.at = c.at.Add(d) }

func booked(t *testing.T, kept Kept) (*Book, *clock) {
	t.Helper()

	held := &clock{at: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)}
	book := New(kept)
	book.now = held.now

	return book, held
}

const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

// fail counts one failure and reports whether it was answered as a lockout.
func fail(book *Book, caller Caller) bool {
	return book.Failed(httptest.NewRecorder(), caller, Account, "rate_limited")
}

func shut(book *Book, caller Caller) bool {
	return book.Shut(httptest.NewRecorder(), caller, "rate_limited")
}

func TestTheNumbersAreTheOwners(t *testing.T) {
	if Failures != 10 || Window != 5*time.Minute || For != 30*time.Minute {
		t.Errorf("the rule is more than %d in %v for %v, want more than 10 in 5m0s for 30m0s", Failures, Window, For)
	}
}

func TestTheEleventhFailureInsideFiveMinutesShutsTheCallerOut(t *testing.T) {
	book, held := booked(t, nil)
	caller := At("203.0.113.9", chrome)

	for i := 1; i <= Failures; i++ {
		if fail(book, caller) {
			t.Fatalf("failure %d was answered as a lockout", i)
		}
		if shut(book, caller) {
			t.Fatalf("shut out after %d failures, want only after more than %d", i, Failures)
		}
		held.wait(20 * time.Second)
	}

	recorder := httptest.NewRecorder()
	if !book.Failed(recorder, caller, Account, "rate_limited") {
		t.Fatal("the eleventh failure inside five minutes did not shut the caller out")
	}
	if recorder.Code != http.StatusTooManyRequests {
		t.Errorf("the failure that shut them out answered %d, want 429", recorder.Code)
	}

	if !shut(book, caller) {
		t.Error("the caller was not shut out after the eleventh failure")
	}
}

func TestTheWindowSlides(t *testing.T) {
	cases := []struct {
		name string
		// gap is the time between the first failure and the eleventh. The
		// nine between them come in the seconds before the eleventh, so
		// whether the eleventh shuts the caller out depends on the first
		// alone.
		gap  time.Duration
		shut bool
	}{
		{"all eleven a second inside five minutes", Window - time.Second, true},
		{"the first exactly five minutes before the eleventh", Window, false},
		{"the first long before the rest", 4 * Window, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			book, held := booked(t, nil)
			caller := At("203.0.113.9", chrome)
			start := held.at

			fail(book, caller)
			for before := Failures - 1; before >= 1; before-- {
				held.at = start.Add(c.gap - time.Duration(before)*time.Second)
				if fail(book, caller) {
					t.Fatalf("shut out before the eleventh failure")
				}
			}

			held.at = start.Add(c.gap)
			if got := fail(book, caller); got != c.shut {
				t.Errorf("the eleventh failure shut the caller out: %v, want %v", got, c.shut)
			}
		})
	}
}

// A run of failures after a quiet spell is recorded as that run, whether or
// not the minute's sweep has come round to the count from before it. The
// failures from before are outside the window and never decided anything, so
// this guards the record and not the rule: a lockout written down as
// fourteen failures from noon at both sign-ins, when eleven at the account
// sign-in after five past are what made it, sends whoever reads it looking
// for a run at the management sign-in that ended long before.
func TestAQuietSpellStartsTheRecordAfresh(t *testing.T) {
	book, held := booked(t, nil)
	caller := At("203.0.113.9", chrome)
	start := held.at

	for i := 0; i < 3; i++ {
		book.Failed(httptest.NewRecorder(), caller, Management, "too_many_attempts")
	}

	// Somebody else's failure four and a half minutes on, which is what
	// brings the sweep round while the three are still inside the window, so
	// the sweep leaves them; nothing sweeps again before the run below.
	held.at = start.Add(4*time.Minute + 30*time.Second)
	fail(book, At("198.51.100.1", chrome))

	held.at = start.Add(5*time.Minute + 10*time.Second)
	run := held.at
	for i := 0; i <= Failures; i++ {
		fail(book, caller)
	}

	listed := book.Lockouts()
	if len(listed) != 1 {
		t.Fatalf("%d lockouts, want 1", len(listed))
	}

	one := listed[0]
	if one.Failures != Failures+1 || !one.First.Equal(run) || len(one.Doors) != 1 || one.Doors[0] != Account {
		t.Errorf("recorded %d failures from %s at %v, want %d from %s at the account sign-in alone",
			one.Failures, one.First.Format(time.TimeOnly), one.Doors, Failures+1, run.Format(time.TimeOnly))
	}
}

// A user agent is the caller's to write, as long as the header limit allows.
// What a caller is known by is cut short before it reaches the count, the
// store, the listing or the log, and what is cut is still one device.
func TestALongUserAgentIsHeldShort(t *testing.T) {
	book, _ := booked(t, nil)

	long := "Tomoshibi/" + strings.Repeat("1", 300_000) + " (iPhone; " + strings.Repeat("i", 300_000) + "; " + strings.Repeat("d", 300_000) + ")"
	caller := At("203.0.113.9", long)

	if len(caller.agent) > agentHeld {
		t.Fatalf("a caller is known by %d bytes of user agent, want at most %d", len(caller.agent), agentHeld)
	}

	for i := 0; i <= Failures; i++ {
		fail(book, caller)
	}

	// The same agent again is the same caller, and still shut out.
	if !shut(book, At("203.0.113.9", long)) {
		t.Error("the same long user agent was not the same caller")
	}

	listed := book.Lockouts()
	if len(listed) != 1 {
		t.Fatalf("%d lockouts, want 1", len(listed))
	}

	encoded, _ := json.Marshal(listed[0])
	if len(encoded) > 2*agentHeld {
		t.Errorf("a lockout from a long user agent is %d bytes as the page is given it", len(encoded))
	}
}

func TestALockoutLastsHalfAnHour(t *testing.T) {
	book, held := booked(t, nil)
	caller := At("203.0.113.9", chrome)

	for i := 0; i <= Failures; i++ {
		fail(book, caller)
	}

	began := held.at

	recorder := httptest.NewRecorder()
	if !book.Shut(recorder, caller, "rate_limited") {
		t.Fatal("not shut out at all")
	}
	if got := recorder.Header().Get("Retry-After"); got != strconv.Itoa(int(For.Seconds())) {
		t.Errorf("Retry-After %q at the start, want %d", got, int(For.Seconds()))
	}

	held.at = began.Add(For - time.Second)
	if !shut(book, caller) {
		t.Error("let back in a second before the half hour was up")
	}

	held.at = began.Add(For)
	if shut(book, caller) {
		t.Error("still shut out once the half hour was up")
	}

	if len(book.Lockouts()) != 0 {
		t.Error("an ended lockout is still listed")
	}

	// And they start again from nothing: one failure is one failure.
	if fail(book, caller) {
		t.Error("the first failure after a lockout ended shut them out again")
	}
}

// Different devices behind one address are different people, and one
// address is not made into many by the half of it a caller can rotate.
func TestWhoCountsAsTheSameCaller(t *testing.T) {
	cases := []struct {
		name     string
		other    Caller
		alsoShut bool
	}{
		{"the same address and device", At("203.0.113.9", chrome), true},
		{"the same address and another device", At("203.0.113.9", "Tomoshibi/0.1.0.8 (iPhone; iOS 27.0.1; iPhone17,1)"), false},
		{"the same address and no user agent", At("203.0.113.9", ""), false},
		{"another address and the same device", At("203.0.113.10", chrome), false},
		{"the address written as IPv4 inside IPv6", At("::ffff:203.0.113.9", chrome), true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			book, _ := booked(t, nil)
			caller := At("203.0.113.9", chrome)

			for i := 0; i <= Failures; i++ {
				fail(book, caller)
			}

			if got := shut(book, c.other); got != c.alsoShut {
				t.Errorf("%s shut out: %v, want %v", c.name, got, c.alsoShut)
			}
		})
	}
}

// A whole /64 is one subscriber, so walking through it is not a fresh count
// per address; and the next /64 is somebody else.
func TestAnIPv6NetworkIsOneCaller(t *testing.T) {
	cases := []struct {
		name  string
		other string
		shut  bool
	}{
		{"another address in the same /64", "2001:db8:1:2:ffff:ffff:ffff:fffe", true},
		{"an address in the next /64", "2001:db8:1:3::1", false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			book, _ := booked(t, nil)

			// Every failure from a different address in one /64.
			for i := 0; i <= Failures; i++ {
				fail(book, At(fmt.Sprintf("2001:db8:1:2::%x", i+1), chrome))
			}

			if got := shut(book, At(c.other, chrome)); got != c.shut {
				t.Errorf("%s shut out: %v, want %v", c.other, got, c.shut)
			}
		})
	}

	book, _ := booked(t, nil)
	for i := 0; i <= Failures; i++ {
		fail(book, At(fmt.Sprintf("2001:db8:1:2::%x", i+1), chrome))
	}

	listed := book.Lockouts()
	if len(listed) != 1 || listed[0].Address != "2001:db8:1:2::/64" {
		t.Fatalf("listed %+v, want one lockout of 2001:db8:1:2::/64", listed)
	}
	if listed[0].Seen != "2001:db8:1:2::b" {
		t.Errorf("seen at %q, want the last failure's own address", listed[0].Seen)
	}
}

func TestBothDoorsAreCountedTogether(t *testing.T) {
	book, _ := booked(t, nil)
	caller := At("203.0.113.9", chrome)

	for i := 0; i < 6; i++ {
		book.Failed(httptest.NewRecorder(), caller, Account, "rate_limited")
	}
	for i := 0; i < 4; i++ {
		book.Failed(httptest.NewRecorder(), caller, Management, "too_many_attempts")
	}

	if shut(book, caller) {
		t.Fatal("shut out after ten failures across the two doors")
	}

	recorder := httptest.NewRecorder()
	if !book.Failed(recorder, caller, Management, "too_many_attempts") {
		t.Fatal("the eleventh failure, at the second door, did not shut the caller out")
	}

	listed := book.Lockouts()
	if len(listed) != 1 {
		t.Fatalf("%d lockouts listed, want 1", len(listed))
	}
	if got := listed[0].Doors; len(got) != 2 || got[0] != Account || got[1] != Management {
		t.Errorf("doors %v, want both", got)
	}
	if listed[0].Failures != Failures+1 {
		t.Errorf("%d failures recorded, want %d", listed[0].Failures, Failures+1)
	}
}

// Nothing but the window and a lockout ends a count. The book has no way to
// be told of a success, so a door cannot clear a caller's failures by
// signing somebody in; that this is so at the doors is held in internal/app
// and internal/admin.
func TestOnlyTheWindowEndsACount(t *testing.T) {
	book, clock := booked(t, nil)
	caller := At("203.0.113.9", chrome)

	for i := 0; i < Failures; i++ {
		fail(book, caller)
	}

	clock.wait(Window - time.Second)

	if !fail(book, caller) {
		t.Error("the eleventh failure inside the window did not shut the caller out")
	}
}

// What a caller who is shut out is told: the reason the door already gives
// for too many attempts, how long, and nothing else.
func TestTheAnswerSaysHowLongAndNothingMore(t *testing.T) {
	book, held := booked(t, nil)
	caller := At("203.0.113.9", chrome)

	for i := 0; i <= Failures; i++ {
		fail(book, caller)
	}
	began := held.at
	held.wait(10 * time.Minute)

	recorder := httptest.NewRecorder()
	book.Shut(recorder, caller, "too_many_attempts")

	if recorder.Code != http.StatusTooManyRequests {
		t.Errorf("answered %d, want 429", recorder.Code)
	}
	if got := recorder.Header().Get("Retry-After"); got != "1200" {
		t.Errorf("Retry-After %q twenty minutes from the end, want 1200", got)
	}

	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("the answer was not readable: %v", err)
	}

	if body["error"] != "too_many_attempts" {
		t.Errorf("reason %v, want the door's own", body["error"])
	}
	if body["until"] != began.Add(For).Format(time.RFC3339) {
		t.Errorf("until %v, want %s", body["until"], began.Add(For).Format(time.RFC3339))
	}
	if len(body) != 3 {
		t.Errorf("the answer says more than the reason and how long: %v", body)
	}
}

func TestLiftingEndsALockoutAndItsCount(t *testing.T) {
	book, _ := booked(t, nil)
	caller := At("203.0.113.9", chrome)

	for i := 0; i <= Failures; i++ {
		fail(book, caller)
	}

	listed := book.Lockouts()
	if len(listed) != 1 {
		t.Fatalf("%d lockouts, want 1", len(listed))
	}

	lifted, found, err := book.Lift(listed[0].Key)
	if err != nil || !found || lifted.Address != "203.0.113.9" {
		t.Fatalf("Lift: %+v %v %v", lifted, found, err)
	}

	if shut(book, caller) {
		t.Error("still shut out after being let back in")
	}

	if fail(book, caller) {
		t.Error("one failure after being let back in shut them out again")
	}

	if _, found, _ := book.Lift(listed[0].Key); found {
		t.Error("a lockout was lifted twice")
	}
}

func TestLiftingEveryLockout(t *testing.T) {
	book, _ := booked(t, nil)

	for _, address := range []string{"203.0.113.1", "203.0.113.2", "203.0.113.3"} {
		for i := 0; i <= Failures; i++ {
			fail(book, At(address, chrome))
		}
	}

	lifted, err := book.LiftAll()
	if err != nil || len(lifted) != 3 {
		t.Fatalf("LiftAll: %d lifted, %v", len(lifted), err)
	}

	if len(book.Lockouts()) != 0 {
		t.Error("lockouts are left after lifting every one")
	}
}

func opened(t *testing.T, path string) *store.Store {
	t.Helper()

	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	return st
}

// A restart does not let anybody back in, and a lift is not undone by one.
func TestALockoutSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meet.db")
	caller := At("203.0.113.9", chrome)

	st := opened(t, path)
	book := New(st)
	for i := 0; i <= Failures; i++ {
		fail(book, caller)
	}
	st.Close()

	st = opened(t, path)
	book = New(st)

	if !shut(book, caller) {
		t.Fatal("a restart let the caller back in")
	}

	listed := book.Lockouts()
	if len(listed) != 1 || listed[0].Client == nil || listed[0].Client.Agent != chrome {
		t.Fatalf("read back %+v, want the lockout with its device", listed)
	}

	if _, found, err := book.Lift(listed[0].Key); err != nil || !found {
		t.Fatalf("Lift: %v %v", found, err)
	}
	st.Close()

	st = opened(t, path)
	defer st.Close()

	if shut(New(st), caller) {
		t.Error("a lifted lockout came back after a restart")
	}
}

func TestAnEndedLockoutIsNotReadBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meet.db")

	st := opened(t, path)
	defer st.Close()

	now := time.Now().UTC()
	caller := At("203.0.113.9", chrome)

	if err := st.KeepLockout(store.Lockout{
		Key: caller.key, Address: "203.0.113.9", Since: now.Add(-time.Hour), Until: now.Add(-time.Minute),
	}); err != nil {
		t.Fatalf("KeepLockout: %v", err)
	}

	if shut(New(st), caller) {
		t.Error("a lockout that ended while the server was down was read back as in force")
	}

	// Whether the read cleared it from the store is the store's own test
	// (internal/store/lockouts_test.go), asserted against the bucket: asked
	// here through the sweep, it passed for a store that cleared in neither.
}

// Many callers each failing once is the shape of an attack from many
// addresses, and it must not grow the book without end.
func TestTheBookIsBounded(t *testing.T) {
	book, held := booked(t, nil)

	for i := 0; i < capacity+500; i++ {
		fail(book, At(fmt.Sprintf("10.%d.%d.%d", i>>16&0xff, i>>8&0xff, i&0xff), chrome))
	}

	if got := len(book.counting); got > capacity {
		t.Errorf("%d callers counted, want at most %d", got, capacity)
	}

	// And once the window has passed, the next failure's sweep takes them.
	held.wait(Window + time.Minute)
	fail(book, At("192.0.2.1", chrome))

	if got := len(book.counting); got != 1 {
		t.Errorf("%d callers still counted a window later, want 1", got)
	}
}

func TestANilBookShutsNobodyOut(t *testing.T) {
	var book *Book
	caller := At("203.0.113.9", chrome)

	for i := 0; i <= Failures*2; i++ {
		if book.Failed(httptest.NewRecorder(), caller, Account, "rate_limited") {
			t.Fatal("a nil book shut somebody out")
		}
	}

	if book.Shut(httptest.NewRecorder(), caller, "rate_limited") || book.Lockouts() != nil {
		t.Error("a nil book holds a lockout")
	}

	book.Describe(nil)
	book.OnLock(nil)
}

// Fifty failures arriving at once from one caller are one lockout, begun
// once and written to the log once, however the scheduler orders them.
func TestFailuresArrivingTogetherBeginOneLockout(t *testing.T) {
	book := New(nil)
	caller := At("203.0.113.9", chrome)

	var begun atomic.Int64
	book.OnLock(func(store.Lockout) { begun.Add(1) })

	var all sync.WaitGroup
	for i := 0; i < 50; i++ {
		all.Add(1)
		go func() {
			defer all.Done()
			book.Failed(httptest.NewRecorder(), caller, Account, "rate_limited")
			book.Shut(httptest.NewRecorder(), caller, "rate_limited")
			book.Lockouts()
		}()
	}
	all.Wait()

	if got := begun.Load(); got != 1 {
		t.Errorf("%d lockouts begun, want 1", got)
	}
	if !shut(book, caller) {
		t.Error("not shut out after fifty failures")
	}
}

// The half hour runs from the failure that crossed the line, not from the
// first of them. The test above makes all eleven at one instant, where the
// two are the same; here they are spread across the window, so a lockout
// counted from the first would end almost five minutes early.
func TestTheHalfHourRunsFromTheEleventhFailure(t *testing.T) {
	book, held := booked(t, nil)
	caller := At("203.0.113.9", chrome)

	for i := 0; i < Failures; i++ {
		fail(book, caller)
		held.wait(29 * time.Second)
	}

	held.wait(Window - 10*29*time.Second - time.Second)
	eleventh := held.at

	if !fail(book, caller) {
		t.Fatal("the eleventh failure inside the window did not shut the caller out")
	}

	listed := book.Lockouts()
	if len(listed) != 1 || !listed[0].Until.Equal(eleventh.Add(For)) || !listed[0].Since.Equal(eleventh) {
		t.Fatalf("lockouts %+v, want one from %v until %v", listed, eleventh, eleventh.Add(For))
	}

	held.at = eleventh.Add(For - time.Second)
	if !shut(book, caller) {
		t.Error("let back in a second before half an hour after the eleventh failure")
	}
}

// failingLift is a store that will not let go of a lockout.
type failingLift struct{ held []store.Lockout }

func (f *failingLift) KeepLockout(one store.Lockout) error {
	f.held = append(f.held, one)
	return nil
}

func (f *failingLift) Lockouts(time.Time) ([]store.Lockout, error) { return f.held, nil }

func (f *failingLift) LiftLockout(string) (bool, error) {
	return false, fmt.Errorf("the disk is full")
}

// A lift the store would not write is no lift. Lifted in memory first, the
// caller would be let in until the next restart read the lockout back, and
// the page would have said it was lifted.
func TestALiftTheStoreRefusesLiftsNothing(t *testing.T) {
	kept := &failingLift{}
	book, _ := booked(t, kept)
	caller := At("203.0.113.9", chrome)

	for i := 0; i <= Failures; i++ {
		fail(book, caller)
	}

	listed := book.Lockouts()
	if len(listed) != 1 {
		t.Fatalf("%d lockouts, want 1", len(listed))
	}

	if _, found, err := book.Lift(listed[0].Key); err == nil || found {
		t.Fatalf("a lift the store refused answered found=%v err=%v, want the store's error", found, err)
	}

	if !shut(book, caller) {
		t.Error("a lift the store refused let the caller back in")
	}
	if len(book.Lockouts()) != 1 {
		t.Error("a lift the store refused took the lockout off the list")
	}
}
