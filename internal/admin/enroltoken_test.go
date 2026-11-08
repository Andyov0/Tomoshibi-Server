package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
One machine, one prefix, one use, half an hour.

The enrolment used to be bought with a secret that never expired and was never
used up, typed into the command line of every relay ever brought up. Whoever
read it from one machine's shell history could enrol a machine of their own and
be handed the deployment, or take over an existing relay's name and point it at
an address of their choosing — the replace flag was the caller's to set. These
tests hold each of the things a token now refuses, through the router, against
a real store, because the one-use rule is the store's to keep and a stand-in
would only be testing itself.
*/

// managingAs opens a management session for the administrator enrolling()
// configures, given the capabilities named.
func managingAs(t *testing.T, api *API, can ...string) (http.Handler, string) {
	t.Helper()

	api.conf.Meet.Admins[0].Can = can

	_, token, ok := api.sessions.Open("", "a passphrase")
	if !ok {
		t.Fatal("could not open a management session")
	}

	managing := http.NewServeMux()
	api.Mount(managing)

	return managing, token
}

func mint(t *testing.T, managing http.Handler, session, body string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(http.MethodPost, "/api/admin/relays/enrolments", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: cookieName, Value: session})

	recorder := httptest.NewRecorder()
	managing.ServeHTTP(recorder, request)

	return recorder
}

func tokenOf(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()

	if recorder.Code != http.StatusOK {
		t.Fatalf("minting answered %d: %s", recorder.Code, recorder.Body)
	}

	var said struct {
		Token   string `json:"token"`
		Command string `json:"command"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil || said.Token == "" {
		t.Fatalf("minting gave no token: %s", recorder.Body)
	}

	// The command somebody copies must not carry the token: what is typed is
	// what the shell keeps.
	if strings.Contains(said.Command, said.Token) {
		t.Errorf("the command to paste carries the token, so it lands in the shell's history: %s", said.Command)
	}

	return said.Token
}

func TestATokenFromThePageEnrolsOneMachineOnce(t *testing.T) {
	api, relays, names, mux := enrolling(t)
	managing, session := managingAs(t, api, config.Moderate)

	token := tokenOf(t, mint(t, managing, session, `{"prefix":"tokyo"}`))

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, enrolRequest(`{"secret":"`+token+`","prefix":"tokyo","address":"198.51.100.9"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("the first use answered %d: %s", recorder.Code, recorder.Body)
	}

	var got enrolPackage
	_ = json.Unmarshal(recorder.Body.Bytes(), &got)

	if got.BinarySHA256 == "" {
		t.Error("the package does not say what the binary should hash to, so the script cannot check it")
	}

	// The same token again, as somebody who copied it out of a terminal would
	// present it — on another prefix's behalf it is refused for that, so the
	// same prefix is the case that tests the one-use rule.
	again := httptest.NewRecorder()
	mux.ServeHTTP(again, enrolRequest(`{"secret":"`+token+`","prefix":"tokyo","address":"203.0.113.66","replace":true}`))

	if again.Code != http.StatusForbidden {
		t.Errorf("a token used once answered %d the second time, want 403", again.Code)
	}

	if names.pointed["tokyo.relay.example.invalid"] != "198.51.100.9" {
		t.Errorf("the second use moved the name to %q", names.pointed["tokyo.relay.example.invalid"])
	}

	if list, _ := relays.Relays(); len(list) != 1 {
		t.Errorf("there are %d relays after one enrolment", len(list))
	}
}

// Somebody trusted with the fleet's list is not, by that, trusted with the
// deployment's key pair. The endpoint table holds the gate; this holds that
// the refusal leaves nothing minted behind it.
func TestOnlyAModeratorMintsATokenForANewMachine(t *testing.T) {
	api, _, _, _ := enrolling(t)
	managing, session := managingAs(t, api, config.ManageRelays)

	if code := mint(t, managing, session, `{"prefix":"tokyo"}`).Code; code != http.StatusForbidden {
		t.Errorf("an administrator given the relays alone minted a token: %d", code)
	}

	if waiting, _ := api.enrolments.EnrolGrants(time.Now()); len(waiting) != 0 {
		t.Errorf("a refused mint left %d tokens waiting", len(waiting))
	}

	// And the page's copy of the script, which is theirs to read, no longer
	// carries anything that enrols a machine.
	for _, path := range []string{"/api/admin/relays/script", "/api/admin/relays/command"} {
		recorder := ask(t, managing, http.MethodGet, path, session)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s answered %d to the relays capability", path, recorder.Code)
		}

		if strings.Contains(recorder.Body.String(), enrolSecret) {
			t.Errorf("%s still carries the long-lived enrolment secret", path)
		}
	}
}

func TestATokenIsForTheOnePrefixItWasMintedFor(t *testing.T) {
	api, _, names, mux := enrolling(t)

	token := minted(t, api, "tokyo", false)

	if code := post(mux, enrolRequest(`{"secret":"`+token+`","prefix":"osaka","address":"198.51.100.9"}`)); code != http.StatusForbidden {
		t.Errorf("a token for tokyo enrolled osaka: %d", code)
	}

	if len(names.pointed) != 0 {
		t.Errorf("a refused prefix reached the zone: %v", names.pointed)
	}

	// Not spent by the mistake.
	if code := post(mux, enrolRequest(`{"secret":"`+token+`","prefix":"tokyo","address":"198.51.100.9"}`)); code != http.StatusOK {
		t.Errorf("the right prefix answered %d after the wrong one was refused", code)
	}
}

func TestAnExpiredTokenGetsNothing(t *testing.T) {
	api, relays, _, mux := enrolling(t)

	token := mintedFor(t, api, store.EnrolGrant{Prefix: "tokyo", Expires: time.Now().Add(-time.Second)})

	if code := post(mux, enrolRequest(`{"secret":"`+token+`","prefix":"tokyo","address":"198.51.100.9"}`)); code != http.StatusForbidden {
		t.Errorf("an expired token answered %d, want 403", code)
	}

	if list, _ := relays.Relays(); len(list) != 0 {
		t.Errorf("an expired token added a relay: %+v", list)
	}
}

func TestATokenBoundToAnAddressRefusesAnyOther(t *testing.T) {
	api, _, _, mux := enrolling(t)

	token := mintedFor(t, api, store.EnrolGrant{Prefix: "tokyo", From: "198.51.100.77"})

	// enrolRequest comes from 203.0.113.7.
	if code := post(mux, enrolRequest(`{"secret":"`+token+`","prefix":"tokyo","address":"198.51.100.9"}`)); code != http.StatusForbidden {
		t.Errorf("a token bound to another address answered %d, want 403", code)
	}

	request := enrolRequest(`{"secret":"` + token + `","prefix":"tokyo","address":"198.51.100.9"}`)
	request.RemoteAddr = "198.51.100.77:4444"

	if code := post(mux, request); code != http.StatusOK {
		t.Errorf("the address it was bound to answered %d", code)
	}
}

// The attack this whole file is about: an existing relay's name moved to an
// address of the caller's choosing, by a caller who only had to ask.
func TestTakingOverARelaysNameNeedsATokenMintedToDoIt(t *testing.T) {
	api, _, names, mux := enrolling(t)
	managing, session := managingAs(t, api, config.Moderate)

	if code := post(mux, enrolRequest(
		`{"secret":"`+minted(t, api, "tokyo", false)+`","prefix":"tokyo","address":"198.51.100.9"}`)); code != http.StatusOK {
		t.Fatalf("the first enrolment answered %d", code)
	}

	// A token for the prefix, and the caller asking for a takeover.
	ordinary := minted(t, api, "tokyo", false)
	if code := post(mux, enrolRequest(
		`{"secret":"`+ordinary+`","prefix":"tokyo","address":"203.0.113.66","replace":true}`)); code != http.StatusConflict {
		t.Errorf("a takeover asked for by the machine answered %d, want 409", code)
	}

	if got := names.pointed["tokyo.relay.example.invalid"]; got != "198.51.100.9" {
		t.Fatalf("the name moved to %q on a takeover nobody allowed", got)
	}

	// The page will not mint an ordinary token for a name in use either: it
	// would be carried to a machine and refused there.
	if code := mint(t, managing, session, `{"prefix":"tokyo"}`).Code; code != http.StatusConflict {
		t.Errorf("minting an ordinary token for a prefix in use answered %d, want 409", code)
	}

	// An administrator saying so is what allows it.
	takeover := tokenOf(t, mint(t, managing, session, `{"prefix":"tokyo","replace":true}`))
	if code := post(mux, enrolRequest(
		`{"secret":"`+takeover+`","prefix":"tokyo","address":"203.0.113.66","replace":true}`)); code != http.StatusOK {
		t.Fatalf("a takeover minted on the page answered %d", code)
	}

	if got := names.pointed["tokyo.relay.example.invalid"]; got != "203.0.113.66" {
		t.Errorf("an allowed takeover left the name at %q", got)
	}
}

// The old secret, for a deployment that turned it back on to finish a machine
// half way through: a new prefix, never somebody else's.
func TestTheOldSecretNeverTakesOverAName(t *testing.T) {
	api, _, names, mux := enrolling(t)
	api.enrolment.AcceptSecret = true

	if code := post(mux, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.9"}`)); code != http.StatusOK {
		t.Fatalf("the old secret, accepted on purpose, answered %d for a new prefix", code)
	}

	if code := post(mux, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"203.0.113.66","replace":true}`)); code != http.StatusConflict {
		t.Errorf("the old secret took over a name in use: %d", code)
	}

	if got := names.pointed["tokyo.relay.example.invalid"]; got != "198.51.100.9" {
		t.Errorf("the name moved to %q", got)
	}
}

// Two machines presenting one token at the same moment get one enrolment.
func TestATokenPresentedTwiceAtOnceEnrolsOnce(t *testing.T) {
	api, _, _, mux := enrolling(t)

	token := minted(t, api, "tokyo", true)

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		granted int
	)

	for i := range 8 {
		wg.Add(1)

		go func() {
			defer wg.Done()

			request := enrolRequest(`{"secret":"` + token + `","prefix":"tokyo","address":"198.51.100.` + string(rune('1'+i)) + `"}`)

			if post(mux, request) == http.StatusOK {
				mu.Lock()
				granted++
				mu.Unlock()
			}
		}()
	}

	wg.Wait()

	if granted != 1 {
		t.Errorf("one token enrolled %d machines", granted)
	}
}

// What the record says, which is where a name was moved to and from where the
// request came. It said "enrol" and a prefix.
func TestAnEnrolmentIsRecordedWithWhereItCameFromAndWhereTheNamePoints(t *testing.T) {
	api, _, _, mux := enrolling(t)

	log, kept := auditing()
	api.log = log

	if code := post(mux, enrolRequest(`{"secret":"wrong","prefix":"tokyo","address":"198.51.100.9"}`)); code != http.StatusForbidden {
		t.Fatalf("a wrong token answered %d", code)
	}

	if code := post(mux, enrolRequest(
		`{"secret":"`+minted(t, api, "tokyo", false)+`","prefix":"tokyo","address":"198.51.100.9"}`)); code != http.StatusOK {
		t.Fatalf("enrolment answered %d", code)
	}

	entries := kept.recorded()
	if len(entries) != 2 {
		t.Fatalf("recorded %d entries, want 2: %+v", len(entries), entries)
	}

	if !entries[0].Failed || !strings.Contains(entries[0].Change, "203.0.113.7") {
		t.Errorf("the refusal does not say where it came from: %+v", entries[0])
	}

	done := entries[1]
	if done.Failed || done.Name != "adam" ||
		!strings.Contains(done.Change, "from 203.0.113.7") ||
		!strings.Contains(done.Change, "points at 198.51.100.9") {
		t.Errorf("the enrolment's record is %+v; it should name who minted the token, where the "+
			"request came from and where the name now points", done)
	}
}
