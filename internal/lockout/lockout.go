// Package lockout shuts the sign-in doors on a caller who keeps getting the
// passphrase wrong.
//
// The guessing budgets (internal/guess) make guessing slow — ten a minute from
// one address, thirty a minute across a door — and never make it stop. To the
// person they hold back they say nothing they can act on: an attempt refused
// now is let through a few seconds later, so a script carries on at the
// budget's rate for as long as it likes. The owner asked (2026-11-01) for what a
// fail2ban would do instead: more than ten failed sign-ins inside five minutes
// from one address and one device, and that caller is shut out for half an
// hour; no human check, because the apps have nowhere to show one; and an
// administrator can let them back in from the management pages.
//
// What is counted is a passphrase that did not match, at either sign-in: the
// account sign-in, which the web page and every app use, and the management
// sign-in. Together, because they check the same credentials — the account
// sign-in accepts an administrator's name and passphrase — and an attacker who
// was counted at each separately would simply take twenty at the two. Not
// counted: a blocked account, which was the right passphrase; a request that
// offered no passphrase at all, which is a malformed body rather than a guess;
// and a refused human check, which never reached the passphrase. Counting any
// of those would shut people out for something that tells nobody anything
// about whether they are guessing.
//
// Who is shut out is an address and a device together, never an address
// alone. An address is very often many people — an office, a campus, a mobile
// carrier's NAT — and shutting the address would let one person's typos, or one
// attacker, lock out everybody behind it for half an hour. The device half is
// the user agent, which the caller writes, so an attacker can vary it and start
// a fresh count; what holds them then is the guessing budget, which is by
// address alone and stays exactly as it was. The two do different jobs: the
// budget bounds the attacker's rate, and this ends a run of failures without
// punishing the neighbours.
//
// A sign-in that succeeds clears nothing. The count is failures inside the
// window, as the owner's rule and a fail2ban both have it, and a success in
// the middle of them does not make them fewer. It used to clear the count,
// and that was a way past the rule for anybody with an account: a review
// failed ten times at an administrator's name, signed in to its own account
// from the same address and device, failed ten more at the management
// sign-in, and was never shut out. Clearing only the failures made under the
// name that then succeeded was considered and not taken. The management
// sign-in matches an administrator with no name under any name, and the
// account sign-in matches an administrator by the name an account may also
// have, so which passphrase a failure was a guess at is not something the
// name says. What a success clearing nothing costs is somebody who fails
// ten times, gets it right, and fails once more inside the same five
// minutes, which is the rule as it was given.
//
// The address is the one the limits are charged by (limit.Caller), grouped the
// way the budget groups it (guess.Subscriber): an IPv6 address by its /64,
// since a /64 is what one subscriber is handed and counting its addresses apart
// would let one machine walk through eighteen quintillion fresh counts.
//
// A caller who is shut out is answered before anything else: before the body
// is read, before any human check, before the guessing budget is asked and
// before any passphrase is judged. So a lockout spends nothing, costs nothing,
// and refuses a correct passphrase exactly as it refuses a wrong one — which is
// also why the answer cannot say whether the name exists. It is the 429 and the
// reason each door already gave for too many attempts, so an app that has never
// heard of this says what it already says, with a Retry-After and the end of
// the lockout for anything that can say more.
//
// The join is not a sign-in and counts nothing, but it asks too. The identity
// it hands back is the signature a passphrase makes, and signatures are shown
// beside every name in every room, so for anybody whose signature is known a
// join with a guess is a sign-in without a name. A caller who is shut out is
// refused a passphrase there, with the same answer, unless their browser has
// joined with that passphrase before; a join without one goes on as always.
//
// The counts are in memory and are lost with a restart, which costs an
// attacker's progress and nothing else. The lockouts are in the store, because
// a restart that lifted every one of them would hand each caller a fresh
// allowance every time the deployment was restarted.
package lockout

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/guess"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/store"
)

// The rule, as the owner gave it: more than Failures failed sign-ins within
// Window from one caller, and that caller is shut out for For.
//
// More than, so the eleventh failure inside five minutes is the one that does
// it. Constants rather than configuration, because nobody has asked to change
// them and a setting is a thing that has to be explained, checked at startup
// and tested at every value somebody might type. Exported so a test can assert
// the numbers rather than a behaviour that happens to follow from them.
const (
	Failures = 10
	Window   = 5 * time.Minute
	For      = 30 * time.Minute
)

// The doors, as a lockout records which of them its failures were at.
const (
	Account    = "account"
	Management = "management"
)

// capacity is how many callers' counts are held at once.
//
// Never reached by the budgets as they stand: every failure counted here has
// already been let through a guessing budget whose ceiling across the door is
// thirty a minute, so the two doors together cannot produce more than a few
// hundred callers with a failure inside one window. The cap is there so that
// remains true if a budget is ever loosened, rather than resting on it.
const capacity = 10_000

// Kept is where lockouts are written down. The store, or nil where there is
// none, in which case they last as long as the process.
type Kept interface {
	KeepLockout(lockout store.Lockout) error
	Lockouts(now time.Time) ([]store.Lockout, error)
	LiftLockout(key string) (bool, error)
}

// Caller is who a sign-in came from, as this package counts them.
type Caller struct {
	// address is exactly where the request came from, and network what it is
	// counted under (see guess.Subscriber).
	address string
	network string
	agent   string
	key     string
}

// Of is the caller a request came from, resolved behind hops proxies the way
// every other limit here resolves it.
func Of(r *http.Request, hops int) Caller {
	return At(limit.Caller(r, hops), r.UserAgent())
}

// agentHeld is how much of a user agent a caller is known by.
//
// The agent is the caller's to write and has no length but the server's
// header limit, a megabyte by default, and whatever is kept of it is kept in
// the count, the store, every listing the page polls and the line the
// lockout writes to the log. Unbounded, one caller sending a 900-kilobyte
// agent put 900 kilobytes into each: the listing the page asks for every
// fifteen seconds was a megabyte per lockout. Cut once, here, before any of
// those see it. Two agents alike for this long are one device, which buys an
// attacker nothing, since a different first byte was always a fresh count.
const agentHeld = 512

// At is the caller at an address saying a user agent.
func At(address, agent string) Caller {
	if len(agent) > agentHeld {
		// Cut at a byte count, then rid of any character the cut split.
		agent = strings.ToValidUTF8(agent[:agentHeld], "")
	}

	network := guess.Subscriber(address)

	return Caller{address: address, network: network, agent: agent, key: keyOf(network, agent)}
}

// keyOf is a lockout's key: a digest of the address and the device together.
//
// A digest rather than the two side by side, so that it can stand in a path —
// an IPv6 network has a slash in it and a user agent has everything — and so
// that a user agent of any length is a key of one length.
func keyOf(network, agent string) string {
	sum := sha256.Sum256([]byte(network + "\x00" + agent))

	return hex.EncodeToString(sum[:16])
}

// tally is one caller's recent failures.
type tally struct {
	// recent is the failures still inside the window, oldest first.
	recent []time.Time
	// first and total are since the count began, which is the caller's first
	// failure after their last lockout or quiet spell.
	first time.Time
	total int
	last  time.Time
	doors []string
	// seen and agent are the last failure's exact address and user agent.
	seen  string
	agent string
}

// Book holds the counts and the lockouts.
//
// A nil Book shuts nobody out and counts nothing, which is what a deployment
// with no management side has always done, and what the tests that build the
// doors by hand get.
type Book struct {
	mu       sync.Mutex
	counting map[string]*tally
	shut     map[string]store.Lockout
	swept    time.Time

	kept     Kept
	describe func(agent string) *store.Client
	locked   func(store.Lockout)
	now      func() time.Time
}

// New builds a book, reading back whatever lockouts kept still holds.
func New(kept Kept) *Book {
	book := &Book{
		counting: make(map[string]*tally),
		shut:     make(map[string]store.Lockout),
		kept:     kept,
		now:      time.Now,
	}

	if kept != nil {
		held, err := kept.Lockouts(book.now().UTC())
		if err != nil {
			// Said loudly and carried on with none. A store that cannot be read
			// at startup has bigger problems than half an hour of lockouts, and
			// refusing to start over it would be turning one broken thing into
			// an outage.
			slog.Error("failed to read back the sign-in lockouts; starting with none", "error", err)
		}

		for _, one := range held {
			book.shut[one.Key] = one
		}
	}

	return book
}

// Describe says how a user agent is read into a device for the page: the
// same reading the joins are given (internal/app/device.go), which lives in a
// package this one cannot import.
func (b *Book) Describe(describe func(agent string) *store.Client) {
	if b != nil {
		b.describe = describe
	}
}

// OnLock is told of every lockout as it begins, which is how each one reaches
// the management log.
func (b *Book) OnLock(locked func(store.Lockout)) {
	if b != nil {
		b.locked = locked
	}
}

// Shut answers a caller who is shut out, and reports whether it did.
//
// The first thing a door asks. A door that gets true has answered and must do
// nothing more.
func (b *Book) Shut(w http.ResponseWriter, caller Caller, reason string) bool {
	if b == nil {
		return false
	}

	now := b.now().UTC()

	b.mu.Lock()
	lockout, shut := b.lockoutOf(caller.key, now)
	b.mu.Unlock()

	if shut {
		refuse(w, lockout.Until, now, reason)
	}

	return shut
}

// Failed counts one passphrase that did not match, and answers the caller if
// it was the failure that shut them out.
//
// The failure that crosses the line is answered as a lockout rather than as a
// wrong passphrase, so the person is told at once that waiting is the only
// thing left to do, rather than on their next try. It was still a wrong
// passphrase, so the answer gives nothing away. A door that gets true has
// answered and must do nothing more.
func (b *Book) Failed(w http.ResponseWriter, caller Caller, door, reason string) bool {
	if b == nil {
		return false
	}

	now := b.now().UTC()

	b.mu.Lock()

	b.sweep(now)

	// Already shut out by a failure that finished while this one was being
	// judged, which is a race of two requests and not a second lockout.
	if lockout, shut := b.lockoutOf(caller.key, now); shut {
		b.mu.Unlock()
		refuse(w, lockout.Until, now, reason)

		return true
	}

	held, known := b.counting[caller.key]
	if !known {
		if len(b.counting) >= capacity {
			b.makeRoom(now)
		}

		held = &tally{first: now}
		b.counting[caller.key] = held
	}

	held.recent = inWindow(held.recent, now)
	if len(held.recent) == 0 {
		// Nothing left inside the window is a quiet spell, and the run that
		// follows is a new one: what a lockout says about it — when it began,
		// how many, at which sign-in — is about that run alone. The sweep
		// drops a count gone quiet, but at most once a minute, and a count it
		// had not reached yet carried its old failures into the next
		// lockout's record: three at the management sign-in at noon and
		// eleven at the account sign-in after five past were written down as
		// fourteen, from noon, at both.
		held.first, held.total, held.doors = now, 0, nil
	}

	held.recent = append(held.recent, now)
	held.total++
	held.last = now
	held.seen = caller.address
	held.agent = caller.agent
	if !has(held.doors, door) {
		held.doors = append(held.doors, door)
		sort.Strings(held.doors)
	}

	if len(held.recent) <= Failures {
		b.mu.Unlock()
		return false
	}

	lockout := store.Lockout{
		Key:      caller.key,
		Address:  caller.network,
		Seen:     caller.address,
		Client:   b.clientOf(caller.agent),
		First:    held.first,
		Last:     held.last,
		Since:    now,
		Until:    now.Add(For),
		Failures: held.total,
		Doors:    append([]string(nil), held.doors...),
	}

	delete(b.counting, caller.key)
	b.shut[caller.key] = lockout

	// Written under the lock, so that a lift arriving in the same instant
	// cannot remove it from memory and then have this put it back in the store
	// for the next start to read. A lockout begins rarely; holding the lock
	// for one write is nothing.
	if b.kept != nil {
		if err := b.kept.KeepLockout(lockout); err != nil {
			slog.Error("failed to keep a sign-in lockout; it holds until the server restarts",
				"address", lockout.Address, "error", err)
		}
	}

	locked := b.locked
	b.mu.Unlock()

	if locked != nil {
		locked(lockout)
	}

	refuse(w, lockout.Until, now, reason)

	return true
}

// Lockouts is every lockout in force, newest first.
func (b *Book) Lockouts() []store.Lockout {
	if b == nil {
		return nil
	}

	now := b.now().UTC()

	b.mu.Lock()
	defer b.mu.Unlock()

	b.sweep(now)

	list := make([]store.Lockout, 0, len(b.shut))
	for _, one := range b.shut {
		if one.Live(now) {
			list = append(list, one)
		}
	}

	sort.Slice(list, func(i, j int) bool {
		if !list[i].Since.Equal(list[j].Since) {
			return list[i].Since.After(list[j].Since)
		}
		return list[i].Key < list[j].Key
	})

	return list
}

// Lift ends one lockout early, saying what it was and whether there was one.
//
// The store first, and memory only once the store has let go of it. The other
// way round, a store that would not write would leave a lockout lifted on the
// page and back in force at the next restart, which is a lift that silently
// did not happen.
func (b *Book) Lift(key string) (store.Lockout, bool, error) {
	if b == nil {
		return store.Lockout{}, false, nil
	}

	now := b.now().UTC()

	b.mu.Lock()
	defer b.mu.Unlock()

	lockout, shut := b.lockoutOf(key, now)
	if !shut {
		return store.Lockout{}, false, nil
	}

	if b.kept != nil {
		if _, err := b.kept.LiftLockout(key); err != nil {
			return store.Lockout{}, false, err
		}
	}

	// There is no count to clear beside it. The failure that began the
	// lockout dropped the count, and nothing is counted while one holds, so a
	// caller let back in starts from nothing already.
	delete(b.shut, key)

	return lockout, true, nil
}

// LiftAll ends every lockout in force, saying which it ended. One that the
// store would not let go of is left, and the error says so.
func (b *Book) LiftAll() ([]store.Lockout, error) {
	var lifted []store.Lockout

	for _, one := range b.Lockouts() {
		lockout, found, err := b.Lift(one.Key)
		if err != nil {
			return lifted, err
		}
		if found {
			lifted = append(lifted, lockout)
		}
	}

	return lifted, nil
}

// lockoutOf is the lockout in force on a key, dropping one that has ended.
// Called under the lock.
func (b *Book) lockoutOf(key string, now time.Time) (store.Lockout, bool) {
	lockout, held := b.shut[key]
	if !held {
		return store.Lockout{}, false
	}

	if !lockout.Live(now) {
		delete(b.shut, key)
		return store.Lockout{}, false
	}

	return lockout, true
}

// sweep drops counts nobody has added to inside the window and lockouts that
// have ended, at most once a minute, the way internal/limit sweeps its
// budgets. Called under the lock.
//
// The lockouts in the store are left for the sweep of the store, which runs on
// its own timer (store.SweepLockouts); one past its end is ignored by
// everything that reads it in the meantime.
func (b *Book) sweep(now time.Time) {
	if now.Sub(b.swept) < time.Minute {
		return
	}
	b.swept = now

	b.drop(now)
}

func (b *Book) drop(now time.Time) {
	for key, held := range b.counting {
		if now.Sub(held.last) >= Window {
			delete(b.counting, key)
		}
	}

	for key, one := range b.shut {
		if !one.Live(now) {
			delete(b.shut, key)
		}
	}
}

// makeRoom frees a place for a new count when the book is full: whatever the
// window has let go of, and if that is nothing, the count added to longest
// ago. The newest counts are the ones a live attack is building, so they are
// the ones kept. Called under the lock.
func (b *Book) makeRoom(now time.Time) {
	b.drop(now)

	if len(b.counting) < capacity {
		return
	}

	var oldest string
	var at time.Time

	for key, held := range b.counting {
		if oldest == "" || held.last.Before(at) {
			oldest, at = key, held.last
		}
	}

	delete(b.counting, oldest)
}

// clientOf is the device a user agent describes, or the agent itself, cut
// short, where nothing has said how to read one.
func (b *Book) clientOf(agent string) *store.Client {
	if b.describe != nil {
		return b.describe(agent)
	}

	if agent == "" {
		return &store.Client{Kind: "other"}
	}

	if len(agent) > 256 {
		agent = strings.ToValidUTF8(agent[:256], "")
	}

	return &store.Client{Kind: "other", Agent: agent}
}

// inWindow is the failures a window ending now still holds.
func inWindow(at []time.Time, now time.Time) []time.Time {
	from := 0
	for from < len(at) && now.Sub(at[from]) >= Window {
		from++
	}

	return append(at[:0], at[from:]...)
}

func has(list []string, one string) bool {
	for _, held := range list {
		if held == one {
			return true
		}
	}

	return false
}

// refuse is the answer a caller who is shut out is given.
//
// The status and the reason are the ones the door already gives for too many
// attempts, so the apps released before this, which read only the reason, say
// the sentence they already have. Until and Retry-After are for whatever can
// say how long: the web pages put the minutes in the sentence.
func refuse(w http.ResponseWriter, until, now time.Time, reason string) {
	wait := int(math.Ceil(until.Sub(now).Seconds()))
	if wait < 1 {
		wait = 1
	}

	w.Header().Set("Retry-After", strconv.Itoa(wait))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)

	_ = json.NewEncoder(w).Encode(struct {
		Error      string `json:"error"`
		Until      string `json:"until"`
		RetryAfter int    `json:"retryAfter"`
	}{reason, until.UTC().Format(time.RFC3339), wait})
}
