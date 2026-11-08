package app

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/guess"
	"tomoshibi/internal/lockout"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
	"tomoshibi/internal/turnstile/turnstiletest"
)

/*
 * The guards as startup wires them, and nothing put in by hand.
 *
 * Every other test of the human check hands the server a checker that asks a
 * stand-in, after New has built it, and every other test of the lockout
 * either builds the book itself or keeps the server running throughout. So
 * none of them could see New stop wiring the configured check, the store stop
 * reaching the book, or the book stop reading user agents as the joins do,
 * and a review removed each of those and the whole suite stayed green. Turned
 * off by any of them, production would have no human check on any door, or a
 * restart would let everybody shut out back in, or the page would call an
 * iPhone "other", all silently.
 *
 * No token here is ever sent anywhere: a door refuses a sign-in with no token
 * before it asks Cloudflare, which is all the first test needs, and the rest
 * configure no check.
 */

// assembled is a control node built exactly as startup builds it on the store
// at path, with an administrator named boss and an account named ada.
func assembled(t *testing.T, path string, human bool) (*App, *store.Store, http.Handler) {
	t.Helper()

	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	trip := room.Trip(tripKey, bossSaid)
	if _, ok := st.AdminBySignature(trip); !ok {
		if err := st.AddAdmin(store.Admin{Trip: trip, Name: "boss"}); err != nil {
			t.Fatal(err)
		}
		if err := st.AddAccount(store.Account{Name: "ada", Trip: room.Trip(tripKey, "ada's passphrase")}); err != nil {
			t.Fatal(err)
		}
	}

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			Role:       config.RoleControl,
			Listen:     "127.0.0.1:8080",
			TrustProxy: true,
			Proxies:    2,
			TokenTTL:   5 * time.Minute,
			JoinRate:   1000,
			JoinBurst:  1000,
			SourceURL:  source,
		},
	}
	if human {
		conf.Meet.Turnstile = turnstiletest.Config()
	}

	app := New(conf, st, nil, http.NotFoundHandler(), tripKey)

	return app, st, app.Handler()
}

// A configured meet.turnstile is a human check at both doors, with nothing
// but the configuration asking for it: a browser with no token is refused at
// each, and the page is told the widget. Without the configuration, the same
// sign-ins reach the passphrase.
func TestAConfiguredHumanCheckIsAskedForAsStartupBuildsIt(t *testing.T) {
	app, st, mux := assembled(t, filepath.Join(t.TempDir(), "meet.db"), true)
	t.Cleanup(func() { app.Close(); st.Close() })

	if app.admin.HumanCheck().SiteKey() != turnstiletest.SiteKey {
		t.Fatalf("the assembled server asks for the widget %q", app.admin.HumanCheck().SiteKey())
	}

	for _, door := range []struct{ path, name, said string }{
		{accountDoor, "ada", "ada's passphrase"},
		{managementDoor, "boss", bossSaid},
	} {
		recorder := ask(mux, throughNginx(door.path, door.name, door.said, "", browser, "198.51.100.60"))
		if recorder.Code != http.StatusBadRequest || refusedWith(recorder) != "human_check_missing" || handedSession(recorder) {
			t.Errorf("%s answered a browser with no token %d %s, want 400 human_check_missing",
				door.path, recorder.Code, recorder.Body.String())
		}
	}

	if body := ask(mux, httptest.NewRequest(http.MethodGet, "/api/deployment", nil)).Body.String(); !strings.Contains(body, turnstiletest.SiteKey) {
		t.Errorf("the deployment does not name the widget: %s", body)
	}

	plain, plainStore, plainMux := assembled(t, filepath.Join(t.TempDir(), "plain.db"), false)
	t.Cleanup(func() { plain.Close(); plainStore.Close() })

	if recorder := ask(plainMux, throughNginx(accountDoor, "ada", "ada's passphrase", "", browser, "198.51.100.60")); recorder.Code != http.StatusOK {
		t.Errorf("with no check configured, the account door answered %d %s", recorder.Code, recorder.Body.String())
	}
}

// A lockout outlives a restart of the server as startup builds it, and names
// the device as a join would. Read back through New on the same store, the
// caller is still refused with the right passphrase and the page still lists
// them as an iPhone.
func TestALockoutOutlivesARestartOfTheAssembledServer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meet.db")
	const caller = "198.51.100.61"

	app, st, mux := assembled(t, path, false)

	for i := range 6 {
		if recorder := ask(mux, throughNginx(accountDoor, "boss", "wrong", "", iPhoneApp, caller)); recorder.Code != http.StatusUnauthorized {
			t.Fatalf("account failure %d answered %d %s", i+1, recorder.Code, recorder.Body.String())
		}
	}
	for i := range 5 {
		recorder := ask(mux, throughNginx(managementDoor, "boss", "wrong", "", iPhoneApp, caller))
		if i < 4 && recorder.Code != http.StatusUnauthorized {
			t.Fatalf("management failure %d answered %d %s", i+1, recorder.Code, recorder.Body.String())
		}
		if i == 4 && !lockedOutAnswer(recorder, "too_many_attempts") {
			t.Fatalf("the eleventh failure answered %d %s, want the lockout", recorder.Code, recorder.Body.String())
		}
	}

	listed := app.admin.Lockout().Lockouts()
	if len(listed) != 1 || listed[0].Client == nil || listed[0].Client.Kind != "iphone" || listed[0].Client.App != "0.1.0.8" {
		t.Fatalf("lockouts %+v, want one iPhone app", listed)
	}

	app.Close()
	st.Close()

	again, againStore, againMux := assembled(t, path, false)
	t.Cleanup(func() { again.Close(); againStore.Close() })

	if recorder := ask(againMux, throughNginx(accountDoor, "boss", bossSaid, "", iPhoneApp, caller)); !lockedOutAnswer(recorder, reasonRateLimited) {
		t.Errorf("after a restart the shut-out app's right passphrase answered %d %s, want the lockout",
			recorder.Code, recorder.Body.String())
	}

	if listed := again.admin.Lockout().Lockouts(); len(listed) != 1 || listed[0].Address != caller {
		t.Errorf("after a restart the lockouts are %+v, want the one at %s", listed, caller)
	}
}

// The hourly sweep clears lockouts that have ended out of the store, which
// would otherwise keep a row for every caller ever shut out.
func TestTheSweepClearsEndedLockoutsFromTheStore(t *testing.T) {
	app, st, _ := assembled(t, filepath.Join(t.TempDir(), "meet.db"), false)
	t.Cleanup(func() { app.Close(); st.Close() })

	ended := time.Now().UTC().Add(-time.Hour)
	if err := st.KeepLockout(store.Lockout{
		Key: "ended", Address: "198.51.100.62", Since: ended.Add(-lockout.For), Until: ended, Failures: 11,
	}); err != nil {
		t.Fatal(err)
	}

	app.sweep()

	// Read as of a moment the lockout was still in force, which is what
	// would still list it if the sweep had left its row.
	if held, err := st.Lockouts(ended.Add(-time.Minute)); err != nil || len(held) != 0 {
		t.Errorf("after the sweep the store still holds %+v (%v)", held, err)
	}
}

// A request another site's page made is refused before anything else at
// both doors: before the lockout, the request limits, the human check and
// the guessing budget. Each is shown by what the refusal would otherwise be.
// Asked after the lockout, a shut-out caller's would be the lockout's 429;
// after the check, Cloudflare would be asked about its token and the token
// spent; after the budget, an address that had spent it would be told to
// wait. It is 403 cross_site every time.
func TestARequestFromAnotherSiteIsRefusedFirst(t *testing.T) {
	crossSite := func(r *http.Request) *http.Request {
		r.Header.Set("Sec-Fetch-Site", "cross-site")
		return r
	}
	refusedAsCrossSite := func(t *testing.T, recorder *httptest.ResponseRecorder, what string) {
		t.Helper()

		if recorder.Code != http.StatusForbidden || refusedWith(recorder) != reasonCrossSite {
			t.Errorf("%s answered %d %s, want 403 %s", what, recorder.Code, recorder.Body.String(), reasonCrossSite)
		}
	}

	t.Run("a caller who is shut out", func(t *testing.T) {
		app, mux, _ := controlNode(t, nil)

		const caller = "198.51.100.70"
		who := lockout.Of(throughNginx(accountDoor, "", "", "", browser, caller), app.conf.Meet.Hops())
		for range lockout.Failures + 1 {
			app.admin.Lockout().Failed(httptest.NewRecorder(), who, lockout.Account, reasonRateLimited)
		}

		refusedAsCrossSite(t, ask(mux, crossSite(throughNginx(accountDoor, "ada", "wrong", "good:x1", browser, caller))), "the account door")
		refusedAsCrossSite(t, ask(mux, crossSite(throughNginx(managementDoor, "boss", "wrong", "admin:x1", browser, caller))), "the management door")
	})

	t.Run("with a good token", func(t *testing.T) {
		_, mux, fake := controlNode(t, nil)

		refusedAsCrossSite(t, ask(mux, crossSite(throughNginx(accountDoor, "ada", "ada's passphrase", "good:x2", browser, "198.51.100.71"))), "the account door")
		refusedAsCrossSite(t, ask(mux, crossSite(throughNginx(managementDoor, "boss", bossSaid, "admin:x2", browser, "198.51.100.71"))), "the management door")

		if fake.Asked() != 0 {
			t.Errorf("Cloudflare was asked %d times about requests from another site", fake.Asked())
		}

		// The tokens were not spent, so the same page's own sign-ins use them.
		if recorder := ask(mux, throughNginx(accountDoor, "ada", "ada's passphrase", "good:x2", browser, "198.51.100.71")); recorder.Code != http.StatusOK {
			t.Errorf("the token afterwards answered %d %s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("from an address that spent its budget", func(t *testing.T) {
		_, mux, _ := controlNode(t, nil)

		const caller = "198.51.100.72"

		// Spent with the apps' agent at the account door, which no check
		// stands in front of, and with good tokens at the management door;
		// each budget is ten a minute from an address. A second agent, so
		// that the address is spent without anybody being shut out.
		for i := range guess.PerAddress {
			ask(mux, throughNginx(accountDoor, "ada", "wrong", "", iPhoneApp, caller))
			ask(mux, throughNginx(managementDoor, "boss", "wrong", fmt.Sprintf("admin:s%d", i), browser, caller))
		}
		if recorder := ask(mux, throughNginx(accountDoor, "ada", "wrong", "", "Tomoshibi/0.1.0.8 (Android; Android 16; samsung SM-F956B)", caller)); recorder.Code != http.StatusTooManyRequests {
			t.Fatalf("the account budget was not spent: %d %s", recorder.Code, recorder.Body.String())
		}

		refusedAsCrossSite(t, ask(mux, crossSite(throughNginx(accountDoor, "ada", "wrong", "", iPhoneApp, caller))), "the account door")
		refusedAsCrossSite(t, ask(mux, crossSite(throughNginx(managementDoor, "boss", "wrong", "admin:s-last", "Tomoshibi/0.1.0.8 (Android; Android 16; samsung SM-F956B)", caller))), "the management door")
	})
}

// At the management door the lockout is asked before the request limit, as
// at the account door. Asked after it, a shut-out caller's refusals would
// spend the limit everybody at the address shares, and once it was spent the
// caller would be told to wait a moment, with no end and no Retry-After.
func TestTheLockoutIsAskedBeforeTheManagementDoorsRequestLimit(t *testing.T) {
	app, mux, _ := controlNode(t, func(m *config.Meet) {
		m.JoinRate = 0.0001
		m.JoinBurst = 2
	})

	const caller = "198.51.100.73"
	who := lockout.Of(throughNginx(managementDoor, "", "", "", browser, caller), app.conf.Meet.Hops())
	for range lockout.Failures + 1 {
		app.admin.Lockout().Failed(httptest.NewRecorder(), who, lockout.Management, "too_many_attempts")
	}

	for i := range 5 {
		recorder := ask(mux, throughNginx(managementDoor, "boss", bossSaid, fmt.Sprintf("admin:l%d", i), browser, caller))
		if !lockedOutAnswer(recorder, "too_many_attempts") {
			t.Fatalf("the shut-out caller's request %d answered %d %s, want the lockout", i+1, recorder.Code, recorder.Body.String())
		}
	}

	// Another device at the address still has the limit to itself, and gets
	// as far as the check.
	other := ask(mux, throughNginx(managementDoor, "boss", bossSaid, "", "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0", caller))
	if other.Code != http.StatusBadRequest || refusedWith(other) != "human_check_missing" {
		t.Errorf("another device at the address answered %d %s, want 400 human_check_missing: the shut-out caller spent the limit",
			other.Code, other.Body.String())
	}
}
