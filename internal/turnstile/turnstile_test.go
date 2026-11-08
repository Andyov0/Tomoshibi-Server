package turnstile

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
)

/*
 * What a door accepts as proof that somebody at a browser passed the check.
 *
 * Every way of getting this wrong is silent. A check that passes a refused token
 * looks exactly like one that works, from the form and from the log, until
 * somebody notices that the guessing budget is being spent at the rate it was
 * before; and a check that refuses a good token looks like Cloudflare having a
 * bad day. So each verdict Cloudflare can give is stood up here, by something
 * that answers as siteverify does, and the door's answer to each is held.
 *
 * The secret is Cloudflare's published testing secret and the hostnames are
 * documentation names. Nothing here reaches Cloudflare.
 */

const secret = "1x0000000000000000000000000000000AA"

// siteverify stands in for Cloudflare. It answers by the token: each token
// below is a verdict Cloudflare gives, and "once" is a token that can be spent
// once, as every real one is.
type siteverify struct {
	mu    sync.Mutex
	asked int
	// spent is the tokens that have been accepted, by idempotency key, so that
	// a second ask under the same key repeats the first answer as Cloudflare's
	// does, and one under another key is a token used twice.
	spent map[string]string
	// sent is every form posted, for what it carried.
	sent []url.Values
	// flaky is how many requests fail with a 502 before it answers.
	flaky int
	// lose is how many answers about "once" are lost on the way back after
	// the token was spent, which is the case the idempotency key is for.
	lose int
	// elsewhere is where "redirect" sends the request.
	elsewhere string
}

func (s *siteverify) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()

	s.mu.Lock()
	s.asked++
	s.sent = append(s.sent, r.PostForm)
	flaky := s.flaky > 0
	if flaky {
		s.flaky--
	}
	s.mu.Unlock()

	if flaky {
		w.WriteHeader(http.StatusBadGateway)
		return
	}

	// With a 400, as Cloudflare answers a secret it does not recognise.
	if r.PostForm.Get("secret") != secret {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"success":false,"error-codes":["invalid-input-secret"]}`))
		return
	}

	switch token := r.PostForm.Get("response"); token {
	case "pass":
		answer(w, true, "meet.example", SignIn)
	case "pass-admin":
		answer(w, true, "meet.example", AdminSignIn)
	case "pass-no-action":
		// A real key's answer about a widget drawn with no action.
		answer(w, true, "meet.example", "")
	case "pass-testing-key":
		// What Cloudflare's always-pass testing secret answers, whatever it is
		// asked: example.com, no action, and a word that it was a testing key.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"error-codes":[],"hostname":"example.com",` +
			`"metadata":{"result_with_testing_key":true}}`))
	case "redirect":
		http.Redirect(w, r, s.elsewhere, http.StatusTemporaryRedirect)
	case "success-with-400":
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"success":true,"hostname":"meet.example","action":"sign-in"}`))
	case "pass-upper":
		answer(w, true, "Meet.Example.", SignIn)
	case "elsewhere":
		// A genuine token, solved on another of the widget's sites.
		answer(w, true, "xboard.example", SignIn)
	case "fail":
		answer(w, false, "", "", "invalid-input-response")
	case "expired":
		answer(w, false, "", "", "timeout-or-duplicate")
	case "slow":
		time.Sleep(300 * time.Millisecond)
		answer(w, true, "meet.example", SignIn)
	case "garbled":
		_, _ = w.Write([]byte("<html>not json</html>"))
	case "once":
		key := r.PostForm.Get("idempotency_key")

		s.mu.Lock()
		if s.spent == nil {
			s.spent = map[string]string{}
		}
		_, used := s.spent["once"]
		repeat := used && s.spent["once"] == key
		if !used {
			s.spent["once"] = key
		}

		lost := s.lose > 0
		if lost {
			s.lose--
		}
		s.mu.Unlock()

		if lost {
			w.WriteHeader(http.StatusBadGateway)
			return
		}

		if used && !repeat {
			answer(w, false, "", "", "timeout-or-duplicate")
			return
		}

		answer(w, true, "meet.example", SignIn)
	default:
		answer(w, false, "", "", "invalid-input-response")
	}
}

func answer(w http.ResponseWriter, success bool, hostname, action string, codes ...string) {
	w.Header().Set("Content-Type", "application/json")
	body := map[string]any{"success": success, "error-codes": append([]string{}, codes...)}
	if hostname != "" {
		body["hostname"] = hostname
	}
	if action != "" {
		body["action"] = action
	}
	_ = json.NewEncoder(w).Encode(body)
}

func (s *siteverify) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.asked
}

// meet is a configuration asking for a check, under the given hostnames.
func meet(hostnames ...string) config.Meet {
	return config.Meet{Turnstile: config.Turnstile{
		SiteKey:   "1x00000000000000000000AA",
		SecretKey: secret,
		Hostnames: hostnames,
	}}
}

func checker(t *testing.T, conf config.Meet) (*Checker, *siteverify) {
	t.Helper()

	fake := &siteverify{}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)

	return NewAt(conf, server.URL, &http.Client{Timeout: 100 * time.Millisecond}), fake
}

// signingIn is a sign-in sent to the given host.
func signingIn(host string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/account/session", nil)
	r.Host = host

	return r
}

func TestEachVerdictIsHeldToItsOwnAnswer(t *testing.T) {
	cases := []struct {
		name   string
		conf   config.Meet
		host   string
		token  string
		action string
		want   error
	}{
		{"a good token on this host passes", meet(), "meet.example", "pass", SignIn, nil},
		{"and with the port the request carried", meet(), "meet.example:8443", "pass", SignIn, nil},
		{"a hostname is a name, whatever its case or trailing dot", meet(), "meet.example", "pass-upper", SignIn, nil},
		{"no token is missing, not refused", meet(), "meet.example", "", SignIn, ErrMissing},
		{"nor is whitespace a token", meet(), "meet.example", "   ", SignIn, ErrMissing},
		{"a token Cloudflare does not know is refused", meet(), "meet.example", "fail", SignIn, ErrRefused},
		{"an expired or spent one is refused", meet(), "meet.example", "expired", SignIn, ErrRefused},
		{"a token from another of the widget's sites is refused", meet(), "meet.example", "elsewhere", SignIn, ErrRefused},
		{"a token solved here is refused at a request naming another host", meet(), "other.example", "pass", SignIn, ErrRefused},
		{"configured hostnames are where a token must be from", meet("meet.example"), "meet.example", "pass", SignIn, nil},
		{"and the request's host is not asked", meet("meet.example"), "xboard.example", "pass", SignIn, nil},
		{"so a request naming the other site does not make its token good", meet("meet.example"), "xboard.example", "elsewhere", SignIn, ErrRefused},
		{"one door's token is not good at the other", meet(), "meet.example", "pass", AdminSignIn, ErrRefused},
		{"the management door's own passes there", meet(), "meet.example", "pass-admin", AdminSignIn, nil},
		{"a verdict with no action is good at neither door", meet(), "meet.example", "pass-no-action", AdminSignIn, ErrRefused},
		{"not the account door either", meet(), "meet.example", "pass-no-action", SignIn, ErrRefused},
		{"a testing key's verdict, which has no action, is held to its hostname", meet("example.com"), "meet.example", "pass-testing-key", AdminSignIn, nil},
		{"which is example.com, and not the host a local run is reached at", meet(), "127.0.0.1:8080", "pass-testing-key", SignIn, ErrRefused},
		{"a success under a status other than 200 is not believed", meet(), "meet.example", "success-with-400", SignIn, ErrUnreachable},
		{"a Cloudflare that is too slow is unreachable", meet(), "meet.example", "slow", SignIn, ErrUnreachable},
		{"so is one that answers with something else", meet(), "meet.example", "garbled", SignIn, ErrUnreachable},
		{"a token longer than any Cloudflare issues is refused", meet(), "meet.example", strings.Repeat("x", 2049), SignIn, ErrRefused},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			human, _ := checker(t, c.conf)

			err := human.Check(signingIn(c.host), c.token, c.action)

			if c.want == nil && err != nil {
				t.Fatalf("Check = %v, want it to pass", err)
			}
			if c.want != nil && !errors.Is(err, c.want) {
				t.Fatalf("Check = %v, want %v", err, c.want)
			}
		})
	}
}

// A token longer than any Cloudflare issues is not one, and is refused without
// being posted on at whatever length somebody chose; the table above cannot
// tell, since the stand-in refuses a token it does not know anyway.
func TestATokenLongerThanAnyCloudflareIssuesIsNotSent(t *testing.T) {
	human, fake := checker(t, meet())

	if err := human.Check(signingIn("meet.example"), strings.Repeat("x", 2049), SignIn); !errors.Is(err, ErrRefused) {
		t.Fatalf("Check = %v, want %v", err, ErrRefused)
	}

	if fake.count() != 0 {
		t.Errorf("Cloudflare was asked %d times about a token longer than any it issues", fake.count())
	}

	// And the longest it does issue is asked about.
	_ = human.Check(signingIn("meet.example"), strings.Repeat("x", 2048), SignIn)
	if fake.count() == 0 {
		t.Error("a token of the longest length Cloudflare issues was refused unasked")
	}
}

// A redirect from siteverify is not followed. What is posted carries the
// secret, and a client following a 307 posts it again wherever it was sent.
func TestARedirectIsNotFollowedWithTheSecret(t *testing.T) {
	var received sync.Mutex
	reached := 0
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.Lock()
		reached++
		received.Unlock()
		answer(w, true, "meet.example", SignIn)
	}))
	t.Cleanup(other.Close)

	human, fake := checker(t, meet())
	fake.elsewhere = other.URL

	if err := human.Check(signingIn("meet.example"), "redirect", SignIn); !errors.Is(err, ErrUnreachable) {
		t.Errorf("Check through a redirect = %v, want %v", err, ErrUnreachable)
	}

	received.Lock()
	defer received.Unlock()
	if reached != 0 {
		t.Errorf("the redirect was followed %d times, with the secret", reached)
	}
}

// A secret Cloudflare does not recognise is the deployment's fault, and the
// person at the form is told the check cannot be reached rather than that they
// failed it, which they would try to fix by failing it again.
func TestASecretCloudflareDoesNotKnowIsNotThePersonsFault(t *testing.T) {
	conf := meet()
	conf.Turnstile.SecretKey = "0x0000000000000000000000000000000BAD"
	human, _ := checker(t, conf)

	if err := human.Check(signingIn("meet.example"), "pass", SignIn); !errors.Is(err, ErrUnreachable) {
		t.Errorf("Check = %v, want %v", err, ErrUnreachable)
	}
}

// Cloudflare's tokens are single use, and a second sign-in with one is refused
// however genuine it was the first time.
func TestATokenIsGoodOnce(t *testing.T) {
	human, _ := checker(t, meet())

	if err := human.Check(signingIn("meet.example"), "once", SignIn); err != nil {
		t.Fatalf("the first use was refused: %v", err)
	}

	if err := human.Check(signingIn("meet.example"), "once", SignIn); !errors.Is(err, ErrRefused) {
		t.Errorf("the second use = %v, want %v", err, ErrRefused)
	}
}

// One bad gateway is one more try, under the same idempotency key, so that a
// token Cloudflare already spent on the first try, and whose answer was lost,
// is not called used on the second.
func TestOneFailedRequestIsAskedAgainUnderTheSameKey(t *testing.T) {
	human, fake := checker(t, meet())
	fake.lose = 1

	if err := human.Check(signingIn("meet.example"), "once", SignIn); err != nil {
		t.Fatalf("Check after one bad gateway = %v, want it to pass", err)
	}

	if fake.count() != 2 {
		t.Fatalf("Cloudflare was asked %d times, want 2", fake.count())
	}

	first, second := fake.sent[0].Get("idempotency_key"), fake.sent[1].Get("idempotency_key")
	if first == "" || first != second {
		t.Errorf("the retry was asked under %q after %q; it has to be the same key", second, first)
	}

	// And no more than twice: somebody is waiting at the form.
	fake.flaky = 5
	if err := human.Check(signingIn("meet.example"), "pass", SignIn); !errors.Is(err, ErrUnreachable) {
		t.Errorf("Check through a Cloudflare that keeps failing = %v, want %v", err, ErrUnreachable)
	}
	if fake.count() != 4 {
		t.Errorf("Cloudflare was asked %d times in all, want 4", fake.count())
	}
}

// What is posted is the secret, the token and the key, and not the caller's
// address. Behind a proxy that address is the proxy's, and the owner's other
// site found Cloudflare refusing tokens over the mismatch.
func TestTheCallersAddressIsNotSent(t *testing.T) {
	human, fake := checker(t, meet())

	r := signingIn("meet.example")
	r.Header.Set("X-Forwarded-For", "198.51.100.7")
	if err := human.Check(r, "pass", SignIn); err != nil {
		t.Fatalf("Check = %v", err)
	}

	sent := fake.sent[0]
	if _, ok := sent["remoteip"]; ok {
		t.Errorf("the caller's address was sent: %v", sent["remoteip"])
	}

	for field := range sent {
		switch field {
		case "secret", "response", "idempotency_key":
		default:
			t.Errorf("an unexpected field was sent: %q", field)
		}
	}
}

// The forwarded host is the proxy's word, believed only behind a proxy this
// deployment trusts. Believed anywhere else, it is the caller's word, and a
// caller holding a token from the widget's other site would name that site.
func TestAForwardedHostIsBelievedOnlyBehindATrustedProxy(t *testing.T) {
	forwarded := func() *http.Request {
		r := signingIn("127.0.0.1:8080")
		r.Header.Set("X-Forwarded-Host", "meet.example")

		return r
	}

	trusted := meet()
	trusted.TrustProxy = true
	human, _ := checker(t, trusted)

	if err := human.Check(forwarded(), "pass", SignIn); err != nil {
		t.Errorf("behind a trusted proxy, a token solved on the forwarded host = %v, want it to pass", err)
	}

	untrusted, _ := checker(t, meet())

	if err := untrusted.Check(forwarded(), "pass", SignIn); !errors.Is(err, ErrRefused) {
		t.Errorf("without trust_proxy, the forwarded host was believed: %v", err)
	}

	sneaking := signingIn("meet.example")
	sneaking.Header.Set("X-Forwarded-Host", "xboard.example")
	if err := untrusted.Check(sneaking, "elsewhere", SignIn); !errors.Is(err, ErrRefused) {
		t.Errorf("without trust_proxy, a forwarded host made another site's token good: %v", err)
	}

	// Where a proxy appended rather than replaced, the last name is the one
	// written by the proxy nearest this server, and the first is whatever the
	// caller sent it.
	appended := func(forwarded string) *http.Request {
		r := signingIn("127.0.0.1:8080")
		r.Header.Set("X-Forwarded-Host", forwarded)

		return r
	}

	if err := human.Check(appended("xboard.example, meet.example"), "pass", SignIn); err != nil {
		t.Errorf("a token solved on the last forwarded host = %v, want it to pass", err)
	}
	if err := human.Check(appended("meet.example, xboard.example"), "pass", SignIn); !errors.Is(err, ErrRefused) {
		t.Errorf("the first forwarded host, which the caller wrote, was believed: %v", err)
	}
}

// A check nobody configured asks nothing and refuses nothing, which is every
// deployment that has not set one up.
func TestNoCheckConfiguredIsNoCheck(t *testing.T) {
	human, fake := checker(t, config.Meet{})

	if human != nil {
		t.Fatalf("a configuration with no keys made a checker")
	}

	if err := human.Check(signingIn("meet.example"), "", SignIn); err != nil {
		t.Errorf("an unconfigured check refused: %v", err)
	}

	if human.SiteKey() != "" {
		t.Errorf("an unconfigured check has a site key")
	}

	if fake.count() != 0 {
		t.Errorf("an unconfigured check asked Cloudflare")
	}
}

// Nothing a check writes to the log carries the token or the secret.
func TestNeitherTheTokenNorTheSecretIsLogged(t *testing.T) {
	var written bytes.Buffer
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&written, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(was) })

	human, fake := checker(t, meet())

	for _, token := range []string{"elsewhere", "fail", "slow", "garbled"} {
		err := human.Check(signingIn("meet.example"), token, SignIn)
		if err == nil {
			t.Fatalf("%q passed", token)
		}

		slog.Warn("refused", "error", err)

		if strings.Contains(err.Error(), token) {
			t.Errorf("the refusal for %q names the token: %v", token, err)
		}
	}

	fake.flaky = 5
	_ = human.Check(signingIn("meet.example"), "a-token-that-must-not-be-written", SignIn)

	for _, never := range []string{secret, "a-token-that-must-not-be-written", "garbled"} {
		if strings.Contains(written.String(), never) {
			t.Errorf("the log holds %q:\n%s", never, written.String())
		}
	}
}

// How many checks may be waiting on Cloudflare at once, across both doors.
// The doors bound how often each subscriber may have this server ask; this
// bounds all of them together, so that a flood from more addresses than the
// doors' bound can tell apart holds no more than inFlight requests open to
// Cloudflare. One past that waits for a place and is then refused as
// Cloudflare being unreachable, and Cloudflare is not asked about it.
func TestOnlySoManyChecksWaitOnCloudflareAtOnce(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	asked := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked++
		mu.Unlock()

		select {
		case <-release:
		case <-r.Context().Done():
		}

		answer(w, true, "meet.example", SignIn)
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})

	fresh := NewAt(meet("meet.example"), server.URL, &http.Client{Timeout: 5 * time.Second})
	if cap(fresh.waiting) != inFlight || inFlight != 32 || fresh.queue != perAttempt {
		t.Fatalf("a checker holds %d places and waits %v for one, want %d and %v",
			cap(fresh.waiting), fresh.queue, 32, perAttempt)
	}

	checker := NewAt(meet("meet.example"), server.URL, &http.Client{Timeout: 5 * time.Second})
	checker.waiting = make(chan struct{}, 2)
	checker.queue = 50 * time.Millisecond

	var held sync.WaitGroup
	for range 2 {
		held.Go(func() {
			if err := checker.Check(signingIn("meet.example"), "pass", SignIn); err != nil {
				t.Errorf("a held check ended %v, want a pass once released", err)
			}
		})
	}

	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		mu.Lock()
		n := asked
		mu.Unlock()
		if n >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the two held checks never reached Cloudflare")
		}
	}

	err := checker.Check(signingIn("meet.example"), "pass", SignIn)
	if !errors.Is(err, ErrBusy) || !errors.Is(err, ErrUnreachable) {
		t.Errorf("a third check while two were waiting ended %v, want busy and unreachable", err)
	}

	mu.Lock()
	if asked != 2 {
		t.Errorf("Cloudflare was asked %d times, want 2", asked)
	}
	mu.Unlock()

	close(release)
	held.Wait()

	if err := checker.Check(signingIn("meet.example"), "pass", SignIn); err != nil {
		t.Errorf("once the places were given back a check ended %v, want a pass", err)
	}
}
