// Package turnstiletest stands up something that answers as Cloudflare's
// siteverify does, for the tests of the doors that ask it.
//
// Its own package so that the account door's tests and the management door's
// ask the same stand-in and cannot drift into testing two different ideas of
// what Cloudflare says. Imported only by tests, and so never built into the
// server.
package turnstiletest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/turnstile"
)

// Cloudflare's published testing keys. The fake answers only to this secret,
// as Cloudflare answers only to the secret of the widget a token came from.
const (
	SiteKey = "1x00000000000000000000AA"
	Secret  = "1x0000000000000000000000000000000AA"
)

// Hostname is where the fake says every token it vouches for was solved,
// except those it is told were solved elsewhere.
const Hostname = "meet.example"

// Cloudflare is the stand-in. Tokens say what it answers, by their prefix:
//
//	good:...      solved here, at the account door
//	admin:...     solved here, at the management door
//	elsewhere:... solved on another of the widget's sites
//	held:...      one it does not recognise, answered only once Release is
//	              called where Hold was
//
// and anything else is a token it does not recognise. Every token it vouches
// for is good once, as every real one is.
type Cloudflare struct {
	server *httptest.Server

	mu    sync.Mutex
	asked int
	spent map[string]bool
	down  bool

	// hold is closed by Release; waiting is how many held tokens are waiting
	// on it.
	hold    chan struct{}
	waiting int
}

// Start stands one up for the length of the test.
func Start(t testing.TB) *Cloudflare {
	t.Helper()

	fake := &Cloudflare{spent: map[string]bool{}}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.answer))
	t.Cleanup(fake.server.Close)

	return fake
}

// Config is a section asking for a check, held to the fake's hostname.
func Config() config.Turnstile {
	return config.Turnstile{SiteKey: SiteKey, SecretKey: Secret, Hostnames: []string{Hostname}}
}

// Checker is a checker for meet that asks this stand-in.
func (c *Cloudflare) Checker(meet config.Meet) *turnstile.Checker {
	return turnstile.NewAt(meet, c.server.URL, &http.Client{Timeout: 200 * time.Millisecond})
}

// PatientChecker is a checker that waits for this stand-in as long as the
// real one waits for Cloudflare, for a test that holds answers back.
func (c *Cloudflare) PatientChecker(meet config.Meet) *turnstile.Checker {
	return turnstile.NewAt(meet, c.server.URL, &http.Client{Timeout: 5 * time.Second})
}

// Hold keeps every held: token waiting, as a slow Cloudflare keeps a request,
// until Release, which the end of the test calls if nothing else has.
func (c *Cloudflare) Hold(t testing.TB) {
	t.Helper()

	c.mu.Lock()
	c.hold = make(chan struct{})
	c.mu.Unlock()

	// After the server's own cleanup is registered, and so run before it: a
	// server closing waits for every request it is answering.
	t.Cleanup(c.Release)
}

// Release answers every held token, and any that arrives after.
func (c *Cloudflare) Release() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.hold != nil {
		close(c.hold)
		c.hold = nil
	}
}

// AwaitHeld waits until n held tokens are waiting on Release.
func (c *Cloudflare) AwaitHeld(t testing.TB, n int) {
	t.Helper()

	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		c.mu.Lock()
		waiting := c.waiting
		c.mu.Unlock()

		if waiting >= n {
			return
		}
	}

	t.Fatalf("fewer than %d held tokens reached Cloudflare", n)
}

// Asked is how many times anything asked.
func (c *Cloudflare) Asked() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.asked
}

// Down makes every request fail as one to an unreachable Cloudflare does.
func (c *Cloudflare) Down() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.down = true
}

func (c *Cloudflare) answer(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	token := r.PostForm.Get("response")

	c.mu.Lock()
	c.asked++
	down := c.down
	reused := c.spent[token]
	c.spent[token] = true
	hold := c.hold
	held := hold != nil && strings.HasPrefix(token, "held:")
	if held {
		c.waiting++
	}
	c.mu.Unlock()

	if held {
		select {
		case <-hold:
		case <-r.Context().Done():
		}
	}

	if down {
		w.WriteHeader(http.StatusBadGateway)
		return
	}

	said := map[string]any{"success": false, "error-codes": []string{"invalid-input-response"}}

	switch {
	case r.PostForm.Get("secret") != Secret:
		said["error-codes"] = []string{"invalid-input-secret"}
	case reused:
		said["error-codes"] = []string{"timeout-or-duplicate"}
	case strings.HasPrefix(token, "good:"):
		said = vouched(Hostname, turnstile.SignIn)
	case strings.HasPrefix(token, "admin:"):
		said = vouched(Hostname, turnstile.AdminSignIn)
	case strings.HasPrefix(token, "elsewhere:"):
		said = vouched("xboard.example", turnstile.SignIn)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(said)
}

func vouched(hostname, action string) map[string]any {
	return map[string]any{
		"success": true, "error-codes": []string{},
		"hostname": hostname, "action": action,
		"challenge_ts": time.Now().UTC().Format(time.RFC3339),
	}
}
