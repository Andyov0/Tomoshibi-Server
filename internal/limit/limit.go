// Package limit bounds how fast rooms can be asked for.
//
// A room exists because somebody named it, so asking to join one that nobody is
// using succeeds exactly like asking to join one that is busy. There is no
// failure to count and no lockout to trip: the only thing standing between a
// script and somebody else's meeting is how many names it can try per second,
// and that number is set here.
package limit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// idle is how long a caller's budget is kept after their last request.
//
// Long enough that a real person's budget survives a pause in a meeting, short
// enough that a script cycling through addresses cannot grow the map without
// bound. Sweeping on write rather than on a timer keeps this free when nothing
// is happening.
const idle = 10 * time.Minute

type budget struct {
	limiter *rate.Limiter
	seen    time.Time
}

// Limiter charges requests against a per-caller budget.
type Limiter struct {
	rate  rate.Limit
	burst int
	hops  int

	mu       sync.Mutex
	budgets  map[string]*budget
	lastKeep time.Time
}

// New builds a limiter allowing perSecond requests a second, bursting to burst.
//
// The burst is what carries a meeting: thirty people opening the same link at
// the top of the hour arrive together, and a limit describing only the steady
// rate would turn that into a queue.
//
// Hops is how many proxies in front append to X-Forwarded-For, and zero means
// the header is not believed; see Caller.
func New(perSecond float64, burst int, hops int) *Limiter {
	return &Limiter{
		rate:     rate.Limit(perSecond),
		burst:    burst,
		hops:     hops,
		budgets:  make(map[string]*budget),
		lastKeep: time.Now(),
	}
}

// Allow charges one request, reporting whether it is within budget.
func (l *Limiter) Allow(r *http.Request) bool {
	return l.AllowKey(l.client(r))
}

// AllowKey charges one request to a budget named by the caller rather than by
// the address it came from.
//
// For the doors that have somebody to charge besides an address. An invitation
// to test the iOS app is asked for by an account, and charging the address
// alone would let one account spend from every network it can reach, while
// charging the account alone would let one address spend from every account it
// holds. Two limiters, one charged each way, and both have to agree.
func (l *Limiter) AllowKey(key string) bool {
	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	l.sweep(now)

	held, ok := l.budgets[key]
	if !ok {
		held = &budget{limiter: rate.NewLimiter(l.rate, l.burst)}
		l.budgets[key] = held
	}
	held.seen = now

	return held.limiter.Allow()
}

// client works out who to charge.
//
// Behind a proxy that sets X-Forwarded-For, each caller gets a budget of its
// own. Without one the header is whatever the caller typed, so trusting it would
// let anybody mint unlimited budgets by varying a string; the peer address is
// used instead, which they cannot choose.
func (l *Limiter) client(r *http.Request) string {
	return Caller(r, l.hops)
}

// Caller is the address a request came from, as this deployment resolves it.
//
// The same rule the rate limiter charges by, exported because the join has to
// write it down and the two must never disagree: an operator reading an address
// beside somebody's name is reading the one the limits were applied to.
//
// Behind proxies it is read from the right, hops entries in, and never from the
// left. Each proxy appends the address it saw to whatever the header already
// said, and what it already said is the caller's to write, so the first entry is
// exactly as choosable as an untrusted header. This used to read the first
// entry, which let a script buy a fresh join budget and a fresh sign-in
// allowance per request, and put any address it liked beside its name.
//
// The count is configuration rather than a fixed "last entry" because the last
// entry is only the caller behind exactly one proxy. The deployment this fork
// was written for has a CDN in front of nginx; a request sent there with a
// forged header arrived as "forged, caller, CDN node", so the last entry is the
// node, and reading it would charge everybody the node serves as one caller --
// one person's typos locking a whole region out of signing in.
//
// Fewer entries than hops means the request came in past the outer proxies,
// and every entry it does carry was still written by one this deployment
// trusts, so the leftmost of them is the furthest out anybody vouches for.
// Counting is only as good as the outer proxy being the only way in; the
// deployment above refuses anything that did not come through its CDN.
func Caller(r *http.Request, hops int) string {
	if hops > 0 {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			entries := strings.Split(forwarded, ",")
			if address := strings.TrimSpace(entries[max(0, len(entries)-hops)]); address != "" {
				return address
			}
		}
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}

	return host
}

// sweep drops budgets nobody has drawn on recently.
//
// Called under the lock on every request but does its work at most once a
// minute, so the common path pays one comparison.
func (l *Limiter) sweep(now time.Time) {
	if now.Sub(l.lastKeep) < time.Minute {
		return
	}
	l.lastKeep = now

	for key, held := range l.budgets {
		if now.Sub(held.seen) > idle {
			delete(l.budgets, key)
		}
	}
}
