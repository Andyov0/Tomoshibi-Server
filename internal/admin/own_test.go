package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"tomoshibi/internal/store"
)

/*
 * Giving somebody a relay of their own, from the accounts page.
 *
 * The store refuses what cannot be (store/own.go); what is held here is that
 * each refusal reaches the page as a code it has a sentence for rather than as
 * the general one, that the page is told whose each relay is, and that giving
 * somebody a machine — and with it taking every other one away from them — is
 * written down against whoever did it.
 */

func owned(t *testing.T) (http.Handler, *kept, *store.Store, *http.Cookie) {
	t.Helper()

	api, mux, written, st, cookie := ledgered(t)
	api.relays = st

	for _, relay := range []store.Relay{
		{Name: "theirs", URL: "wss://theirs.example", Enabled: true},
		{Name: "kept", URL: "wss://kept.example", Enabled: true, AdminOnly: true},
	} {
		if err := st.AddRelay(relay); err != nil {
			t.Fatal(err)
		}
	}

	return mux, written, st, cookie
}

func refusalOf(recorder *httptest.ResponseRecorder) string {
	var said struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &said)

	return said.Error
}

func TestARelayIsGivenToSomebodyAndItIsWrittenDown(t *testing.T) {
	mux, written, st, cookie := owned(t)

	if answer := patchAccount(mux, cookie, "ada", `{"relays":[" theirs ","theirs"]}`); answer.Code != http.StatusOK {
		t.Fatalf("giving ada a relay answered %d (%s)", answer.Code, answer.Body)
	}

	if account, _ := st.Account("ada"); !reflect.DeepEqual(account.Relays, []string{"theirs"}) {
		t.Errorf("stored %v, want [theirs]", account.Relays)
	}

	found := false
	for _, entry := range written.recorded() {
		if entry.Action == "change account" && entry.Target == "ada" && strings.Contains(entry.Change, "relays  -> theirs") {
			found = true
		}
	}
	if !found {
		t.Errorf("giving somebody a relay left no record of it: %+v", written.recorded())
	}

	// The account list says so, and the relay list says whose it is.
	request := httptest.NewRequest(http.MethodGet, "/api/admin/accounts", nil)
	request.AddCookie(cookie)
	listed := httptest.NewRecorder()
	mux.ServeHTTP(listed, request)

	var accounts []accountView
	_ = json.Unmarshal(listed.Body.Bytes(), &accounts)
	if len(accounts) != 1 || !reflect.DeepEqual(accounts[0].Relays, []string{"theirs"}) {
		t.Errorf("the account list said %s", listed.Body)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/admin/relays", nil)
	request.AddCookie(cookie)
	relays := httptest.NewRecorder()
	mux.ServeHTTP(relays, request)

	var body struct {
		Relays []relayView `json:"relays"`
	}
	_ = json.Unmarshal(relays.Body.Bytes(), &body)

	for _, view := range body.Relays {
		want := []string(nil)
		if view.Name == "theirs" {
			want = []string{"ada"}
		}
		if !reflect.DeepEqual(view.Owners, want) {
			t.Errorf("relay %s listed as %v's, want %v", view.Name, view.Owners, want)
		}
	}

	// And an empty list gives the ordinary list back.
	if answer := patchAccount(mux, cookie, "ada", `{"relays":[]}`); answer.Code != http.StatusOK {
		t.Errorf("taking ada's relay away answered %d", answer.Code)
	}
	if account, _ := st.Account("ada"); len(account.Relays) != 0 {
		t.Errorf("taking it away left %v", account.Relays)
	}
}

func TestEachRefusalOfSomebodysOwnRelayIsSaidAsItself(t *testing.T) {
	mux, _, _, cookie := owned(t)

	for body, want := range map[string]string{
		`{"relays":["nowhere"]}`: "no_such_relay",
		`{"relays":["kept"]}`:    "relay_reserved",
	} {
		if answer := patchAccount(mux, cookie, "ada", body); answer.Code != http.StatusBadRequest || refusalOf(answer) != want {
			t.Errorf("%s answered %d %q, want 400 %s", body, answer.Code, refusalOf(answer), want)
		}
	}

	if answer := patchAccount(mux, cookie, "ada", `{"relays":["theirs"]}`); answer.Code != http.StatusOK {
		t.Fatalf("giving ada a relay answered %d", answer.Code)
	}

	edit := httptest.NewRequest(http.MethodPatch, "/api/admin/relays/theirs", strings.NewReader(`{"adminOnly":true}`))
	edit.Header.Set("Content-Type", "application/json")
	edit.AddCookie(cookie)
	edited := httptest.NewRecorder()
	mux.ServeHTTP(edited, edit)

	if edited.Code != http.StatusBadRequest || refusalOf(edited) != "relay_is_somebodys" {
		t.Errorf("keeping ada's relay for administrators answered %d %q, want 400 relay_is_somebodys",
			edited.Code, refusalOf(edited))
	}

	drop := httptest.NewRequest(http.MethodDelete, "/api/admin/relays/theirs", nil)
	drop.AddCookie(cookie)
	dropped := httptest.NewRecorder()
	mux.ServeHTTP(dropped, drop)

	if dropped.Code != http.StatusConflict || refusalOf(dropped) != "relay_is_somebodys" {
		t.Errorf("removing ada's relay answered %d %q, want 409 relay_is_somebodys: said as anything "+
			"else the page tells somebody the relay is already gone", dropped.Code, refusalOf(dropped))
	}
}
