package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/lockout"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * The sign-in lockout at the account sign-in, and across the two sign-ins.
 *
 * The account sign-in is the one every app uses and the one that accepts an
 * administrator's credentials as well as an account's, so it is where the
 * lockout matters most and where it would be easiest to put in the wrong
 * place: after the request limiter, after the guessing budget, after the
 * passphrase has been judged. These go through a router holding both doors,
 * as startup builds them, so that "counted together" is a claim about one
 * book the two doors share rather than about two that happen to agree.
 */

// bothDoors is the account sign-in and the management sign-in on one mux,
// with an account to sign in as.
func bothDoors(t *testing.T) (*App, http.Handler) {
	t.Helper()

	app, joining := mount(t, []config.Admin{administrator()})
	app.admin = admin.New(app.conf, nil, app.store, tripKey)
	app.admin.Lockout().Describe(clientOf)

	if err := app.store.AddAccount(store.Account{Name: "ada", Trip: room.Trip(tripKey, "ada's passphrase")}); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("/api/rooms/", joining)
	mux.HandleFunc("POST /api/account/session", app.accountSignIn)
	app.admin.Mount(mux)

	return app, mux
}

func manage(name, said string) *http.Request {
	request := signIn(name, said)
	request.URL.Path = "/api/admin/session"
	request.RequestURI = ""

	return request
}

// lockedAnswer is the reason and the lockout's end an answer gives.
func lockedAnswer(t *testing.T, body string) (reason, until string) {
	t.Helper()

	var said struct {
		Error string `json:"error"`
		Until string `json:"until"`
	}
	_ = json.Unmarshal([]byte(body), &said)

	return said.Error, said.Until
}

// shutOutAcross fails six times at the account sign-in and five at the
// management one, the eleventh shutting the caller out. Six and five, because
// each door's budget is ten a minute from one address, so neither door alone
// could take eleven.
func shutOutAcross(t *testing.T, mux http.Handler) {
	t.Helper()

	for i := 0; i < 6; i++ {
		if code := ask(mux, signIn("ada", "wrong")).Code; code != http.StatusUnauthorized {
			t.Fatalf("account failure %d answered %d, want 401", i+1, code)
		}
	}
	for i := 0; i < 4; i++ {
		if code := ask(mux, manage("adam", "wrong")).Code; code != http.StatusUnauthorized {
			t.Fatalf("management failure %d answered %d, want 401", i+1, code)
		}
	}

	eleventh := ask(mux, manage("adam", "wrong"))
	if _, until := lockedAnswer(t, eleventh.Body.String()); eleventh.Code != http.StatusTooManyRequests || until == "" {
		t.Fatalf("the eleventh failure across both doors answered %d %s, want the lockout",
			eleventh.Code, eleventh.Body.String())
	}
}

func TestFailuresAtBothSignInsAreCountedTogether(t *testing.T) {
	_, mux := bothDoors(t)

	shutOutAcross(t, mux)

	// And the account sign-in, where only six of them were, is shut too: with
	// the reason the apps already read, and a right passphrase refused like
	// a wrong one.
	for _, said := range []string{"ada's passphrase", "wrong"} {
		recorder := ask(mux, signIn("ada", said))

		reason, until := lockedAnswer(t, recorder.Body.String())
		if recorder.Code != http.StatusTooManyRequests || reason != reasonRateLimited || until == "" {
			t.Errorf("%q at the account sign-in while shut out answered %d %s, want 429 %s with the lockout's end",
				said, recorder.Code, recorder.Body.String(), reasonRateLimited)
		}
		if recorder.Header().Get("Retry-After") == "" {
			t.Error("no Retry-After on a lockout")
		}
		if len(recorder.Result().Cookies()) != 0 {
			t.Error("a session was given to a caller who is shut out")
		}
	}
}

// Where the lockout is asked, against the two limits in front of the
// passphrase. Neither is visible in what a refused guess spends: a guess the
// budget lets through and the lockout then refuses is settled, which spends
// nothing either, so a test that counted only what was spent passed with the
// lockout asked last. What tells them apart is a limit that is already
// empty. Asked first, the lockout answers with its end whatever the limits
// hold; asked after one of them, the caller is told by that limit to wait a
// moment, with no end and no Retry-After, and every refused request spends
// from a limit the caller's neighbours and the join share.
func TestTheLockoutIsAskedBeforeEitherLimit(t *testing.T) {
	t.Run("the guessing budget", func(t *testing.T) {
		_, mux := bothDoors(t)

		shutOutAcross(t, mux)

		// The six failures here left four of the address's ten. Another
		// device at the address spends them, which shuts nobody out.
		for i := 0; i < 4; i++ {
			other := signIn("ada", "wrong")
			other.Header.Set("User-Agent", "another device")
			if code := ask(mux, other).Code; code != http.StatusUnauthorized {
				t.Fatalf("another device's failure %d answered %d, want 401", i+1, code)
			}
		}

		recorder := ask(mux, signIn("ada", "ada's passphrase"))
		if _, until := lockedAnswer(t, recorder.Body.String()); recorder.Code != http.StatusTooManyRequests || until == "" {
			t.Errorf("the caller shut out, at an empty budget, answered %d %s: the budget was asked first",
				recorder.Code, recorder.Body.String())
		}
		if recorder.Header().Get("Retry-After") == "" {
			t.Error("no Retry-After: the budget was asked first")
		}
	})

	t.Run("the request limit", func(t *testing.T) {
		app, mux := bothDoors(t)

		// A request limit of twenty from the address, which the six failures
		// below spend from and which nothing refills during the test.
		app.limit = limit.New(0.0001, 20, 0)

		shutOutAcross(t, mux)

		for i := 0; i < 30; i++ {
			ask(mux, signIn("ada", "wrong"))
		}

		// Somebody else at the address, on another device, with the right
		// passphrase: let through, because thirty refusals of somebody shut
		// out spent nothing from the limit they share.
		other := signIn("ada", "ada's passphrase")
		other.Header.Set("User-Agent", "another device")
		if recorder := ask(mux, other); recorder.Code != http.StatusOK {
			t.Errorf("another device at the address answered %d %s: the lockout's refusals spent the request limit",
				recorder.Code, recorder.Body.String())
		}
	})
}

// A page on another site cannot have its visitors' browsers count against
// them. It once could, at both sign-ins: eleven no-cors posts of wrong
// passphrases, and the visitor was shut out of both for half an hour, with
// the right passphrase on this deployment's own page.
func TestASignInFromAnotherSiteIsRefusedAndCountsForNothing(t *testing.T) {
	app, mux := bothDoors(t)

	for _, site := range []string{"cross-site", "same-site"} {
		for i := 0; i <= lockout.Failures; i++ {
			for _, door := range []*http.Request{signIn("ada", "wrong"), manage("adam", "wrong")} {
				door.Header.Set("Sec-Fetch-Site", site)

				recorder := ask(mux, door)
				if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), reasonCrossSite) {
					t.Fatalf("a %s sign-in at %s answered %d %s, want 403 %s",
						site, door.URL.Path, recorder.Code, recorder.Body.String(), reasonCrossSite)
				}
			}
		}
	}

	if listed := app.admin.Lockout().Lockouts(); len(listed) != 0 {
		t.Fatalf("%d lockouts from sign-ins another site sent", len(listed))
	}

	// Nor did they spend a budget: the visitor signs in at both, from here.
	for _, door := range []*http.Request{signIn("ada", "ada's passphrase"), manage("adam", passphrase)} {
		door.Header.Set("Sec-Fetch-Site", "same-origin")

		if recorder := ask(mux, door); recorder.Code != http.StatusOK {
			t.Errorf("the visitor's own sign-in at %s answered %d %s", door.URL.Path, recorder.Code, recorder.Body.String())
		}
	}
}

// The join answers the sign-in's question too: the identity it hands back
// is the signature a passphrase makes, and signatures are shown beside every
// name. A caller shut out of signing in carried on guessing there, and read
// the owner's signature back from a join with the owner's passphrase.
func TestAShutOutCallerCannotTryAPassphraseAtTheJoin(t *testing.T) {
	_, mux := bothDoors(t)

	// The account's passphrase, joined with once before the lockout, from a
	// browser that keeps the cookie the join leaves.
	before := ask(mux, join("standup", "ada's passphrase"))
	if before.Code != http.StatusOK {
		t.Fatalf("joining before the lockout answered %d %s", before.Code, before.Body.String())
	}
	remembered := before.Result().Cookies()

	shutOutAcross(t, mux)

	// A passphrase this browser has not joined with: the administrator's,
	// which is the guess worth making, and one nobody has.
	for _, said := range []string{passphrase, "anything at all"} {
		recorder := ask(mux, join("standup", said))

		reason, until := lockedAnswer(t, recorder.Body.String())
		if recorder.Code != http.StatusTooManyRequests || reason != reasonRateLimited || until == "" {
			t.Errorf("a join with %q while shut out answered %d %s, want the lockout", said, recorder.Code, recorder.Body.String())
		}
		if strings.Contains(recorder.Body.String(), "identity") {
			t.Errorf("a join refused for the lockout handed back an identity: %s", recorder.Body.String())
		}
	}

	// Without a passphrase the meeting is still open to them: nothing in the
	// answer belongs to anybody.
	if recorder := ask(mux, join("standup", "")); recorder.Code != http.StatusOK {
		t.Errorf("a join without a passphrase while shut out answered %d %s, want 200", recorder.Code, recorder.Body.String())
	}

	// And the passphrase this browser already joined with is not a guess.
	again := join("standup", "ada's passphrase")
	for _, cookie := range remembered {
		again.AddCookie(cookie)
	}
	if recorder := ask(mux, again); recorder.Code != http.StatusOK {
		t.Errorf("a join with a passphrase this browser joined with before answered %d %s, want 200",
			recorder.Code, recorder.Body.String())
	}

	// Somebody else at the address, on another device, is not shut out of
	// joining with a passphrase either.
	other := join("standup", passphrase)
	other.Header.Set("User-Agent", "another device")
	if recorder := ask(mux, other); recorder.Code != http.StatusOK {
		t.Errorf("another device's join answered %d %s, want 200", recorder.Code, recorder.Body.String())
	}
}

func TestAShutOutCallerSpendsNothingAtTheAccountSignIn(t *testing.T) {
	app, mux := bothDoors(t)

	shutOutAcross(t, mux)

	// Six of the account door's ten were spent before the lockout. Twenty
	// more guesses judged and charged as wrong would spend the other four and
	// have the rest turned away. This holds the lockout in front of the
	// judging; in front of the budget is TestTheLockoutIsAskedBeforeEitherLimit,
	// since a guess the budget lets through and the lockout refuses is settled
	// and spends nothing, wherever the two are asked.
	for i := 0; i < 20; i++ {
		if _, until := lockedAnswer(t, ask(mux, signIn("ada", "wrong")).Body.String()); until == "" {
			t.Fatalf("guess %d while shut out was not answered by the lockout", i+1)
		}
	}

	if _, err := app.admin.Lockout().LiftAll(); err != nil {
		t.Fatal(err)
	}

	// They reached nothing: the four are still there, and the fifth is the
	// budget's own refusal, which names no lockout.
	for i := 0; i < 4; i++ {
		if code := ask(mux, signIn("ada", "wrong")).Code; code != http.StatusUnauthorized {
			t.Fatalf("guess %d after the lift answered %d, want 401: the lockout spent from the budget", i+1, code)
		}
	}

	spent := ask(mux, signIn("ada", "wrong"))
	if _, until := lockedAnswer(t, spent.Body.String()); spent.Code != http.StatusTooManyRequests || until != "" {
		t.Errorf("the budget's own refusal answered %d %s, want 429 naming no lockout", spent.Code, spent.Body.String())
	}
}

// A name that exists and one that does not are answered alike, byte for
// byte: the lockout is decided before the name is read.
func TestALockoutSaysNothingAboutTheName(t *testing.T) {
	_, mux := bothDoors(t)

	shutOutAcross(t, mux)

	known := ask(mux, signIn("ada", "ada's passphrase"))
	unknown := ask(mux, signIn("nobody-has-this-name", "whatever"))

	if known.Code != unknown.Code || known.Body.String() != unknown.Body.String() {
		t.Errorf("a known name answered %d %s and an unknown one %d %s",
			known.Code, known.Body.String(), unknown.Code, unknown.Body.String())
	}
}

// The right passphrase for an account that is blocked is not a guess, and
// neither is a request that offered no passphrase or could not be read.
func TestOnlyAPassphraseThatDidNotMatchIsCounted(t *testing.T) {
	app, mux := bothDoors(t)

	if err := app.store.AddAccount(store.Account{Name: "bea", Trip: room.Trip(tripKey, "bea's passphrase"), Blocked: true}); err != nil {
		t.Fatal(err)
	}

	for i := 0; i <= lockout.Failures*2; i++ {
		if code := ask(mux, signIn("bea", "bea's passphrase")).Code; code != http.StatusForbidden {
			t.Fatalf("a blocked account's sign-in %d answered %d, want 403", i+1, code)
		}
	}

	// Five real failures at the management sign-in, so that six more counted
	// anywhere would cross the line.
	for i := 0; i < 5; i++ {
		ask(mux, manage("adam", "wrong"))
	}

	// Six bodies read whole that offered no passphrase: refused as a wrong
	// pair and charged to the budget, which allows ten a minute, and never
	// counted.
	for i := 0; i < 6; i++ {
		empty := signIn("ada", "")
		if i%2 == 1 {
			empty = signIn("", "")
		}
		if code := ask(mux, empty).Code; code != http.StatusUnauthorized {
			t.Fatalf("a sign-in offering no passphrase answered %d, want 401", code)
		}
	}

	// And bodies that could not be read whole, which are refused before
	// anything in them is looked at, a field of the wrong type among them.
	for _, raw := range []string{`{"name":5,"passphrase":"wrong"}`, `{"name":"ada","passphrase":"wrong","turnstile":5}`, `{`, ``} {
		for i := 0; i < 3; i++ {
			unread := signIn("", "")
			unread.Body = io.NopCloser(strings.NewReader(raw))
			if recorder := ask(mux, unread); recorder.Code != http.StatusBadRequest || refusedWith(recorder) != reasonUnreadable {
				t.Fatalf("%q answered %d %s, want 400 %s", raw, recorder.Code, recorder.Body.String(), reasonUnreadable)
			}
		}
	}

	if listed := app.admin.Lockout().Lockouts(); len(listed) != 0 {
		t.Errorf("shut out for %d lockouts by sign-ins that were not guesses", len(listed))
	}
}

// Signing in clears nothing, at either door. A success that cleared the
// count was a way past the rule for anybody holding an account: a review
// failed ten times at an administrator's name, signed in to its own account
// from the same address and device, and failed ten more at the management
// sign-in without being shut out. Here the five and five before the
// success, and the one after it, are eleven.
func TestSigningInClearsNothingAtEitherDoor(t *testing.T) {
	_, mux := bothDoors(t)

	for i := 0; i < 5; i++ {
		ask(mux, signIn("adam", "wrong"))
	}
	for i := 0; i < 5; i++ {
		ask(mux, manage("adam", "wrong"))
	}

	if code := ask(mux, signIn("ada", "ada's passphrase")).Code; code != http.StatusOK {
		t.Fatalf("signing in at the account door answered %d", code)
	}
	if code := ask(mux, manage("adam", passphrase)).Code; code != http.StatusOK {
		t.Fatalf("signing in at the management door answered %d", code)
	}

	recorder := ask(mux, manage("adam", "wrong"))
	if _, until := lockedAnswer(t, recorder.Body.String()); recorder.Code != http.StatusTooManyRequests || until == "" {
		t.Errorf("the eleventh failure, after a success at each door, answered %d %s, want the lockout",
			recorder.Code, recorder.Body.String())
	}
}

// The device a lockout names is read as a join's is, which is what lets the
// management page describe it as it describes everybody else's.
func TestALockoutNamesItsDeviceAsAJoinWould(t *testing.T) {
	app, mux := bothDoors(t)

	agent := "Tomoshibi/0.1.0.8 (iPhone; iOS 27.0.1; iPhone17,1)"

	for i := 0; i <= lockout.Failures; i++ {
		door := signIn("ada", "wrong")
		if i >= 6 {
			door = manage("adam", "wrong")
		}
		door.Header.Set("User-Agent", agent)
		ask(mux, door)
	}

	listed := app.admin.Lockout().Lockouts()
	if len(listed) != 1 {
		t.Fatalf("%d lockouts, want 1", len(listed))
	}

	client := listed[0].Client
	if client == nil || client.Kind != "iphone" || client.App != "0.1.0.8" || client.Agent != agent {
		t.Errorf("the device was read as %s", fmt.Sprintf("%+v", client))
	}

	if !strings.Contains(strings.Join(listed[0].Doors, ","), lockout.Account) ||
		!strings.Contains(strings.Join(listed[0].Doors, ","), lockout.Management) {
		t.Errorf("doors %v, want both", listed[0].Doors)
	}
}

// A Linux app shut out is listed as the Linux app, with its distribution and
// its machine whole, processor included, rather than as "an app that did not
// say which": the accounts page's list and the log page name a lockout's
// device from these parts, and the processor is what somebody lifting it asks
// about first.
func TestALockedOutLinuxAppIsListedAsTheLinuxApp(t *testing.T) {
	app, mux := bothDoors(t)

	agent := "Tomoshibi/0.1.7 (Linux; Ubuntu 24.04.4 LTS; Micro-Star International Co., Ltd. Prestige 14 AI Evo C1MG x86_64)"

	for i := 0; i <= lockout.Failures; i++ {
		door := signIn("ada", "wrong")
		if i >= 6 {
			door = manage("adam", "wrong")
		}
		door.Header.Set("User-Agent", agent)
		ask(mux, door)
	}

	listed := app.admin.Lockout().Lockouts()
	if len(listed) != 1 {
		t.Fatalf("%d lockouts, want 1", len(listed))
	}

	want := store.Client{
		Kind: "linux", App: "0.1.7", System: "Ubuntu 24.04.4 LTS",
		Device: "Micro-Star International Co., Ltd. Prestige 14 AI Evo C1MG x86_64", Agent: agent,
	}
	if client := listed[0].Client; client == nil || *client != want {
		t.Errorf("the Linux app was listed as %s, want %+v", fmt.Sprintf("%+v", client), want)
	}
}

// A refusal by the guessing budget is not a failed sign-in at the account
// door either. Ten failures spend the budget of ten a minute; what follows is
// the budget's refusal, with no end, and nobody is shut out.
func TestABudgetRefusalIsNotCountedAtTheAccountDoor(t *testing.T) {
	app, mux := bothDoors(t)

	for i := 0; i < lockout.Failures; i++ {
		if code := ask(mux, signIn("ada", "wrong")).Code; code != http.StatusUnauthorized {
			t.Fatalf("failure %d answered %d, want 401", i+1, code)
		}
	}

	for range 3 {
		recorder := ask(mux, signIn("ada", "wrong"))
		if reason, until := lockedAnswer(t, recorder.Body.String()); recorder.Code != http.StatusTooManyRequests || reason != reasonRateLimited || until != "" {
			t.Fatalf("past the budget the account door answered %d %s, want the budget's 429 with no end",
				recorder.Code, recorder.Body.String())
		}
	}

	if listed := app.admin.Lockout().Lockouts(); len(listed) != 0 {
		t.Errorf("the budget's refusals shut the caller out: %+v", listed)
	}
}
