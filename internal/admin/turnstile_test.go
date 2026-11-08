package admin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/guess"
	"tomoshibi/internal/room"
	"tomoshibi/internal/turnstile/turnstiletest"
)

/*
 * The human check at the management sign-in.
 *
 * The door worth most on the deployment, and so the one with no way through: a
 * script that says it is one of the apps is still asked for a token here,
 * because nothing but a browser opens these pages and the apps, which the owner
 * exempts from the check at the account door, never call this one. A token
 * solved at the account door is not good here either, so a page that only ever
 * offers the cheaper door cannot be used to buy tokens for this one.
 *
 * The order is the account door's: how often anybody may ask, then the check,
 * then the guessing budget, so that bad tokens neither spend the budget nor
 * hold it while Cloudflare is asked — and the first step, new to this door,
 * bounds how often Cloudflare is.
 */

// checked is a management surface whose sign-in asks for a human check.
func checked(t *testing.T) (*API, http.Handler, *turnstiletest.Cloudflare, *kept) {
	t.Helper()

	api, mux, written := mountAudited(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})
	api.conf.Meet.JoinRate = 1000
	api.conf.Meet.JoinBurst = 1000
	api.conf.Meet.Turnstile = turnstiletest.Config()

	fake := turnstiletest.Start(t)
	api.UseHumanCheck(fake.Checker(api.conf.Meet))

	return api, mux, fake, written
}

// signing is a management sign-in from agent, carrying token where it is not
// empty.
func signing(name, said, token, agent string) *http.Request {
	body := fmt.Sprintf(`{"name":%q,"passphrase":%q}`, name, said)
	if token != "" {
		body = fmt.Sprintf(`{"name":%q,"passphrase":%q,"turnstile":%q}`, name, said, token)
	}

	request := sign(body)
	request.Header.Set("User-Agent", agent)

	return request
}

func humanAnswered(mux http.Handler, request *http.Request) (int, string) {
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	var said struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &said)

	return recorder.Code, said.Error
}

const browserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
	"(KHTML, like Gecko) Version/26.0 Safari/605.1.15"

func TestTheManagementSignInAsksEveryoneForAHumanCheck(t *testing.T) {
	cases := []struct {
		name   string
		down   bool
		token  string
		agent  string
		status int
		reason string
	}{
		{"its own token and the right passphrase sign in", false, "admin:1", browserAgent, http.StatusOK, ""},
		{"no token is missing", false, "", browserAgent, http.StatusBadRequest, "human_check_missing"},
		{"an app is not exempt here", false, "", "Tomoshibi/0.1.7.1 (Mac; macOS 26.1; Mac16,10)", http.StatusBadRequest, "human_check_missing"},
		{"nor is one that says nothing", false, "", "", http.StatusBadRequest, "human_check_missing"},
		{"the account door's token is not good here", false, "good:1", browserAgent, http.StatusForbidden, "human_check_failed"},
		{"a token from the widget's other site is not either", false, "elsewhere:1", browserAgent, http.StatusForbidden, "human_check_failed"},
		{"a token Cloudflare does not know fails", false, "made-up", browserAgent, http.StatusForbidden, "human_check_failed"},
		{"Cloudflare unreachable is refused, and says so", true, "admin:1", browserAgent, http.StatusServiceUnavailable, "human_check_unavailable"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, mux, fake, _ := checked(t)
			if c.down {
				fake.Down()
			}

			if status, reason := humanAnswered(mux, signing("adam", "correct", c.token, c.agent)); status != c.status || reason != c.reason {
				t.Errorf("answered %d %q, want %d %q", status, reason, c.status, c.reason)
			}
		})
	}
}

func TestAReusedTokenIsRefusedAtTheManagementSignIn(t *testing.T) {
	_, mux, _, _ := checked(t)

	if status, _ := humanAnswered(mux, signing("adam", "correct", "admin:once", browserAgent)); status != http.StatusOK {
		t.Fatalf("the first use answered %d", status)
	}

	if status, reason := humanAnswered(mux, signing("adam", "correct", "admin:once", browserAgent)); status != http.StatusForbidden || reason != "human_check_failed" {
		t.Errorf("the second use answered %d %q, want 403 human_check_failed", status, reason)
	}
}

// Past every budget in bad tokens, the administrator with a good one still
// signs in; past the per-address budget in real guesses, they do not. The
// second half is what shows the first is not passing for want of a budget.
func TestABadTokenIsNotAGuessAtTheManagementSignIn(t *testing.T) {
	_, mux, _, _ := checked(t)

	for i := range guess.Overall + guess.PerAddress {
		if status, _ := humanAnswered(mux, signing("adam", "wrong", fmt.Sprintf("made-up-%d", i), browserAgent)); status != http.StatusForbidden {
			t.Fatalf("bad token %d answered %d, want 403", i, status)
		}
	}

	if status, _ := humanAnswered(mux, signing("adam", "correct", "admin:after", browserAgent)); status != http.StatusOK {
		t.Fatalf("after bad tokens, the administrator answered %d, want 200", status)
	}

	for i := range guess.PerAddress {
		if status, _ := humanAnswered(mux, signing("adam", "wrong", fmt.Sprintf("admin:%d", i), browserAgent)); status != http.StatusUnauthorized {
			t.Fatalf("guess %d with a good token answered %d, want 401", i, status)
		}
	}

	if status, reason := humanAnswered(mux, signing("adam", "correct", "admin:last", browserAgent)); status != http.StatusTooManyRequests || reason != "too_many_attempts" {
		t.Errorf("past the budget in real guesses, the door answered %d %q, want 429", status, reason)
	}
}

// The order where it can be seen. The budget holds a slot for every attempt
// between being let through and being decided, so a check made after the
// budget is taken holds one for as long as Cloudflare takes: a per-address
// budget's worth of rubbish tokens, sent at once and answered slowly, then
// shuts the door on the administrator with a good one. The test above sends
// one at a time, the slots come back between requests, and the wrong order
// passes it; this one does not.
func TestBadTokensWaitingOnCloudflareDoNotShutTheManagementSignIn(t *testing.T) {
	api, mux, fake, _ := checked(t)
	api.UseHumanCheck(fake.PatientChecker(api.conf.Meet))
	fake.Hold(t)

	statuses := make([]int, guess.PerAddress)

	var waiting sync.WaitGroup
	for i := range guess.PerAddress {
		waiting.Go(func() {
			statuses[i], _ = humanAnswered(mux, signing("adam", "wrong", fmt.Sprintf("held:%d", i), browserAgent))
		})
	}

	fake.AwaitHeld(t, guess.PerAddress)

	if status, reason := humanAnswered(mux, signing("adam", "correct", "admin:meanwhile", browserAgent)); status != http.StatusOK {
		t.Errorf("with %d bad tokens waiting on Cloudflare, the administrator answered %d %q, want 200",
			guess.PerAddress, status, reason)
	}

	fake.Release()
	waiting.Wait()

	for i, status := range statuses {
		if status != http.StatusForbidden {
			t.Errorf("held bad token %d answered %d, want 403", i, status)
		}
	}
}

// The door's request limit is asked before Cloudflare, so a stream of
// requests is not a stream of requests to Cloudflare.
func TestTheManagementSignInBoundsHowOftenItAsksCloudflare(t *testing.T) {
	api, mux, fake, _ := checked(t)
	api.conf.Meet.JoinRate = 0.0001
	api.conf.Meet.JoinBurst = 1
	api.UseHumanCheck(fake.Checker(api.conf.Meet))

	humanAnswered(mux, signing("adam", "wrong", "made-up-1", browserAgent))

	if status, _ := humanAnswered(mux, signing("adam", "wrong", "made-up-2", browserAgent)); status != http.StatusTooManyRequests {
		t.Fatalf("past the request limit the door answered %d, want 429", status)
	}

	if fake.Asked() != 1 {
		t.Errorf("Cloudflare was asked %d times, want once", fake.Asked())
	}
}

// A refused check is in the management log as a refused sign-in, with no
// trace of the token.
func TestARefusedCheckIsLoggedWithoutItsToken(t *testing.T) {
	_, mux, _, written := checked(t)

	humanAnswered(mux, signing("adam", "correct", "made-up-and-secret", browserAgent))

	entries := written.recorded()
	if len(entries) == 0 {
		t.Fatal("a refused human check left no entry")
	}

	last := entries[len(entries)-1]
	if !last.Failed || last.Action != "sign in" || last.Reason != "human check failed" {
		t.Errorf("the entry is %+v", last)
	}

	for _, entry := range entries {
		if strings.Contains(fmt.Sprintf("%+v", entry), "made-up-and-secret") {
			t.Errorf("the log holds the token: %+v", entry)
		}
	}
}

// Where nothing is configured, nothing changes, and the runtime panel says
// there is no check; where one is, it says which widget and never the secret.
func TestTheRuntimePanelNamesTheWidgetAndNotItsSecret(t *testing.T) {
	plain, plainMux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam", Can: []string{config.Moderate}}})
	if plain.HumanCheck() != nil {
		t.Fatal("an unconfigured surface asks for a human check")
	}

	if status, _ := humanAnswered(plainMux, signing("adam", "correct", "", browserAgent)); status != http.StatusOK {
		t.Fatalf("without a check, signing in answered %d", status)
	}

	api, mux, _, _ := checked(t)
	api.conf.Meet.Admins[0].Can = []string{config.Moderate}

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, signing("adam", "correct", "admin:panel", browserAgent))
	if recorder.Code != http.StatusOK {
		t.Fatalf("signing in answered %d", recorder.Code)
	}

	read := httptest.NewRequest(http.MethodGet, "/api/admin/runtime", nil)
	for _, cookie := range recorder.Result().Cookies() {
		read.AddCookie(cookie)
	}

	runtime := httptest.NewRecorder()
	mux.ServeHTTP(runtime, read)

	if runtime.Code != http.StatusOK {
		t.Fatalf("the runtime panel answered %d", runtime.Code)
	}

	body := runtime.Body.String()
	if !strings.Contains(body, turnstiletest.SiteKey) {
		t.Errorf("the runtime panel does not name the widget: %s", body)
	}
	if strings.Contains(body, turnstiletest.Secret) {
		t.Errorf("the runtime panel shows the secret key: %s", body)
	}
}

// How often a caller may have the door ask Cloudflare is charged to the
// subscriber, an IPv6 address by its /64. Charged to the address alone, a
// review sent one bad token from each of three hundred addresses in one /64
// and Cloudflare was asked three hundred times.
func TestTheBoundOnAskingCloudflareIsBySubscriber(t *testing.T) {
	api, mux, fake, _ := checked(t)
	api.conf.Meet.JoinRate = 0.0001
	api.conf.Meet.JoinBurst = 1
	api.UseHumanCheck(fake.Checker(api.conf.Meet))

	from := func(address string) *http.Request {
		request := signing("adam", "wrong", "made-up-"+address, browserAgent)
		request.RemoteAddr = "[" + address + "]:51234"

		return request
	}

	if status, _ := humanAnswered(mux, from("2001:db8::1")); status != http.StatusForbidden {
		t.Fatalf("the first bad token answered %d, want 403", status)
	}

	for _, address := range []string{"2001:db8::2", "2001:db8::ffff:1", "2001:db8::1:0:0:9"} {
		if status, reason := humanAnswered(mux, from(address)); status != http.StatusTooManyRequests || reason != "too_many_attempts" {
			t.Errorf("another address in the /64, %s, answered %d %q, want 429", address, status, reason)
		}
	}

	if status, _ := humanAnswered(mux, from("2001:db8:0:1::1")); status != http.StatusForbidden {
		t.Errorf("an address in another /64 answered %d, want 403", status)
	}

	if fake.Asked() != 2 {
		t.Errorf("Cloudflare was asked %d times, want 2: once for each /64", fake.Asked())
	}
}

// The runtime panel says whether each of the two ways past the check is open,
// as the process resolved them: both on where the file says nothing, and off
// where it says false. Nothing else on the pages says either.
func TestTheRuntimePanelSaysWhoIsSparedTheCheck(t *testing.T) {
	closed := false

	for _, c := range []struct {
		name  string
		set   *bool
		wants bool
	}{
		{"unwritten", nil, true},
		{"written false", &closed, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			api, mux, _, _ := checked(t)
			api.conf.Meet.Admins[0].Can = []string{config.Moderate}
			api.conf.Meet.Turnstile.ExemptNativeApps = c.set
			api.conf.Meet.Turnstile.ExemptLocal = c.set

			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, signing("adam", "correct", "admin:"+c.name, browserAgent))
			if recorder.Code != http.StatusOK {
				t.Fatalf("signing in answered %d", recorder.Code)
			}

			read := httptest.NewRequest(http.MethodGet, "/api/admin/runtime", nil)
			for _, cookie := range recorder.Result().Cookies() {
				read.AddCookie(cookie)
			}

			runtime := httptest.NewRecorder()
			mux.ServeHTTP(runtime, read)

			var said struct {
				Meet struct {
					Turnstile map[string]any `json:"turnstile"`
				} `json:"meet"`
			}
			if err := json.Unmarshal(runtime.Body.Bytes(), &said); err != nil {
				t.Fatal(err)
			}

			for _, field := range []string{"exemptNativeApps", "exemptLocal"} {
				if got, ok := said.Meet.Turnstile[field].(bool); !ok || got != c.wants {
					t.Errorf("the runtime panel says %s is %v, want %v", field, said.Meet.Turnstile[field], c.wants)
				}
			}
		})
	}
}
