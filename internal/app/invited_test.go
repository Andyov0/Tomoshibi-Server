package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * Knowing the name is not the same as being invited.
 *
 * A room here is a name and nothing else, and that was the whole of the door:
 * anybody who typed the name was in. The invite mechanism was built precisely
 * because handing over a name hands over every future meeting of that name — and
 * then nothing ever required one, so the mechanism protected against something
 * the door did not enforce.
 *
 * On a deployment whose rooms are called things like 223223 that is a meeting
 * anybody can walk into, and the people in it cannot tell how the stranger got
 * there. What made it hard to notice is the setting beside it: `opened_by:
 * signed` sounds like "signed in" and means "typed something into the passphrase
 * box", so a deployment that had thought about this still had an open door.
 *
 * The host is the case worth being careful about. They come back to their own
 * meeting with the passphrase they opened it with and no invite, because nobody
 * sent them one.
 */

func joinAs(t *testing.T, mux http.Handler, roomName string, body string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/"+roomName+"/join", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder
}

func refusal(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()

	var said struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &said)

	return said.Error
}

// invitesOnly builds a deployment that lets anybody open a room and only the
// invited join one, which is the pair a deployment handing out links wants.
func invitesOnly(t *testing.T) (http.Handler, *store.Store) {
	t.Helper()

	mux, st, app := controlWithStore(t, config.PickSticky,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"})

	app.conf.Meet.Rooms.OpenedBy = room.ByAnyone
	app.conf.Meet.Rooms.JoinedBy = room.ByInvitation

	return mux, st
}

func TestGuessingTheNameIsNotAWayIn(t *testing.T) {
	mux, _ := invitesOnly(t)

	// Opened by somebody, which is the case the whole thing is about: the room
	// exists, and a stranger has the name.
	opened := joinAs(t, mux, "223223", `{"name":"host","passphrase":"the-hosts-own-passphrase"}`)
	if opened.Code != http.StatusOK {
		t.Fatalf("opening a room answered %d: %s", opened.Code, opened.Body.String())
	}

	guessed := joinAs(t, mux, "223223", `{"name":"stranger"}`)

	if guessed.Code != http.StatusForbidden {
		t.Fatalf("somebody who typed the name got %d, want 403: a meeting called 223223 is "+
			"one anybody can guess, and they arrive with nothing saying how", guessed.Code)
	}

	if got := refusal(t, guessed); got != reasonNotInvited {
		t.Errorf("refused with %q, want %q — the client owns the sentence and cannot write "+
			"the right one from the wrong code", got, reasonNotInvited)
	}
}

func TestTheHostComesBackToTheirOwnRoom(t *testing.T) {
	mux, _ := invitesOnly(t)

	opened := joinAs(t, mux, "223223", `{"name":"host","passphrase":"the-hosts-own-passphrase"}`)
	if opened.Code != http.StatusOK {
		t.Fatalf("opening a room answered %d", opened.Code)
	}

	// The same passphrase, which is the only thing a host has. No invite was
	// ever sent to them.
	again := joinAs(t, mux, "223223", `{"name":"host","passphrase":"the-hosts-own-passphrase"}`)

	if again.Code != http.StatusOK {
		t.Fatalf("the host was refused their own room with %d (%s); a rule that shuts the "+
			"host out is worse than the one it replaces", again.Code, refusal(t, again))
	}
}

func TestSomebodyElsesPassphraseIsNotAWayIn(t *testing.T) {
	mux, _ := invitesOnly(t)

	if opened := joinAs(t, mux, "223223",
		`{"name":"host","passphrase":"the-hosts-own-passphrase"}`); opened.Code != http.StatusOK {
		t.Fatalf("opening a room answered %d", opened.Code)
	}

	// A passphrase makes a signature, and under the old setting a signature was
	// enough for anything. It is not a claim about this room.
	guessed := joinAs(t, mux, "223223", `{"name":"stranger","passphrase":"any-old-thing"}`)

	if guessed.Code != http.StatusForbidden {
		t.Errorf("typing a passphrase of their own got %d, want 403: it proves a name and "+
			"says nothing whatever about this meeting", guessed.Code)
	}
}

func TestANameNobodyHasUsedIsStillAnOpening(t *testing.T) {
	mux, _ := invitesOnly(t)

	// The join gate must not swallow the opening one. A name nobody has used is
	// a different question, decided by opened_by, and this deployment lets
	// anybody open one.
	opened := joinAs(t, mux, "brand-new-name", `{"name":"somebody"}`)

	if opened.Code != http.StatusOK {
		t.Errorf("opening an unused name answered %d (%s); the join rule is about rooms that "+
			"exist and reading it as a rule about names would close the deployment",
			opened.Code, refusal(t, opened))
	}
}

func TestWhoeverKnowsTheNameIsStillTheDefault(t *testing.T) {
	mux, _, app := controlWithStore(t, config.PickSticky,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"})

	app.conf.Meet.Rooms.OpenedBy = room.ByAnyone

	// Left at whatever the zero value resolves to, which is what an existing
	// deployment upgrading into this gets.
	if opened := joinAs(t, mux, "223223", `{"name":"host"}`); opened.Code != http.StatusOK {
		t.Fatalf("opening a room answered %d", opened.Code)
	}

	if second := joinAs(t, mux, "223223", `{"name":"stranger"}`); second.Code != http.StatusOK {
		t.Errorf("a second person was refused with %d on a deployment that never asked for "+
			"this; a setting that changes what everybody already had is not a setting",
			second.Code)
	}
}

/*
 * A passphrase somebody set themselves is not an account.
 *
 * `signed` reads as "signed in" and means "typed something into the passphrase
 * box", so a deployment that had chosen it and thought about who may start a
 * meeting was still one where a stranger with any passphrase could start one
 * and use the bandwidth. Closing the door on rooms that exist did not touch
 * that: the two are different questions and only one of them had been asked.
 *
 * `accounts` is the setting `signed` sounds like. An administrator can still
 * open a room whatever this says, which is why it needs no fallback for a
 * deployment that has no accounts — it is never a locked door with no key.
 */
func TestUnderAccountsAPassphraseDoesNotOpenARoom(t *testing.T) {
	// Set in the store rather than on the config, because that is where this
	// one lives: the file holds a starting value and the pages write the live
	// one, and reading the file would test a field nothing consults.
	mux, st, _ := controlWithStore(t, config.PickSticky,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"})

	if err := st.SetOpening(room.ByAccounts); err != nil {
		t.Fatal(err)
	}

	opened := joinAs(t, mux, "stranger-was-here", `{"name":"stranger","passphrase":"any-old-thing"}`)

	if opened.Code != http.StatusForbidden {
		t.Errorf("somebody with a passphrase of their own opened a room and got %d, want 403: "+
			"a signature proves a name and says nothing about belonging here", opened.Code)
	}

	// And the setting it sits beside still means what it always did, or this is
	// not a new option but a change to an old one.
	if err := st.SetOpening(room.BySigned); err != nil {
		t.Fatal(err)
	}

	if again := joinAs(t, mux, "stranger-was-here-too",
		`{"name":"stranger","passphrase":"any-old-thing"}`); again.Code != http.StatusOK {
		t.Errorf("under %q a passphrase was refused with %d; that setting is still right "+
			"where a passphrase is the whole identity model", room.BySigned, again.Code)
	}
}
