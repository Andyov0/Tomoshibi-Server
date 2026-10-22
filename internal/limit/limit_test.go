package limit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func request(peer, forwarded string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/rooms/demo/join", nil)
	r.RemoteAddr = peer

	if forwarded != "" {
		r.Header.Set("X-Forwarded-For", forwarded)
	}

	return r
}

func TestABurstIsAllowedAndThenRefused(t *testing.T) {
	limiter := New(1, 3, 0)

	for i := range 3 {
		if !limiter.Allow(request("192.0.2.1:1000", "")) {
			t.Fatalf("request %d was refused within the burst", i+1)
		}
	}

	if limiter.Allow(request("192.0.2.1:1000", "")) {
		t.Error("a request past the burst was allowed")
	}
}

// Without a proxy the peer address is the only thing a caller cannot choose.
func TestEachPeerHasItsOwnBudget(t *testing.T) {
	limiter := New(1, 1, 0)

	if !limiter.Allow(request("192.0.2.1:1000", "")) {
		t.Fatal("the first request was refused")
	}
	if !limiter.Allow(request("192.0.2.2:1000", "")) {
		t.Error("a different peer was charged to the first one's budget")
	}
	if limiter.Allow(request("192.0.2.1:1000", "")) {
		t.Error("the first peer's budget was not spent")
	}
}

// Ports change between requests from one caller, so charging them apart would
// hand out a fresh budget every time.
func TestThePortIsNotPartOfTheIdentity(t *testing.T) {
	limiter := New(1, 1, 0)

	if !limiter.Allow(request("192.0.2.1:1000", "")) {
		t.Fatal("the first request was refused")
	}
	if limiter.Allow(request("192.0.2.1:2000", "")) {
		t.Error("a new source port bought a new budget")
	}
}

func TestATrustedProxyIdentifiesTheClient(t *testing.T) {
	limiter := New(1, 1, 1)

	if !limiter.Allow(request("10.0.0.1:1000", "192.0.2.1")) {
		t.Fatal("the first client was refused")
	}
	if !limiter.Allow(request("10.0.0.1:1000", "192.0.2.2")) {
		t.Error("a second client behind the same proxy shared the first one's budget")
	}
	if limiter.Allow(request("10.0.0.1:1000", "192.0.2.1")) {
		t.Error("the first client's budget was not spent")
	}
}

// Proxies append to whatever the caller already put in the header, so every
// entry to the left of what they wrote is the caller's own writing. Reading the
// first entry let a script buy a fresh budget per request by varying it.
func TestAForgedPrefixCannotBuyANewBudget(t *testing.T) {
	limiter := New(1, 1, 1)

	if !limiter.Allow(request("10.0.0.1:1000", "198.51.100.1, 192.0.2.1")) {
		t.Fatal("the first request was refused")
	}
	if limiter.Allow(request("10.0.0.1:1000", "198.51.100.2, 192.0.2.1")) {
		t.Error("a different forged first entry bought a budget the client had already spent")
	}
}

// The shape a request has behind a CDN and then nginx, as captured on the
// deployment: whatever the caller sent, the caller as the CDN saw them, and the
// CDN node as nginx saw it. The node is shared by everybody it serves, so it
// must be neither the one charged nor the one that decides.
func TestBehindTwoProxiesTheCallerIsTheSecondFromTheRight(t *testing.T) {
	limiter := New(1, 1, 2)

	if !limiter.Allow(request("127.0.0.1:1000", "198.51.100.1, 192.0.2.1, 203.0.113.9")) {
		t.Fatal("the first request was refused")
	}
	if !limiter.Allow(request("127.0.0.1:1000", "192.0.2.2, 203.0.113.9")) {
		t.Error("a second caller through the same CDN node shared the first one's budget")
	}
	if limiter.Allow(request("127.0.0.1:1000", "198.51.100.2, 192.0.2.1, 203.0.113.9")) {
		t.Error("a different forged prefix bought a budget the caller had already spent")
	}
}

// A request that came in past the outer proxy carries fewer entries than there
// are proxies, and every one it does carry was written by a proxy this server
// trusts, so the furthest out of them is the caller.
func TestFewerEntriesThanProxiesReadsTheFurthestOut(t *testing.T) {
	r := request("127.0.0.1:1000", "192.0.2.1")

	if got := Caller(r, 2); got != "192.0.2.1" {
		t.Errorf("caller %q, want 192.0.2.1", got)
	}
}

// Untrusted, the header is whatever the caller typed, so varying it must not
// conjure a fresh budget.
func TestAnUntrustedHeaderCannotBuyANewBudget(t *testing.T) {
	limiter := New(1, 1, 0)

	if !limiter.Allow(request("192.0.2.1:1000", "10.0.0.1")) {
		t.Fatal("the first request was refused")
	}
	if limiter.Allow(request("192.0.2.1:1000", "10.0.0.2")) {
		t.Error("a claimed address bought a budget the peer had already spent")
	}
}

// Budgets nobody has drawn on are dropped, so a script cycling through addresses
// cannot grow the map without bound.
func TestIdleBudgetsAreSweptAway(t *testing.T) {
	limiter := New(1, 1, 0)

	limiter.Allow(request("192.0.2.1:1000", ""))
	if len(limiter.budgets) != 1 {
		t.Fatalf("held %d budgets, want 1", len(limiter.budgets))
	}

	// Backdate both the budget and the last sweep, which is the state the
	// limiter would be in after a quiet stretch.
	limiter.budgets["192.0.2.1"].seen = time.Now().Add(-2 * idle)
	limiter.lastKeep = time.Now().Add(-2 * time.Minute)

	limiter.Allow(request("192.0.2.9:1000", ""))

	if _, held := limiter.budgets["192.0.2.1"]; held {
		t.Error("an idle budget survived the sweep")
	}
}

// A budget named by the caller is its own, and is the same budget whichever
// address asks: an account is one account from every network it signs in on.
func TestANamedBudgetIsKeptApartFromEveryOther(t *testing.T) {
	limiter := New(1, 1, 0)

	if !limiter.AllowKey("account-a") {
		t.Fatal("the first request for a name was refused")
	}
	if !limiter.AllowKey("account-b") {
		t.Error("a second name was charged to the first one's budget")
	}
	if limiter.AllowKey("account-a") {
		t.Error("the first name's budget was not spent")
	}
}
