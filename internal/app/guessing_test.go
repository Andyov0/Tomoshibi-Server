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
)

/*
 * A passphrase is checked at three doors and there is one budget between them.
 *
 * The management sign-in was held to ten guesses a minute with a ceiling on the
 * whole endpoint. The join was held to ten a second with no ceiling at all —
 * and the join checks the same secret, against every administrator at once, and
 * says what it found: a room nobody has used opens, a reserved relay refuses,
 * and the host endpoint answers "admin". So did the account sign-in, which
 * accepts an administrator's name and passphrase and returns a session that
 * moderates every room for thirty days.
 *
 * Sixty times the rate through doors nobody had counted as doors. A dictionary
 * that takes years at the sign-in took an afternoon at the join, and nothing in
 * the audit log would have shown it: the join does not write failures down,
 * because until now it had no notion of a failed guess.
 *
 * These tests are about the budget being shared, not about its size. A limit on
 * one door and not the others is not three limits; it is none.
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

// The budget is one budget. Spending it at the join must close the account
// sign-in too, or an attacker simply moves to whichever door is still open.
func TestTheAccountSignInSharesTheJoinsBudget(t *testing.T) {
	_, mux := mountWithAdmin(t, []config.Admin{administrator()})

	for i := 0; i < guess.PerAddress; i++ {
		ask(mux, join("standup", "wrong"))
	}

	recorder := ask(mux, signIn("adam", "wrong"))

	if recorder.Code != http.StatusTooManyRequests {
		t.Errorf("the account sign-in answered %d after the join's budget was spent, want 429", recorder.Code)
	}
}

// And the other way round, because a shared budget that only fills from one
// side is two budgets with extra steps.
func TestTheJoinSharesTheAccountSignInsBudget(t *testing.T) {
	_, mux := mountWithAdmin(t, []config.Admin{administrator()})

	for i := 0; i < guess.PerAddress; i++ {
		ask(mux, signIn("adam", "wrong"))
	}

	if code := ask(mux, join("standup", "wrong")).Code; code != http.StatusTooManyRequests {
		t.Errorf("the join answered %d after the sign-in's budget was spent, want 429", code)
	}
}
