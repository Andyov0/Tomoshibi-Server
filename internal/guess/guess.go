// Package guess bounds how fast a passphrase can be tried.
//
// Its own package because more than one door takes a passphrase and every one
// of them has to be bounded. A limit on the management sign-in and none on the
// room join is not two limits, it is none: the same secret is checked at both,
// and an attacker uses whichever is cheaper. This deployment had exactly that —
// ten a minute at one door and ten a second with no ceiling at the other,
// sixty times the rate, and the second door answered the same question.
//
// Bounded, and no longer shared. The doors once drew on one budget, so that an
// attacker could not move to whichever was still open, and the cost of that
// was the reverse: whatever spent the join's budget shut the management
// sign-in, the account sign-in and the enrolment as well. The join is where
// ordinary traffic arrives with a passphrase, so ordinary traffic was enough,
// and a page anywhere could make visitors' browsers send the rest. Each door
// now has its own, sized for what arrives at it, which an attacker can add
// together at worst — a few times the rate of one door, against the whole
// deployment's sign-in shut by a busy hour.
package guess

import (
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// How hard the sign-in may be pushed.
//
// Far tighter than the join endpoint, and deliberately so. Joining is something
// people do; signing in as an administrator is something one person does
// occasionally and an attacker does continuously, and the two do not deserve the
// same allowance.
//
// The numbers come from what they have to defeat. A generated passphrase is
// fifty bits and out of reach at any rate, but nothing here can tell a generated
// passphrase from one somebody thought of, and against the second kind the rate
// is the whole defence. Ten a minute leaves a dictionary of ten million taking
// nineteen centuries.
//
// Expressed as a bucket that refills rather than as a count inside a window,
// because that is what the rest of this server already uses and one idea is
// cheaper to hold than two. The shapes differ slightly — a window forgives all
// ten at once where a bucket returns them one at a time — and for a limit whose
// job is to make guessing slow, returning them gradually is if anything the
// better behaviour.
// PerAddress and Overall are exported so a test can assert the numbers rather
// than a behaviour that happens to follow from them.
const (
	PerAddress = 10
	Overall    = 30
)

// idle is how long a caller's bucket is kept after it was made or last failed.
//
// Swept on write rather than on a timer, which keeps it free when nobody is
// trying.
const idle = 10 * time.Minute

// Join is the ceiling on the join, which is wider than the others because the
// join is where people arrive: everybody whose passphrase it has not seen
// before from their browser is charged once, and a meeting starting on the
// hour is thirty of those in a minute on its own.
const Join = 60

// Attempts bounds failed guesses, by address and in total.
//
// In total as well as by address, because by address alone is not a limit. The
// budget is per caller and an attacker chooses how many callers to be: a
// thousand hosts is a thousand budgets, and the guessing rate rises with the
// price of renting them. A ceiling on the whole endpoint has no such give.
//
// The cost of that ceiling is that a determined stranger can lock out the
// administrator. That is the right way round: this door being shut for a minute
// is an inconvenience, and it being open is the end of every other control.
type Attempts struct {
	mu       sync.Mutex
	byCaller map[string]*budget
	all      *rate.Limiter
	// pending is how many attempts are between Take and their outcome, across
	// every caller. It is held against the ceiling as if already spent.
	pending int
	swept   time.Time

	// perCaller is each caller's allowance, PerAddress unless NewWith said.
	perCaller int
}

type budget struct {
	limiter *rate.Limiter
	pending int
	seen    time.Time
}

func New() *Attempts {
	return NewWith(PerAddress, Overall)
}

// NewWith is a budget of the given sizes, a minute each.
func NewWith(perAddress, overall int) *Attempts {
	perMinute := rate.Limit(time.Minute / time.Second)

	return &Attempts{
		byCaller:  make(map[string]*budget),
		all:       rate.NewLimiter(rate.Limit(overall)/perMinute, overall),
		perCaller: perAddress,
	}
}

// callerOf is the key a caller's budget is kept under.
//
// An IPv6 address is counted by its /64, which is what one subscriber is handed:
// counted whole, a single host could be eighteen quintillion callers, each with
// a fresh allowance.
func callerOf(caller string) string {
	address, err := netip.ParseAddr(caller)
	if err != nil {
		return caller
	}

	address = address.Unmap()
	if address.Is4() {
		return address.String()
	}

	prefix, err := address.Prefix(64)
	if err != nil {
		return caller
	}

	return prefix.String()
}

// Subscriber is the part of an address a caller is counted by: an IPv4
// address whole, and an IPv6 address by its /64.
//
// Exported for the sign-in lockout (internal/lockout), which shuts callers out
// by the same rule. Two rules for which addresses are one caller would be two
// answers to the same question, and the looser of them is the one an attacker
// would find.
func Subscriber(caller string) string {
	return callerOf(caller)
}

// Attempt is one guess between being let through and being decided.
type Attempt struct {
	of     *Attempts
	caller *budget
	done   bool
}

// Take lets one attempt through if both budgets can afford it failing.
//
// The check and the hold happen under one lock, and that is the point of it.
// Every door used to ask Allow and charge Failed afterwards, once the
// passphrase had been judged, so every request arriving between the two saw the
// same untouched bucket: a thousand concurrent guesses all passed a check of
// thirty a minute overall, and each minute could buy another thousand. Now an
// attempt in flight counts against both budgets until it is decided, and the
// thirty-first concurrent one is refused before it is judged. Found by a review
// of the sign-in; the join, the account sign-in and both enrolment endpoints had
// the same gap because they share this budget.
//
// Held rather than spent, because a successful sign-in should cost nothing:
// somebody who proves who they are has demonstrated they were not guessing, and
// charging them for it makes an administrator's day harder than an attacker's.
// A token bucket cannot be given a token back -- rate.Reservation.Cancel
// restores nothing once an immediate reservation has taken effect -- so the hold
// lives beside the bucket rather than in it.
//
// A nil Attempts lets everything through, which is what a deployment with no
// administrators has always done.
func (a *Attempts) Take(caller string) (*Attempt, bool) {
	if a == nil {
		return nil, true
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	a.sweep(now)

	held := a.budgetOf(callerOf(caller), now)
	if held.limiter.TokensAt(now)-float64(held.pending) < 1 || a.all.TokensAt(now)-float64(a.pending) < 1 {
		return nil, false
	}

	held.pending++
	a.pending++

	return &Attempt{of: a, caller: held}, true
}

// Failed spends what the attempt was holding.
func (t *Attempt) Failed() {
	if t == nil {
		return
	}

	t.of.mu.Lock()
	defer t.of.mu.Unlock()

	if t.release() {
		now := time.Now()
		t.caller.seen = now
		t.caller.limiter.AllowN(now, 1)
		t.of.all.AllowN(now, 1)
	}
}

// Settled lets go of whatever the attempt still holds, spending nothing.
//
// Safe to call after Failed and more than once, so that a door can defer it the
// moment it takes an attempt. That is the guard that matters: an attempt nobody
// settles is held for ever, and enough of those refuse every caller for good, so
// no early return between Take and the verdict may be able to leak one.
func (t *Attempt) Settled() {
	if t == nil {
		return
	}

	t.of.mu.Lock()
	defer t.of.mu.Unlock()

	t.release()
}

// release gives the hold back once, reporting whether this was that once.
func (t *Attempt) release() bool {
	if t.done {
		return false
	}
	t.done = true
	t.caller.pending--
	t.of.pending--

	return true
}

// Allow reports whether an attempt could be taken now, without taking one.
//
// Kept for tests and for anything that only needs to ask. A door that goes on
// to judge a passphrase must use Take, for the reason given there.
func (a *Attempts) Allow(caller string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	held, known := a.byCaller[callerOf(caller)]
	if known && held.limiter.TokensAt(now)-float64(held.pending) < 1 {
		return false
	}

	return a.all.TokensAt(now)-float64(a.pending) >= 1
}

// Failed charges a failure that was never taken as an attempt.
func (a *Attempts) Failed(caller string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	a.sweep(now)

	held := a.budgetOf(callerOf(caller), now)
	held.seen = now
	held.limiter.AllowN(now, 1)
	a.all.AllowN(now, 1)
}

// budgetOf is the caller's bucket, made on first use. Called under the lock.
func (a *Attempts) budgetOf(caller string, now time.Time) *budget {
	held, known := a.byCaller[caller]
	if !known {
		per := a.perCaller
		if per == 0 {
			per = PerAddress
		}

		perMinute := rate.Limit(time.Minute / time.Second)
		held = &budget{limiter: rate.NewLimiter(rate.Limit(per)/perMinute, per), seen: now}
		a.byCaller[caller] = held
	}

	return held
}

// sweep drops callers who have not failed in a while, so that a script cycling
// through addresses cannot grow the map without bound.
func (a *Attempts) sweep(now time.Time) {
	if now.Sub(a.swept) < time.Minute {
		return
	}
	a.swept = now

	for caller, held := range a.byCaller {
		// One still being judged is not idle, however long the judging takes.
		if held.pending == 0 && now.Sub(held.seen) > idle {
			delete(a.byCaller, caller)
		}
	}
}

func trimSpace(s string) string {
	return strings.TrimSpace(s)
}
