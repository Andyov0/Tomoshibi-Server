package app

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/guess"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * A passphrase is checked at several doors, and each is bounded on its own.
 *
 * The management sign-in was held to ten guesses a minute with a ceiling on the
 * whole endpoint. The join was held to ten a second with no ceiling at all —
 * and the join checks the same secret, against every administrator at once, and
 * says what it found. So every door is bounded.
 *
 * They were one shared budget, and that turned out to be the fault the other
 * way round. Every passphrase join that was not an administrator's counted as a
 * failure, and the join is where everybody with a passphrase arrives — the field
 * is filled from local storage on every visit — so a meeting starting on the
 * hour spent the ceiling by itself, and with it shut the management sign-in,
 * the account sign-in and the enrolment. Nor did it take a meeting: any page
 * could make its visitors' browsers post wrong passphrases to the join.
 *
 * So these tests hold three things. Guessing is still bounded at the join. The
 * ordinary traffic of the join — a browser's own passphrase again, an account's
 * passphrase, no passphrase — spends nothing. And neither a spent join nor a
 * page on another site can shut any other door.
 */

// A deployment with a management side, which is where the budget lives.
func mountWithAdmin(t *testing.T, admins []config.Admin) (*App, http.Handler) {
	t.Helper()

	app, joining := mount(t, admins)
	app.admin = admin.New(app.conf, nil, app.store, tripKey)

	// Both doors on one mux, because the point is that they share a budget and
	// a test that mounted them separately could not tell.
	mux := http.NewServeMux()
	mux.Handle("/api/rooms/", joining)
	mux.HandleFunc("POST /api/account/session", app.accountSignIn)

	return app, mux
}

// signIn asks for an account session, the way the account page does.
func signIn(name, said string) *http.Request {
	body := fmt.Sprintf(`{"name":%q,"passphrase":%q}`, name, said)

	request := httptest.NewRequest(http.MethodPost, "/api/account/session",
		strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	return request
}

func TestGuessingAnAdministratorsPassphraseAtTheJoinIsBounded(t *testing.T) {
	_, mux := mountWithAdmin(t, []config.Admin{administrator()})

	// The whole per-address budget, spent on wrong answers. Each one opens a
	// room — the guess fails, the join does not — so nothing here depends on
	// the join refusing, only on it having been asked.
	for i := 0; i < guess.PerAddress; i++ {
		if code := ask(mux, join("standup", "wrong")).Code; code == http.StatusTooManyRequests {
			t.Fatalf("guess %d was refused before the budget was spent", i)
		}
	}

	if code := ask(mux, join("standup", "wrong")).Code; code != http.StatusTooManyRequests {
		t.Errorf("an eleventh guess answered %d, want 429", code)
	}
}

// The ordinary case, which must not be caught by any of this.
func TestJoiningWithoutAPassphraseIsNotAGuess(t *testing.T) {
	_, mux := mountWithAdmin(t, []config.Admin{administrator()})

	// Well past the guessing budget. Nobody offered a passphrase, so nobody
	// tried anything, and an open room is not rationed at ten a minute.
	for i := 0; i < guess.PerAddress*3; i++ {
		if code := ask(mux, join("standup", "")).Code; code != http.StatusOK {
			t.Fatalf("joining an open room answered %d on attempt %d, want 200", code, i)
		}
	}
}

// Being right costs nothing, so an administrator running a busy deployment does
// not lock themselves out by using it.
func TestTheRightPassphraseAtTheJoinSpendsNothing(t *testing.T) {
	_, mux := mountWithAdmin(t, []config.Admin{administrator()})

	for i := 0; i < guess.PerAddress*2; i++ {
		if code := ask(mux, join("standup", passphrase)).Code; code != http.StatusOK {
			t.Fatalf("an administrator joining answered %d on attempt %d, want 200", code, i)
		}
	}
}

// A browser bringing its own passphrase back is not guessing, however often
// it comes, and neither is somebody typing their account's.
func TestAPassphraseThisBrowserHasUsedIsNotAGuess(t *testing.T) {
	_, mux := mountWithAdmin(t, []config.Admin{administrator()})

	first := ask(mux, join("standup", "my own passphrase"))
	if first.Code != http.StatusOK {
		t.Fatalf("the first join answered %d", first.Code)
	}

	var remembered *http.Cookie
	for _, cookie := range first.Result().Cookies() {
		if cookie.Name == knownCookie {
			remembered = cookie
		}
	}

	if remembered == nil || !remembered.HttpOnly || remembered.SameSite != http.SameSiteStrictMode {
		t.Fatalf("the join left no HttpOnly, SameSite=Strict note of the passphrase: %+v", remembered)
	}

	for i := 0; i < guess.Join*2; i++ {
		request := join("standup", "my own passphrase")
		request.AddCookie(remembered)

		if code := ask(mux, request).Code; code != http.StatusOK {
			t.Fatalf("a browser's own passphrase was refused on its %d-th return: %d", i+2, code)
		}
	}

	// And the note is for that passphrase only: carrying it does not make a
	// different one free, or it would be a way around the budget.
	for i := 0; i < guess.PerAddress; i++ {
		request := join("standup", "a guess")
		request.AddCookie(remembered)
		ask(mux, request)
	}

	request := join("standup", "another guess")
	request.AddCookie(remembered)

	if code := ask(mux, request).Code; code != http.StatusTooManyRequests {
		t.Errorf("guesses carrying another passphrase's note were not charged: %d", code)
	}
}

func TestAnAccountsPassphraseAtTheJoinSpendsNothing(t *testing.T) {
	app, mux := mountWithAdmin(t, []config.Admin{administrator()})

	if err := app.store.AddAccount(store.Account{Name: "ada", Trip: room.Trip(tripKey, "ada's passphrase")}); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < guess.Join*2; i++ {
		if code := ask(mux, join("standup", "ada's passphrase")).Code; code != http.StatusOK {
			t.Fatalf("an account's own passphrase was refused on join %d: %d", i+1, code)
		}
	}
}

// A page on another site cannot spend anything, because it is not answered.
func TestAPageOnAnotherSiteCannotSpendTheJoinsBudget(t *testing.T) {
	_, mux := mountWithAdmin(t, []config.Admin{administrator()})

	for i := 0; i < guess.Join*2; i++ {
		request := join("standup", "a guess posted by somebody else's page")
		request.Header.Set("Sec-Fetch-Site", "cross-site")

		if code := ask(mux, request).Code; code != http.StatusForbidden {
			t.Fatalf("a join posted from another site answered %d, want 403", code)
		}
	}

	if code := ask(mux, join("standup", "a stranger's first passphrase")).Code; code != http.StatusOK {
		t.Errorf("after a page elsewhere posted %d guesses, a real join answered %d", guess.Join*2, code)
	}
}

// Spending the join's budget closes the join and nothing else.
func TestASpentJoinLeavesTheOtherDoorsOpen(t *testing.T) {
	_, mux := mountWithAdmin(t, []config.Admin{administrator()})

	for i := 0; i < guess.PerAddress; i++ {
		ask(mux, join("standup", "wrong"))
	}

	if code := ask(mux, join("standup", "wrong")).Code; code != http.StatusTooManyRequests {
		t.Fatalf("the join's budget was not spent, so this test proves nothing: %d", code)
	}

	if code := ask(mux, signIn("adam", "wrong")).Code; code == http.StatusTooManyRequests {
		t.Error("the account sign-in was shut by guesses at the join")
	}

	// And joining without a passphrase is untouched by any of it.
	if code := ask(mux, join("standup", "")).Code; code != http.StatusOK {
		t.Errorf("an open room was shut by guesses at the join: %d", code)
	}
}

// And the other way round.
func TestASpentSignInLeavesTheJoinOpen(t *testing.T) {
	_, mux := mountWithAdmin(t, []config.Admin{administrator()})

	for i := 0; i < guess.PerAddress; i++ {
		ask(mux, signIn("adam", "wrong"))
	}

	if code := ask(mux, signIn("adam", "wrong")).Code; code != http.StatusTooManyRequests {
		t.Fatalf("the sign-in's budget was not spent, so this test proves nothing: %d", code)
	}

	if code := ask(mux, join("standup", "wrong")).Code; code == http.StatusTooManyRequests {
		t.Error("the join was shut by guesses at the account sign-in")
	}
}
