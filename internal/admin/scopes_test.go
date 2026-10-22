package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * Giving somebody a scope, from the accounts page.
 *
 * A tag is a key to every room held under it, so what is worth guarding is that
 * the page cannot write one the door would read differently — a capital letter,
 * a space, a second `@` — and that writing one leaves a line in the record saying
 * who gave it. A tag that saved as something other than what was typed is a
 * person who believes they let somebody in and did not.
 */

func ledgered(t *testing.T) (*API, http.Handler, *kept, *store.Store, *http.Cookie) {
	t.Helper()

	trip := room.Trip(key, "moderator")
	api, mux, written := mountAudited(t, []config.Admin{{Trip: trip, Name: "adam", Can: []string{config.Moderate}}})

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	api.ledger = st

	if err := st.AddAccount(store.Account{Name: "ada", Trip: room.Trip(key, "ada's passphrase")}); err != nil {
		t.Fatal(err)
	}

	_, token, _ := api.sessions.Open("", "moderator")

	return api, mux, written, st, &http.Cookie{Name: cookieName, Value: token}
}

func patchAccount(mux http.Handler, cookie *http.Cookie, name, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPatch, "/api/admin/accounts/"+name, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookie)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder
}

func TestScopesAreWrittenAsTheDoorWillReadThem(t *testing.T) {
	_, mux, written, st, cookie := ledgered(t)

	answer := patchAccount(mux, cookie, "ada", `{"scopes":[" Acme ","acme","beta-cn",""]}`)
	if answer.Code != http.StatusOK {
		t.Fatalf("setting scopes answered %d (%s)", answer.Code, answer.Body.String())
	}

	account, _ := st.Account("ada")
	if !reflect.DeepEqual(account.Scopes, []string{"acme", "beta-cn"}) {
		t.Errorf("scopes stored as %v, want [acme beta-cn]", account.Scopes)
	}

	// And said in the list the page draws from.
	request := httptest.NewRequest(http.MethodGet, "/api/admin/accounts", nil)
	request.AddCookie(cookie)
	listed := httptest.NewRecorder()
	mux.ServeHTTP(listed, request)

	var views []accountView
	_ = json.Unmarshal(listed.Body.Bytes(), &views)

	if len(views) != 1 || !reflect.DeepEqual(views[0].Scopes, []string{"acme", "beta-cn"}) {
		t.Errorf("the account list said %s", listed.Body.String())
	}

	// And recorded against whoever did it, with what changed.
	found := false
	for _, entry := range written.recorded() {
		if entry.Action == "change account" && entry.Target == "ada" && strings.Contains(entry.Change, "acme,beta-cn") {
			found = true
		}
	}

	if !found {
		t.Errorf("giving somebody a scope left no record of it: %+v", written.recorded())
	}
}

func TestAScopeNoRoomCouldNameIsNotWrittenAtAll(t *testing.T) {
	_, mux, _, st, cookie := ledgered(t)

	if answer := patchAccount(mux, cookie, "ada", `{"scopes":["acme"]}`); answer.Code != http.StatusOK {
		t.Fatalf("setting a scope answered %d", answer.Code)
	}

	for _, body := range []string{`{"scopes":["ac me"]}`, `{"scopes":["a@b"]}`, `{"scopes":["acme","-x"]}`} {
		answer := patchAccount(mux, cookie, "ada", body)

		var said struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(answer.Body.Bytes(), &said)

		if answer.Code != http.StatusBadRequest || said.Error != "bad_scope" {
			t.Errorf("%s answered %d %q, want 400 bad_scope", body, answer.Code, said.Error)
		}
	}

	if account, _ := st.Account("ada"); !reflect.DeepEqual(account.Scopes, []string{"acme"}) {
		t.Errorf("a refused change still altered the scopes to %v", account.Scopes)
	}

	// An empty list is taking somebody out of every scope, and is not a refusal.
	if answer := patchAccount(mux, cookie, "ada", `{"scopes":[]}`); answer.Code != http.StatusOK {
		t.Errorf("clearing the scopes answered %d", answer.Code)
	}

	if account, _ := st.Account("ada"); len(account.Scopes) != 0 {
		t.Errorf("clearing left %v", account.Scopes)
	}

	// And a change that does not mention scopes leaves them where they are.
	_ = patchAccount(mux, cookie, "ada", `{"scopes":["acme"]}`)
	_ = patchAccount(mux, cookie, "ada", `{"note":"ops"}`)

	if account, _ := st.Account("ada"); !reflect.DeepEqual(account.Scopes, []string{"acme"}) {
		t.Errorf("a note took the scopes with it: %v", account.Scopes)
	}
}
