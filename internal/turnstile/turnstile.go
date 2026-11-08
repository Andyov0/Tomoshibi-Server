// Package turnstile asks Cloudflare whether a token a sign-in page handed over
// was earned by somebody at a browser.
//
// The two sign-in doors are where a passphrase is tried, and the guessing
// budgets in package guess are what bound how fast. This sits in front of those
// budgets rather than replacing them: a token proves that a page drew the widget
// and somebody passed it, which a script running a list of passphrases has to
// pay for per attempt, and it says nothing about whether the passphrase is
// right. So a request without a good token is turned away before it is charged
// to the budget, and before anything about the account it names has been looked
// at, and the refusal is the same whichever name it named.
//
// What Cloudflare is asked is decided here and nowhere else, for both doors, so
// that the two cannot come to accept different things; and so is the one kind
// of caller both doors spare the question, a program on this machine that
// connected to it directly (Spares).
package turnstile

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strings"
	"time"

	"tomoshibi/internal/config"
)

// Endpoint is where Cloudflare answers whether a token is genuine.
const Endpoint = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

// The actions each door's widget is drawn with, and which Cloudflare says back
// beside the token. They hold the doors apart: a token solved on the account
// page is not good at the management sign-in, which is the door worth more.
const (
	SignIn      = "sign-in"
	AdminSignIn = "admin-sign-in"
)

// The three ways a check ends other than passing.
//
// Three, because they are three different sentences to the person at the form.
// No token at all is a page that did not draw the widget or a press before it
// had finished; a token Cloudflare will not vouch for is one to solve again; and
// Cloudflare not answering is nobody's fault at the form and nothing they can
// fix by trying harder. All three refuse: a door that opened whenever Cloudflare
// could not be reached would open for anybody who could make it unreachable.
var (
	ErrMissing     = errors.New("no human check came with the request")
	ErrRefused     = errors.New("the human check was not passed")
	ErrUnreachable = errors.New("Cloudflare could not be asked about the human check")
)

// tokenLimit is the longest token Cloudflare issues. Anything longer is not
// one, and is refused here rather than posted on to Cloudflare at whatever
// length somebody chose to send.
const tokenLimit = 2048

// attempts is how many times one check asks Cloudflare before calling it
// unreachable. Two, so that one lost packet is not a refused sign-in, and no
// more, because somebody is waiting at the form for every one of them.
const attempts = 2

// perAttempt bounds each of them. Cloudflare answers in well under a second;
// four is long enough for a slow path from a machine far from it and short
// enough that two of them are not a sign-in that seems to have hung.
const perAttempt = 4 * time.Second

// inFlight is how many checks may be waiting on Cloudflare at once, across
// both doors, and queueing how long one more waits for a place before it is
// refused as Cloudflare being unreachable.
//
// How often one caller may have this server ask is bounded at the doors, per
// subscriber (admin.API.MayAsk); this bounds what all of them together can
// hold open. A deployment's sign-ins are a handful a minute, and thirty-two
// at once is a crowd that is not signing in. A ceiling on the rate across
// every caller was considered and not taken: anybody with enough addresses
// could then keep it spent, and every web sign-in would be refused for as
// long as they cared to, which is a sure outage bought to avoid a possible
// one. A ceiling on what is open at once only bites when Cloudflare is slow
// or the flood is large, and costs those callers a refusal they would have
// had from a Cloudflare that had stopped answering this server anyway.
const (
	inFlight = 32
	queueing = perAttempt
)

// ErrBusy is a check refused because inFlight others were already waiting on
// Cloudflare. It is also ErrUnreachable, which is what the person at the form
// is told; it is told apart only so that a flood is not a line in the log for
// every request in it.
var ErrBusy = errors.New("too many human checks were already waiting on Cloudflare")

// Checker asks Cloudflare about tokens, for one widget.
//
// A nil Checker is a deployment that asks for no human check, and every method
// says so, so that a door can ask without first asking whether to.
type Checker struct {
	siteKey   string
	secret    string
	hostnames []string
	trust     bool
	endpoint  string
	// local is whether a program on this machine is spared the check; see
	// Spares.
	local bool

	// waiting holds a place for each check asking Cloudflare, and queue is how
	// long one waits for a place; see inFlight.
	waiting chan struct{}
	queue   time.Duration

	// client is this checker's alone, rather than http.DefaultClient, so that
	// its timeout is a property of the check and not of whatever else in the
	// process last set one, and so that a slow Cloudflare holds no connection
	// another part of the server was counting on. It follows no redirect; see
	// NewAt.
	client *http.Client
}

// New is the checker the configuration describes, or nil where it describes
// none.
func New(meet config.Meet) *Checker {
	return NewAt(meet, Endpoint, &http.Client{Timeout: perAttempt})
}

// NewAt is a checker that asks somewhere other than Cloudflare, with its own
// client: for the tests, which stand up something that answers as Cloudflare
// does.
//
// The client is copied and told to follow no redirect, whatever it was given.
// What is posted carries the secret, and a client that follows a 307 or 308
// posts it again, whole, wherever the answer pointed; siteverify has no reason
// to redirect, so a redirect is an answer that is not a verdict, and the check
// calls Cloudflare unreachable rather than going where it was sent. A review
// had a stand-in answer 307 to a second server, which received the secret.
func NewAt(meet config.Meet, endpoint string, client *http.Client) *Checker {
	if !meet.Turnstile.Configured() {
		return nil
	}

	own := *client
	own.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	return &Checker{
		siteKey:   meet.Turnstile.SiteKey,
		secret:    meet.Turnstile.SecretKey,
		hostnames: meet.Turnstile.Hostnames,
		trust:     meet.TrustProxy,
		endpoint:  endpoint,
		local:     meet.Turnstile.ExemptsLocal(),
		waiting:   make(chan struct{}, inFlight),
		queue:     queueing,
		client:    &own,
	}
}

// SiteKey is what a page draws the widget with, empty where none is asked for.
func (c *Checker) SiteKey() string {
	if c == nil {
		return ""
	}

	return c.siteKey
}

// Hostnames are the names a token is held to, empty where it is held to the
// host each request names. For the management pages' runtime panel.
func (c *Checker) Hostnames() []string {
	if c == nil {
		return nil
	}

	return slices.Clone(c.hostnames)
}

// Spares reports whether r is let through without a token because a program
// on this machine sent it directly (FromThisMachine), while the configuration
// says such programs are, as it does unless meet.turnstile.exempt_local is
// false. False on a nil Checker, which asks nothing of anybody anyway.
//
// Both sign-in doors ask this one question, so that they cannot come to spare
// different callers. Only the human check is spared: the request limit, the
// sign-in lockout, the guessing budget and the passphrase are asked of these
// callers as of everybody, and a request another site sent is refused before
// any of it, though these programs send no Sec-Fetch-Site and are not refused
// that way.
func (c *Checker) Spares(r *http.Request) bool {
	return c != nil && c.local && FromThisMachine(r)
}

// forwarding is every header a proxy uses to say who it is passing a request
// on for. Any one of them, with any value or none, is a request that came
// through something.
var forwarding = []string{"X-Forwarded-For", "X-Real-IP", "Forwarded"}

// FromThisMachine reports whether r came from a program on this machine
// directly, rather than through a proxy: its connection's own peer is a
// loopback address, and it carries none of the forwarding headers.
//
// For the tools on a control node that sign in to these doors at
// http://127.0.0.1:8080 with no browser to draw a widget — a health check run
// by cron, an operations script, a peek tool — which a human check would shut
// out. The peer is the connection's (RemoteAddr), never anything a header
// says, since a header is what a remote caller writes.
//
// The headers are the other half, and the half that can be got wrong. A proxy
// on this machine, nginx in front of a control node, connects from loopback
// too, so every request it passes on has a loopback peer; what tells its
// requests from a local program's is that it says who it is passing them on
// for. A proxy in front of this server MUST therefore always set
// X-Forwarded-For or X-Real-IP, on every request, or every caller it passes on
// is spared the check. nginx with proxy_set_header X-Forwarded-For
// $proxy_add_x_forwarded_for always does, since that variable always holds at
// least the address nginx saw. A header present with no value counts as
// present: a proxy that wrote one wrote it, and a value a caller wrote is not
// what is being asked about. Read whatever meet.trust_proxy says, because the
// question is not who the caller is but whether there is one behind the
// connection.
func FromThisMachine(r *http.Request) bool {
	for _, name := range forwarding {
		if r.Header.Values(name) != nil {
			return false
		}
	}

	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return false
	}

	return peer.Addr().IsLoopback()
}

// verdict is the part of Cloudflare's answer this reads.
type verdict struct {
	Success  bool     `json:"success"`
	Codes    []string `json:"error-codes"`
	Hostname string   `json:"hostname"`
	Action   string   `json:"action"`
	Metadata struct {
		// Testing is Cloudflare saying the answer came from one of its
		// published testing secrets, which answer the same whatever they are
		// asked and never with an action.
		Testing bool `json:"result_with_testing_key"`
	} `json:"metadata"`
}

// Check asks whether token was earned on this deployment's page for this door.
//
// Nil where it was, and where there is nothing to check because no human check
// is configured. Otherwise an error matching one of the three above, whose text
// names what was wrong and never the token: a token is short-lived and single
// use, and it is still not something to leave in a log.
//
// What is sent is the secret, the token and an idempotency key, and nothing
// else. Not the caller's address, which Cloudflare accepts as remoteip: behind
// a proxy the address this server sees is the proxy's, and the owner's other
// site, which sends it, found tokens refused for a mismatch that was nobody's
// doing. The key is what lets the second attempt below ask again about a token
// the first may already have spent at Cloudflare: asked under the same key,
// Cloudflare repeats its first answer rather than calling the token used.
func (c *Checker) Check(r *http.Request, token, action string) error {
	if c == nil {
		return nil
	}

	token = strings.TrimSpace(token)
	if token == "" {
		return ErrMissing
	}

	if len(token) > tokenLimit {
		return fmt.Errorf("%w: the token is longer than any Cloudflare issues", ErrRefused)
	}

	release, err := c.place(r.Context())
	if err != nil {
		return err
	}
	defer release()

	form := url.Values{
		"secret":          {c.secret},
		"response":        {token},
		"idempotency_key": {idempotencyKey()},
	}.Encode()

	var (
		said verdict
		last error
	)

	for range attempts {
		said, last = c.ask(r.Context(), form)
		if last == nil {
			break
		}

		// The person at the form left, and nothing more is worth asking.
		if r.Context().Err() != nil {
			break
		}
	}

	if last != nil {
		return fmt.Errorf("%w: %v", ErrUnreachable, last)
	}

	if !said.Success {
		// A key Cloudflare does not recognise is this deployment's fault and not
		// the person's, and telling them to try again would have them try for
		// ever. Refused as unreachable, which is what it amounts to, and said
		// loudly, because nothing else will say it.
		for _, code := range said.Codes {
			if code == "invalid-input-secret" || code == "missing-input-secret" {
				slog.Error("Cloudflare does not recognise meet.turnstile.secret_key, so nobody can "+
					"sign in until it is corrected", "codes", strings.Join(said.Codes, ","))

				return fmt.Errorf("%w: Cloudflare refused the secret key", ErrUnreachable)
			}
		}

		return fmt.Errorf("%w: Cloudflare said %s", ErrRefused, strings.Join(said.Codes, ","))
	}

	if !c.solvedHere(r, said.Hostname) {
		// Said at warning, with both names, because the commonest way to get
		// here is not an attacker but a proxy that does not pass the host on,
		// and then every sign-in is refused with this as the only clue.
		slog.Warn("a sign-in's human check was solved on another hostname, so it was refused",
			"solved on", said.Hostname, "expected", c.expected(r))

		return fmt.Errorf("%w: the token was solved on %q", ErrRefused, said.Hostname)
	}

	// The action is the door's, exactly, and an answer without one is refused.
	//
	// It is what holds this deployment's two doors apart: both draw the widget
	// with their own, and a token solved for the account page is not good at
	// the management sign-in, which is worth more. An earlier version compared
	// it only where Cloudflare said one, so a token from a widget drawn with no
	// action at all was good at both doors; a review found it.
	//
	// What that guarantees is narrower than it sounds, and is worth saying
	// accurately. The action is written by the page, and somebody running their
	// own copy of the page can draw the widget with whichever action they
	// like, so this holds apart tokens from this deployment's own pages and
	// not tokens in general. Tokens are single use, so it is not a way in, only
	// a smaller promise than "the account page's token cannot be used there".
	//
	// The one exception is an answer Cloudflare marks as coming from one of its
	// published testing secrets, which never carries an action. A check that
	// demanded one would refuse every token there and leave no way to try this
	// end to end without a real widget; and a deployment running on a testing
	// secret checks nothing anyway, which its start says loudly.
	if said.Action != action && !said.Metadata.Testing {
		return fmt.Errorf("%w: the token was for %q, not %q", ErrRefused, said.Action, action)
	}

	return nil
}

// place waits for one of the inFlight places, for as long as queue or the
// request lasts, and returns what gives it back.
func (c *Checker) place(ctx context.Context) (func(), error) {
	select {
	case c.waiting <- struct{}{}:
		return func() { <-c.waiting }, nil
	default:
	}

	timer := time.NewTimer(c.queue)
	defer timer.Stop()

	select {
	case c.waiting <- struct{}{}:
		return func() { <-c.waiting }, nil
	case <-timer.C:
		return nil, fmt.Errorf("%w: %w", ErrUnreachable, ErrBusy)
	case <-ctx.Done():
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, ctx.Err())
	}
}

// ask is one request to Cloudflare. An error is the request not being
// answered, or answered with something that is not a verdict; a verdict that
// refuses is not an error here.
func (c *Checker) ask(ctx context.Context, form string) (verdict, error) {
	ctx, cancel := context.WithTimeout(ctx, perAttempt)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, strings.NewReader(form))
	if err != nil {
		return verdict{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	response, err := c.client.Do(request)
	if err != nil {
		// The error names the endpoint and how the request failed. It does not
		// carry the body, which is where the secret and the token are.
		return verdict{}, err
	}
	defer response.Body.Close()

	// A server error is Cloudflare having trouble, and worth one more try. A
	// redirect is not a verdict either, and is not followed (NewAt).
	if response.StatusCode >= 500 || (response.StatusCode >= 300 && response.StatusCode < 400) {
		return verdict{}, fmt.Errorf("Cloudflare answered %d", response.StatusCode)
	}

	var said verdict
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&said); err != nil {
		return verdict{}, fmt.Errorf("Cloudflare's answer could not be read: %w", err)
	}

	// A refusal is a verdict whatever its status, and Cloudflare sends some
	// with a 400: a secret it does not recognise comes back that way, and has
	// to reach Check to be said as the deployment's fault. A success is
	// believed only from a 200. One under any other status is not something
	// Cloudflare sends, and it is not taken as a pass on the word of a body
	// whose status says something went wrong.
	if said.Success && response.StatusCode != http.StatusOK {
		return verdict{}, fmt.Errorf("Cloudflare answered %d and called it a success", response.StatusCode)
	}

	// Cloudflare's own fault, which its documentation says may be retried.
	if !said.Success && slices.Contains(said.Codes, "internal-error") {
		return verdict{}, errors.New("Cloudflare reported an internal error")
	}

	return said, nil
}

// solvedHere is whether the hostname Cloudflare reports for a token is one this
// deployment's sign-in pages are served under.
//
// The names in the configuration where there are any, and the request's own
// host where there are none; never both, since a configured list is a
// deployment saying exactly where its pages are and a header beside it would
// be a second, weaker answer to the same question. Compared as names, without
// a port or a trailing dot and in lower case, because Cloudflare reports the
// page's hostname alone and a request's host may carry either.
func (c *Checker) solvedHere(r *http.Request, hostname string) bool {
	solved, ok := config.Hostname(hostname)
	if !ok {
		return false
	}

	return slices.Contains(c.expected(r), solved)
}

// expected is where a token is to have been solved, for this request.
//
// Cloudflare's published always-pass testing secret reports every token as
// solved on example.com, and nothing else. A local run with the testing keys
// therefore needs hostnames to name example.com, or the browser to reach the
// server under that name; otherwise every token is refused as solved on
// another hostname, which is this check working and not the keys failing.
func (c *Checker) expected(r *http.Request) []string {
	if len(c.hostnames) > 0 {
		return c.hostnames
	}

	if host, ok := config.Hostname(stripPort(requestHost(r, c.trust))); ok {
		return []string{host}
	}

	return nil
}

// requestHost is the host a request was sent to, read as the rest of this
// server reads it (app.signallingURLFor): what the proxy says it was sent to,
// where there is a proxy to believe, and otherwise what the request says.
//
// The last name in a forwarded host, where a proxy appended rather than
// replaced: it is the one written by the proxy nearest this server, which is
// the only one of them this server trusts.
func requestHost(r *http.Request, trust bool) string {
	if trust {
		forwarded := r.Header.Get("X-Forwarded-Host")
		if i := strings.LastIndexByte(forwarded, ','); i >= 0 {
			forwarded = forwarded[i+1:]
		}

		if forwarded = strings.TrimSpace(forwarded); forwarded != "" {
			return forwarded
		}
	}

	return r.Host
}

// stripPort is a host without its port, where it has one.
func stripPort(host string) string {
	if bare, _, err := net.SplitHostPort(host); err == nil {
		return bare
	}

	return host
}

// idempotencyKey is a fresh UUID, which is the form Cloudflare asks for.
func idempotencyKey() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand does not fail on any platform this runs on.
		panic("read random bytes: " + err.Error())
	}

	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80

	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}
