package guess

import (
	"strconv"
	"testing"
	"time"
)

/*
 * The limiter is the whole defence against a passphrase somebody thought of
 * rather than generated. Fifty bits is out of reach at any rate; a dictionary
 * is not, and what stands between the two is the number below.
 */

func TestGuessingIsBoundedPerCaller(t *testing.T) {
	limit := New()

	for i := 0; i < PerAddress; i++ {
		if !limit.Allow("10.0.0.1") {
			t.Fatalf("refused after %d attempts, before the limit of %d", i, PerAddress)
		}
		limit.Failed("10.0.0.1")
	}

	if limit.Allow("10.0.0.1") {
		t.Error("guessing continued past the per-caller limit")
	}
}

func TestGuessingIsBoundedEvenFromManyAddresses(t *testing.T) {
	limit := New()

	// A budget per caller is not a limit: an attacker chooses how many callers
	// to be, and a thousand hosts is a thousand budgets. The ceiling on the
	// endpoint as a whole is what has no give in it.
	for i := 0; i < Overall; i++ {
		caller := string(rune('a'+i%26)) + string(rune('a'+i/26))
		limit.Failed(caller)
	}

	if limit.Allow("a caller that has never tried before") {
		t.Error("a fresh address was let through after the endpoint's own ceiling")
	}
}

func TestSucceedingCostsNothing(t *testing.T) {
	limit := New()

	// Only failures are counted. Somebody who signs in has proved they are not
	// guessing, and charging them for it makes an administrator's day harder
	// than an attacker's.
	for i := 0; i < PerAddress*3; i++ {
		if !limit.Allow("10.0.0.2") {
			t.Fatal("an address that never failed was refused")
		}
	}
}

func TestABudgetRefills(t *testing.T) {
	limit := New()

	for i := 0; i < PerAddress; i++ {
		limit.Failed("10.0.0.3")
	}

	if limit.Allow("10.0.0.3") {
		t.Fatal("guessing continued past the limit")
	}

	// The bucket returns a token every six seconds, so nothing is forgiven at
	// once and a caller is never locked out for good. Advanced by hand rather
	// than waited for: a test that sleeps six seconds is a test somebody skips.
	limit.mu.Lock()
	limit.byCaller["10.0.0.3"].limiter.AllowN(time.Now().Add(time.Minute), 0)
	limit.mu.Unlock()

	if !limit.Allow("10.0.0.3") {
		t.Error("a caller was still refused a minute after their last attempt")
	}
}

func TestCallersAreForgotten(t *testing.T) {
	limit := New()

	// A script cycling through addresses is what this guards against, so the
	// test is that shape: many callers, each failing once and never returning.
	// Counting what is held afterwards is the only assertion that fails when
	// the sweep is removed — checking one absent key passes whether the others
	// were dropped or not.
	const strangers = 200

	for i := 0; i < strangers; i++ {
		limit.Failed(strconv.Itoa(i))
	}

	// Aged by moving the clock the sweep reads rather than by rewriting each
	// entry against `idle`: rewriting them relative to the constant makes the
	// test pass whatever that constant is, including a value that would keep
	// every caller for ever.
	limit.mu.Lock()
	stale := time.Now().Add(-24 * time.Hour)
	for _, held := range limit.byCaller {
		held.seen = stale
	}
	limit.swept = time.Now().Add(-2 * time.Minute)
	limit.mu.Unlock()

	limit.Failed("somebody still trying")

	limit.mu.Lock()
	held := len(limit.byCaller)
	limit.mu.Unlock()

	if held > 1 {
		t.Errorf("%d callers held after all but one aged out; the map grows without bound", held)
	}
}

/*
The name is not decoration on the sign-in form.

Without it, every attempt is checked against every administrator at once, so a
list of leaked passphrases run at this endpoint succeeds if any one person on the
deployment has ever reused one — and it succeeds without the attacker having to
know that anybody exists. With it, a guess has to be aimed at somebody: one pool
becomes as many separate pools as there are administrators.

The compatibility case is the one that would rot quietly. An administrator with
no name recorded is matched by passphrase alone, because refusing them would lock
out any deployment upgrading into this — and a test that only covered the happy
path would let somebody later "tidy up" that branch and take the deployment with
it.
*/

// Guesses sent all at once used to pass together: each asked whether a token
// was left and was charged only after it had been judged, so every one that
// arrived in between saw the same untouched bucket. An attempt in flight now
// holds its place, so the one past the limit is refused while the others are
// still being judged.
func TestAttemptsInFlightHoldTheirPlace(t *testing.T) {
	limit := New()

	for i := 0; i < PerAddress; i++ {
		if _, ok := limit.Take("10.0.0.9"); !ok {
			t.Fatalf("refused after %d attempts in flight, before the limit of %d", i, PerAddress)
		}
	}

	if _, ok := limit.Take("10.0.0.9"); ok {
		t.Error("an attempt past the per-caller limit was let through while the others were undecided")
	}
}

func TestAttemptsInFlightHoldTheCeilingToo(t *testing.T) {
	limit := New()

	for i := 0; i < Overall; i++ {
		if _, ok := limit.Take(strconv.Itoa(i)); !ok {
			t.Fatalf("refused after %d callers in flight, before the ceiling of %d", i, Overall)
		}
	}

	if _, ok := limit.Take("a caller that has never tried before"); ok {
		t.Error("a fresh caller was let through past the ceiling while the others were undecided")
	}
}

// Settling is deferred the moment an attempt is taken, so it runs after Failed
// as well as instead of it. A second release would hand back a place that was
// never taken; a missing one holds a place for ever, and enough of those shut
// the door on everybody.
func TestAnAttemptIsReleasedExactlyOnce(t *testing.T) {
	limit := New()

	for i := 0; i < PerAddress*3; i++ {
		attempt, ok := limit.Take("10.0.0.10")
		if !ok {
			t.Fatalf("a caller who never failed was refused on attempt %d", i+1)
		}
		attempt.Settled()
		attempt.Settled()
	}

	for i := 0; i < PerAddress; i++ {
		attempt, ok := limit.Take("10.0.0.11")
		if !ok {
			t.Fatalf("refused after %d failures, before the limit of %d", i, PerAddress)
		}
		attempt.Failed()
		attempt.Settled()
	}

	if _, ok := limit.Take("10.0.0.11"); ok {
		t.Error("failures followed by a deferred Settled were given back")
	}
	if limit.pending != 0 {
		t.Errorf("%d attempts are still held after every one was settled", limit.pending)
	}
}

// A deployment without administrators has no limiter, and every door asks it
// anyway.
func TestNoLimiterLetsEverythingThrough(t *testing.T) {
	var limit *Attempts

	attempt, ok := limit.Take("10.0.0.12")
	if !ok {
		t.Fatal("a nil limiter refused")
	}
	attempt.Failed()
	attempt.Settled()
}
