package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/guess"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
	"tomoshibi/internal/turnstile/turnstiletest"
)

/*
 * The human check at the account door.
 *
 * The door is shared: the front page, the account page and the native apps all
 * sign in here. So three things are held. A browser without a good token is
 * turned away, with a code for each of the three ways that happens. The apps,
 * which the owner decided are never asked for the check, are let through
 * while the switch says so, administrators as well as accounts, and not once
 * it is closed. And the check sits in the right place: after the
 * request limit, so that Cloudflare is asked no more often than anybody may ask
 * this, and before the guessing budget, so that a request with a bad token is
 * not charged as a guess — which, the other way round, would let anybody shut
 * the door on everybody else by sending rubbish.
 *
 * Cloudflare is a stand-in (turnstiletest) and every key is a published testing
 * key.
 */

// What the front page's browser says it is.
const browser = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

// What the apps' shared core says, as core/protocol/src/api/agent.rs writes it.
const nativeApp = "Tomoshibi/0.1.7.1 (Android; Android 16; samsung SM-F956B)"

// humanChecked is a deployment whose account door asks for a human check,
// with an account named ada. tweak may change the configuration before the
// check is made from it.
func humanChecked(t *testing.T, tweak func(*config.Meet)) (*App, http.Handler, *turnstiletest.Cloudflare) {
	t.Helper()

	app, _ := mount(t, nil)
	app.conf.Meet.Turnstile = turnstiletest.Config()
	if tweak != nil {
		tweak(&app.conf.Meet)
	}

	fake := turnstiletest.Start(t)
	app.admin = admin.New(app.conf, nil, app.store, tripKey)
	app.admin.UseHumanCheck(fake.Checker(app.conf.Meet))

	if err := app.store.AddAccount(store.Account{Name: "ada", Trip: room.Trip(tripKey, "ada's passphrase")}); err != nil {
		t.Fatal(err)
	}

	// Registered the way Handler registers them.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/deployment", app.deployment)
	app.mountAccounts(mux)

	return app, mux, fake
}

// accountSigningIn is a sign-in from agent, carrying token where it is not
// empty.
func accountSigningIn(name, said, token, agent string) *http.Request {
	body := fmt.Sprintf(`{"name":%q,"passphrase":%q}`, name, said)
	if token != "" {
		body = fmt.Sprintf(`{"name":%q,"passphrase":%q,"turnstile":%q}`, name, said, token)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/account/session", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", agent)

	return request
}

// refusedWith is the code a refused request came back with.
func refusedWith(recorder *httptest.ResponseRecorder) string {
	var said struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &said)

	return said.Error
}

func TestTheAccountDoorAsksABrowserForAHumanCheck(t *testing.T) {
	cases := []struct {
		name   string
		tweak  func(*config.Meet)
		down   bool
		token  string
		agent  string
		status int
		reason string
	}{
		{"a good token and the right passphrase sign in", nil, false, "good:1", browser, http.StatusOK, ""},
		{"no token is missing", nil, false, "", browser, http.StatusBadRequest, "human_check_missing"},
		{"a token Cloudflare does not know fails", nil, false, "made-up", browser, http.StatusForbidden, "human_check_failed"},
		{"a token from the widget's other site fails", nil, false, "elsewhere:1", browser, http.StatusForbidden, "human_check_failed"},
		{"the management door's token fails here", nil, false, "admin:1", browser, http.StatusForbidden, "human_check_failed"},
		{"Cloudflare unreachable is its own refusal, and still a refusal", nil, true, "good:1", browser, http.StatusServiceUnavailable, "human_check_unavailable"},
		{"an app signs in without a token while the apps are exempt", nil, false, "", nativeApp, http.StatusOK, ""},
		{"so does one from before the core said what it was", nil, false, "", "", http.StatusOK, ""},
		{"and no longer once the switch is closed",
			func(m *config.Meet) { closed := false; m.Turnstile.ExemptNativeApps = &closed },
			false, "", nativeApp, http.StatusBadRequest, "human_check_missing"},
		{"a closed switch still lets an app with a good token in",
			func(m *config.Meet) { closed := false; m.Turnstile.ExemptNativeApps = &closed },
			false, "good:1", nativeApp, http.StatusOK, ""},
		{"a script calling itself curl is not an app", nil, false, "", "curl/8.7.1", http.StatusBadRequest, "human_check_missing"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, mux, fake := humanChecked(t, c.tweak)
			if c.down {
				fake.Down()
			}

			recorder := ask(mux, accountSigningIn("ada", "ada's passphrase", c.token, c.agent))

			if recorder.Code != c.status || refusedWith(recorder) != c.reason {
				t.Fatalf("answered %d %q, want %d %q", recorder.Code, refusedWith(recorder), c.status, c.reason)
			}

			signedIn := false
			for _, cookie := range recorder.Result().Cookies() {
				signedIn = signedIn || (cookie.Name == accountCookie && cookie.Value != "")
			}
			if signedIn != (c.status == http.StatusOK) {
				t.Errorf("a session cookie was set: %v, want %v", signedIn, c.status == http.StatusOK)
			}
		})
	}
}

// A token is good once. The second sign-in with the same one is refused,
// though the first was let in.
func TestAReusedTokenIsRefusedAtTheAccountDoor(t *testing.T) {
	_, mux, _ := humanChecked(t, nil)

	if code := ask(mux, accountSigningIn("ada", "ada's passphrase", "good:once", browser)).Code; code != http.StatusOK {
		t.Fatalf("the first use answered %d", code)
	}

	recorder := ask(mux, accountSigningIn("ada", "ada's passphrase", "good:once", browser))
	if recorder.Code != http.StatusForbidden || refusedWith(recorder) != "human_check_failed" {
		t.Errorf("the second use answered %d %q, want 403 human_check_failed", recorder.Code, refusedWith(recorder))
	}
}

// Requests without a good token are not guesses. Far past the per-address and
// overall budgets of bad tokens, the right passphrase with a good token still
// signs in; and the same number of wrong passphrases with good tokens does
// shut the door, which is what shows the budget was there to be spent.
func TestABadTokenSpendsNothingFromTheGuessingBudget(t *testing.T) {
	_, mux, _ := humanChecked(t, nil)

	for i := range guess.Overall + guess.PerAddress {
		recorder := ask(mux, accountSigningIn("ada", "wrong", fmt.Sprintf("made-up-%d", i), browser))
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("bad token %d answered %d, want 403", i, recorder.Code)
		}
	}

	if code := ask(mux, accountSigningIn("ada", "ada's passphrase", "good:after", browser)).Code; code != http.StatusOK {
		t.Fatalf("after bad tokens, the right passphrase answered %d, want 200", code)
	}

	for i := range guess.PerAddress {
		if code := ask(mux, accountSigningIn("ada", "wrong", fmt.Sprintf("good:%d", i), browser)).Code; code != http.StatusUnauthorized {
			t.Fatalf("guess %d with a good token answered %d, want 401", i, code)
		}
	}

	if code := ask(mux, accountSigningIn("ada", "ada's passphrase", "good:last", browser)).Code; code != http.StatusTooManyRequests {
		t.Errorf("past the budget in real guesses, the door answered %d, want 429", code)
	}
}

// The order held where it can be seen. A guessing budget holds a slot for
// every attempt between being let through and being decided, so a check made
// after the budget is taken holds one for as long as Cloudflare takes to
// answer: a per-address budget's worth of rubbish tokens, sent at once and
// answered slowly, then shuts the door on a good one. Sent one at a time, as
// the test above sends them, the slots are back before the next request and
// the wrong order passes; this is what fails it.
func TestBadTokensWaitingOnCloudflareHoldNoneOfTheBudget(t *testing.T) {
	app, mux, fake := humanChecked(t, nil)
	app.admin.UseHumanCheck(fake.PatientChecker(app.conf.Meet))
	fake.Hold(t)

	codes := make([]int, guess.PerAddress)

	var waiting sync.WaitGroup
	for i := range guess.PerAddress {
		waiting.Go(func() {
			codes[i] = ask(mux, accountSigningIn("ada", "wrong", fmt.Sprintf("held:%d", i), browser)).Code
		})
	}

	fake.AwaitHeld(t, guess.PerAddress)

	if code := ask(mux, accountSigningIn("ada", "ada's passphrase", "good:meanwhile", browser)).Code; code != http.StatusOK {
		t.Errorf("with %d bad tokens waiting on Cloudflare, the right passphrase answered %d, want 200",
			guess.PerAddress, code)
	}

	fake.Release()
	waiting.Wait()

	for i, code := range codes {
		if code != http.StatusForbidden {
			t.Errorf("held bad token %d answered %d, want 403", i, code)
		}
	}
}

// The apps' exemption lets administrators in as it lets accounts in.
//
// The owner's decision: the apps are never asked for a human check, for any
// account, and an administrator signs in to an app with their own name and
// passphrase like everybody else. An earlier version refused an
// administrator's pair from an app as a wrong one, which left administrators
// unable to use the apps at all while a check was configured; the sign-in
// lockout and the guessing budget are what stand in front of an app's
// sign-in instead, and the next tests hold those.
func TestTheAppsExemptionLetsAnAdministratorIn(t *testing.T) {
	const bossSaid = "the boss's passphrase"

	withBoss := func(t *testing.T, app *App) {
		t.Helper()

		if err := app.store.AddAdmin(store.Admin{Trip: room.Trip(tripKey, bossSaid), Name: "boss"}); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("from every way an app is recognised", func(t *testing.T) {
		for _, agent := range []string{nativeApp, "", "   ", "Tomoshibi/x (anything at all)"} {
			app, mux, fake := humanChecked(t, nil)
			withBoss(t, app)

			recorder := ask(mux, accountSigningIn("boss", bossSaid, "", agent))
			if recorder.Code != http.StatusOK {
				t.Errorf("from %q, the administrator's passphrase answered %d %q, want 200",
					agent, recorder.Code, refusedWith(recorder))
				continue
			}

			var me struct {
				Name  string `json:"name"`
				Admin bool   `json:"admin"`
			}
			_ = json.Unmarshal(recorder.Body.Bytes(), &me)
			if me.Name != "boss" || !me.Admin {
				t.Errorf("from %q, the administrator was signed in as %s", agent, recorder.Body.String())
			}

			handed := false
			for _, cookie := range recorder.Result().Cookies() {
				handed = handed || (cookie.Name == accountCookie && cookie.Value != "")
			}
			if !handed {
				t.Errorf("from %q, the administrator was handed no session", agent)
			}

			if fake.Asked() != 0 {
				t.Errorf("from %q, Cloudflare was asked %d times about an app's sign-in", agent, fake.Asked())
			}
		}
	})

	t.Run("and a wrong passphrase from an app is still a wrong pair", func(t *testing.T) {
		app, mux, _ := humanChecked(t, nil)
		withBoss(t, app)

		recorder := ask(mux, accountSigningIn("boss", "a wrong guess", "", nativeApp))
		if recorder.Code != http.StatusUnauthorized || refusedWith(recorder) != reasonNotYours {
			t.Errorf("a wrong passphrase from an app answered %d %q, want 401 %s",
				recorder.Code, refusedWith(recorder), reasonNotYours)
		}
	})

	t.Run("and the administrator from a browser that passed the check", func(t *testing.T) {
		app, mux, _ := humanChecked(t, nil)
		withBoss(t, app)

		if code := ask(mux, accountSigningIn("boss", bossSaid, "good:boss", browser)).Code; code != http.StatusOK {
			t.Errorf("the administrator with a good token answered %d, want 200", code)
		}
	})

	t.Run("but not from a browser without a token", func(t *testing.T) {
		app, mux, _ := humanChecked(t, nil)
		withBoss(t, app)

		recorder := ask(mux, accountSigningIn("boss", bossSaid, "", browser))
		if recorder.Code != http.StatusBadRequest || refusedWith(recorder) != "human_check_missing" {
			t.Errorf("the administrator from a browser with no token answered %d %q, want 400 human_check_missing",
				recorder.Code, refusedWith(recorder))
		}
	})

	t.Run("or from an app where no check is configured", func(t *testing.T) {
		app, mux := mountWithAdmin(t, nil)
		withBoss(t, app)

		if code := ask(mux, accountSigningIn("boss", bossSaid, "", nativeApp)).Code; code != http.StatusOK {
			t.Errorf("without a check, the administrator from an app answered %d, want 200", code)
		}
	})
}

// The refusal says nothing about the account: a name that has one and a name
// that does not are refused alike, before either is looked up.
func TestABadTokenSaysNothingAboutTheName(t *testing.T) {
	_, mux, _ := humanChecked(t, nil)

	known := ask(mux, accountSigningIn("ada", "ada's passphrase", "made-up-1", browser))
	unknown := ask(mux, accountSigningIn("nobody", "anything", "made-up-2", browser))

	if known.Code != unknown.Code || known.Body.String() != unknown.Body.String() {
		t.Errorf("a known name answered %d %s and an unknown one %d %s",
			known.Code, known.Body.String(), unknown.Code, unknown.Body.String())
	}
}

// The request limit comes first, so that Cloudflare is asked no more often
// than anybody may ask this door.
func TestTheRequestLimitIsAskedBeforeCloudflare(t *testing.T) {
	app, mux, fake := humanChecked(t, nil)
	app.limit = limit.New(0.0001, 1, 0)

	ask(mux, accountSigningIn("ada", "wrong", "made-up-1", browser))

	if code := ask(mux, accountSigningIn("ada", "wrong", "made-up-2", browser)).Code; code != http.StatusTooManyRequests {
		t.Fatalf("past the request limit the door answered %d, want 429", code)
	}

	if fake.Asked() != 1 {
		t.Errorf("Cloudflare was asked %d times, want once: the refused request was sent on", fake.Asked())
	}
}

// Where nothing is configured, nothing changes: no token is asked for, and the
// page is told of no widget.
func TestWithNoHumanCheckTheAccountDoorIsAsItWas(t *testing.T) {
	app, mux := mountWithAdmin(t, nil)
	if err := app.store.AddAccount(store.Account{Name: "ada", Trip: room.Trip(tripKey, "ada's passphrase")}); err != nil {
		t.Fatal(err)
	}

	if code := ask(mux, accountSigningIn("ada", "ada's passphrase", "", browser)).Code; code != http.StatusOK {
		t.Errorf("signing in without a check configured answered %d, want 200", code)
	}

	deployed := http.NewServeMux()
	deployed.HandleFunc("GET /api/deployment", app.deployment)

	if body := ask(deployed, httptest.NewRequest(http.MethodGet, "/api/deployment", nil)).Body.String(); strings.Contains(body, "turnstile") {
		t.Errorf("a deployment with no check tells the page of one: %s", body)
	}
}

// The page learns the widget from where it learns everything else before
// anybody has typed, and learns the site key and nothing else about it.
func TestTheDeploymentNamesTheWidget(t *testing.T) {
	_, mux, _ := humanChecked(t, nil)

	recorder := ask(mux, httptest.NewRequest(http.MethodGet, "/api/deployment", nil))

	var said struct {
		Turnstile map[string]any `json:"turnstile"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatal(err)
	}

	if said.Turnstile["siteKey"] != turnstiletest.SiteKey || len(said.Turnstile) != 1 {
		t.Errorf("the deployment says %v about its widget, want the site key alone", said.Turnstile)
	}

	if strings.Contains(recorder.Body.String(), turnstiletest.Secret) {
		t.Errorf("the deployment hands out the secret key: %s", recorder.Body.String())
	}
}
