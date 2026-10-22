package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * Who may say a name held under a scope, and who runs the room once they have.
 *
 * The fault these guard against is quiet by construction. A scoped room that
 * admitted a stranger looks exactly like one that admitted a member: the call
 * works, the stranger is in it, and nobody is told anything. So every case below
 * is a door that would open for the wrong person without a sound, and each was
 * broken once on purpose to watch it fail.
 *
 * Two directions are tested wherever there are two, because the easy mistake is
 * the one that merges them: the store failing must refuse a scoped room and must
 * still let a plain one through, and a test of only the first would pass with
 * both paths made to fail closed — which turns every store outage into every
 * call on the deployment refusing to rejoin.
 */

const (
	adaPassphrase  = "ada's own passphrase"
	bobPassphrase  = "bob's own passphrase"
	evePassphrase  = "eve's own passphrase"
	adamPassphrase = "adam the administrator"
	ivyPassphrase  = "ivy only watches"
)

// scoped is a control node with three accounts and two administrators: ada in
// acme, bob in nothing, eve in another scope; adam who may moderate and ivy who
// may only observe.
func scoped(t *testing.T) (http.Handler, *store.Store, *App) {
	t.Helper()

	mux, st, app := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"})

	for _, account := range []store.Account{
		{Name: "ada", Trip: room.Trip(tripKey, adaPassphrase), Scopes: []string{"acme"}},
		{Name: "bob", Trip: room.Trip(tripKey, bobPassphrase)},
		{Name: "eve", Trip: room.Trip(tripKey, evePassphrase), Scopes: []string{"elsewhere"}},
	} {
		if err := st.AddAccount(account); err != nil {
			t.Fatalf("AddAccount(%s): %v", account.Name, err)
		}
	}

	for _, admin := range []store.Admin{
		{Trip: room.Trip(tripKey, adamPassphrase), Name: "adam", Can: []string{config.Moderate}},
		{Trip: room.Trip(tripKey, ivyPassphrase), Name: "ivy", Can: []string{config.Observe}},
	} {
		if err := st.AddAdmin(admin); err != nil {
			t.Fatalf("AddAdmin(%s): %v", admin.Name, err)
		}
	}

	return mux, st, app
}

// sessionFor gives back a live account session for somebody already in the
// store, as the cookie a browser would carry.
//
// Not signedInAs, which adds the person first and falls back to adding them as
// an administrator when the account already exists — so every member here would
// quietly have become an administrator of every scope, and the tests about
// membership would have been tests about administrators.
func sessionFor(t *testing.T, st *store.Store, name, trip string) *http.Cookie {
	t.Helper()

	now := time.Now().UTC()
	token := "session-for-" + name

	if err := st.KeepSession(token, store.Session{
		Trip: trip, Name: name, Kind: accountKind,
		Opened: now, Expires: now.Add(24 * time.Hour),
	}); err != nil {
		t.Fatalf("KeepSession: %v", err)
	}

	return &http.Cookie{Name: accountCookie, Value: token}
}

// scopedJoin asks for a room with whatever the caller brings.
func scopedJoin(mux http.Handler, path, said string, cookie *http.Cookie) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"name": "somebody", "passphrase": said, "relay": "shanghai"})

	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")

	if cookie != nil {
		request.AddCookie(cookie)
	}

	return ask(mux, request)
}

// granted reads the token a join handed back, as the media server would.
func granted(t *testing.T, recorder *httptest.ResponseRecorder) *auth.ClaimGrants {
	t.Helper()

	var said joinResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatalf("the join's answer was not readable: %v (%s)", err, recorder.Body.String())
	}

	verifier, err := auth.ParseAPIToken(said.Token)
	if err != nil {
		t.Fatalf("the token did not parse: %v", err)
	}

	_, claims, err := verifier.Verify("a secret long enough for the media server to accept it")
	if err != nil {
		t.Fatalf("the token did not verify: %v", err)
	}

	return claims
}

func TestAScopedRoomAdmitsItsMembersBothWays(t *testing.T) {
	mux, st, _ := scoped(t)
	ada := room.Trip(tripKey, adaPassphrase)

	byPassphrase := scopedJoin(mux, "/api/rooms/standup@acme/join", adaPassphrase, nil)
	if byPassphrase.Code != http.StatusOK {
		t.Fatalf("a member with her passphrase answered %d (%s), want 200",
			byPassphrase.Code, byPassphrase.Body.String())
	}

	mark, _ := room.SignatureOf(granted(t, byPassphrase).Identity)
	if !mark.Proven || mark.Account || mark.Trip != ada {
		t.Errorf("a member by passphrase was minted %+v, want her own proven mark", mark)
	}

	bySession := scopedJoin(mux, "/api/rooms/standup@acme/join", "", sessionFor(t, st, "ada", ada))
	if bySession.Code != http.StatusOK {
		t.Fatalf("a member signed in answered %d (%s), want 200", bySession.Code, bySession.Body.String())
	}

	mark, _ = room.SignatureOf(granted(t, bySession).Identity)
	if !mark.Account || mark.Trip != ada {
		t.Errorf("a member signed in was minted %+v, want her account's mark", mark)
	}
}

func TestAScopedRoomRefusesEverybodyElse(t *testing.T) {
	mux, st, _ := scoped(t)

	// Used first, by a member, so that what is being tested is every join and
	// not only the opening: a door that asked only the first person would let
	// all of these through.
	if got := scopedJoin(mux, "/api/rooms/standup@acme/join", adaPassphrase, nil).Code; got != http.StatusOK {
		t.Fatalf("a member could not open the room: %d", got)
	}

	for _, tc := range []struct {
		who    string
		said   string
		cookie *http.Cookie
		code   int
		reason string
	}{
		{"nobody at all", "", nil, http.StatusForbidden, reasonNotInScope},
		{"an account in no scope, by passphrase", bobPassphrase, nil, http.StatusForbidden, reasonNotInScope},
		{"an account in no scope, signed in", "", sessionFor(t, st, "bob", room.Trip(tripKey, bobPassphrase)),
			http.StatusForbidden, reasonNotInScope},
		{"an account in another scope", evePassphrase, nil, http.StatusForbidden, reasonNotInScope},
		{"a passphrase nobody has", "a passphrase of nobody's", nil, http.StatusForbidden, reasonNotInScope},
	} {
		recorder := scopedJoin(mux, "/api/rooms/standup@acme/join", tc.said, tc.cookie)

		if recorder.Code != tc.code || refusal(t, recorder) != tc.reason {
			t.Errorf("%s answered %d %q, want %d %q", tc.who, recorder.Code, refusal(t, recorder), tc.code, tc.reason)
		}
	}
}

// Blocked is not a member, by either way in. The passphrase is refused at the
// door as it is everywhere; the session is not a session any more.
func TestABlockedMemberIsNotAMember(t *testing.T) {
	mux, st, _ := scoped(t)
	ada := room.Trip(tripKey, adaPassphrase)
	cookie := sessionFor(t, st, "ada", ada)

	account, _ := st.Account("ada")
	account.Blocked = true
	if err := st.UpdateAccount("ada", account); err != nil {
		t.Fatal(err)
	}

	if got := scopedJoin(mux, "/api/rooms/standup@acme/join", adaPassphrase, nil); got.Code != http.StatusForbidden {
		t.Errorf("a blocked member by passphrase answered %d, want 403", got.Code)
	}

	if got := scopedJoin(mux, "/api/rooms/standup@acme/join", "", cookie); got.Code != http.StatusForbidden {
		t.Errorf("a blocked member signed in answered %d, want 403", got.Code)
	}
}

func TestAnAdministratorBelongsToEveryScope(t *testing.T) {
	mux, st, _ := scoped(t)

	for _, said := range []string{adamPassphrase, ivyPassphrase} {
		if got := scopedJoin(mux, "/api/rooms/standup@acme/join", said, nil); got.Code != http.StatusOK {
			t.Errorf("an administrator by passphrase answered %d (%s), want 200", got.Code, got.Body.String())
		}
	}

	cookie := sessionFor(t, st, "adam", room.Trip(tripKey, adamPassphrase))
	if got := scopedJoin(mux, "/api/rooms/standup@acme/join", "", cookie); got.Code != http.StatusOK {
		t.Errorf("an administrator signed in answered %d (%s), want 200", got.Code, got.Body.String())
	}
}

// The scope keeps its own rule, whatever the deployment says about plain names:
// a member opens a room under a policy that would refuse her a plain one, and a
// stranger is turned away under a policy that would let him into one.
func TestTheDeploymentsPoliciesDoNotReachAScope(t *testing.T) {
	mux, st, _ := scoped(t)

	if err := st.SetOpening(room.ByAdmins); err != nil {
		t.Fatal(err)
	}

	if got := scopedJoin(mux, "/api/rooms/fresh@acme/join", adaPassphrase, nil).Code; got != http.StatusOK {
		t.Errorf("a member opening a scoped room under admins-only answered %d, want 200", got)
	}

	if got := scopedJoin(mux, "/api/rooms/fresh/join", adaPassphrase, nil).Code; got != http.StatusForbidden {
		t.Errorf("the same member opening a plain room under admins-only answered %d, want 403; "+
			"the setting is not being applied at all, so the line above proves nothing", got)
	}

	if err := st.SetOpening(room.ByAnyone); err != nil {
		t.Fatal(err)
	}

	if got := scopedJoin(mux, "/api/rooms/open@acme/join", "", nil).Code; got != http.StatusForbidden {
		t.Errorf("a stranger opening a scoped room where anybody may open one answered %d, want 403", got)
	}
}

// A browser sends the `@` escaped, and the router hands it back unescaped. If it
// did not, the name the door checked and the name the token named would be two
// different strings, and one of them would have no scope.
func TestAnEscapedScopeIsTheSameScope(t *testing.T) {
	mux, _, _ := scoped(t)

	stranger := scopedJoin(mux, "/api/rooms/standup%40acme/join", "", nil)
	if stranger.Code != http.StatusForbidden || refusal(t, stranger) != reasonNotInScope {
		t.Errorf("a stranger on the escaped name answered %d %q, want 403 %q",
			stranger.Code, refusal(t, stranger), reasonNotInScope)
	}

	member := scopedJoin(mux, "/api/rooms/standup%40acme/join", adaPassphrase, nil)
	if member.Code != http.StatusOK {
		t.Fatalf("a member on the escaped name answered %d (%s)", member.Code, member.Body.String())
	}

	if got := granted(t, member).Video.Room; got != "standup@acme" {
		t.Errorf("the token names %q, want standup@acme", got)
	}
}

/*
 * The store failing, in both directions.
 *
 * A plain name is let through, because refusing would end meetings that are
 * already happening; a scoped one is refused, because letting it through hands
 * the meeting to whoever guessed the name. Each half alone would pass with both
 * paths merged into whichever it tests.
 */
func TestAStoreThatWillNotAnswerClosesOnlyScopedRooms(t *testing.T) {
	mux, st, _ := scoped(t)

	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	for _, said := range []string{adaPassphrase, ""} {
		recorder := scopedJoin(mux, "/api/rooms/standup@acme/join", said, nil)

		if recorder.Code != http.StatusServiceUnavailable {
			t.Errorf("a scoped join with the store closed answered %d (%s), want 503",
				recorder.Code, recorder.Body.String())
		}
	}

	if got := scopedJoin(mux, "/api/rooms/standup/join", "", nil); got.Code != http.StatusOK {
		t.Errorf("a plain join with the store closed answered %d (%s), want 200; "+
			"the outage would end every call on the deployment", got.Code, got.Body.String())
	}
}

/*
 * Running a scoped room.
 *
 * Every member runs it, whether or not they are in it, and nobody else does —
 * not a guest, not a member who has since left the scope, and not an
 * administrator who may only watch. The controls answer 502 where they were
 * allowed, because there is no media server behind this fixture, and 403 where
 * they were not.
 */
func TestEveryMemberRunsAScopedRoomAndNobodyElse(t *testing.T) {
	mux, st, _ := scoped(t)
	ada := room.Trip(tripKey, adaPassphrase)

	member, _ := tokenFor(t, "standup@acme", adaPassphrase)
	administrator, _ := tokenFor(t, "standup@acme", adamPassphrase)
	watcher, _ := tokenFor(t, "standup@acme", ivyPassphrase)
	guest, _ := tokenFor(t, "standup@acme", "")
	outsider, _ := tokenFor(t, "standup@acme", bobPassphrase)

	mute := `{"identity":"tsomebodyxx-0123456789abcdef0123456789abcdef","track":"TR_x"}`

	for _, tc := range []struct {
		who   string
		token string
		want  int
	}{
		{"a member", member, http.StatusBadGateway},
		{"an administrator who may moderate", administrator, http.StatusBadGateway},
		{"an administrator who may only watch", watcher, http.StatusForbidden},
		{"a guest", guest, http.StatusForbidden},
		{"an account outside the scope", outsider, http.StatusForbidden},
	} {
		if got := ask(mux, asking(http.MethodPost, "/api/rooms/standup@acme/mute", tc.token, mute)).Code; got != tc.want {
			t.Errorf("%s muting answered %d, want %d", tc.who, got, tc.want)
		}
	}

	// Not in the call at all, and signed in: still runs it.
	away := asking(http.MethodPost, "/api/rooms/standup@acme/close", "", "")
	away.AddCookie(sessionFor(t, st, "ada", ada))

	if got := ask(mux, away).Code; got != http.StatusBadGateway {
		t.Errorf("a member signed in and not in the call closing the room answered %d, want 502", got)
	}

	// And out of the scope, the same token stops working.
	account, _ := st.Account("ada")
	account.Scopes = nil
	if err := st.UpdateAccount("ada", account); err != nil {
		t.Fatal(err)
	}

	if got := ask(mux, asking(http.MethodPost, "/api/rooms/standup@acme/mute", member, mute)).Code; got != http.StatusForbidden {
		t.Errorf("a member taken out of the scope muting answered %d, want 403", got)
	}
}

// A member's token for one scoped room is not a member's token for another,
// which is the same guarantee a plain room's host has and is easier to lose here,
// because membership is about the scope and the scope is the same.
func TestATokenForOneScopedRoomDoesNotRunAnother(t *testing.T) {
	mux, _, _ := scoped(t)

	member, _ := tokenFor(t, "standup@acme", adaPassphrase)

	if got := ask(mux, asking(http.MethodPost, "/api/rooms/other@acme/close", member, "")).Code; got != http.StatusForbidden {
		t.Errorf("a token for standup@acme closing other@acme answered %d, want 403", got)
	}
}

func TestAScopedRoomHasNoHostAndCannotBeGivenOne(t *testing.T) {
	mux, st, _ := scoped(t)

	if got := scopedJoin(mux, "/api/rooms/standup@acme/join", adaPassphrase, nil).Code; got != http.StatusOK {
		t.Fatalf("a member could not open the room: %d", got)
	}

	if host := st.HostOf("standup@acme"); host != "" {
		t.Errorf("a scoped room recorded %q as its host; it has none", host)
	}

	member, identity := tokenFor(t, "standup@acme", adaPassphrase)

	handover := ask(mux, asking(http.MethodPost, "/api/rooms/standup@acme/host", member, `{"to":"`+identity+`"}`))
	if handover.Code != http.StatusConflict || refusal(t, handover) != reasonScopedRoom {
		t.Errorf("handing over a scoped room answered %d %q, want 409 %q",
			handover.Code, refusal(t, handover), reasonScopedRoom)
	}

	if host := st.HostOf("standup@acme"); host != "" {
		t.Errorf("a refused handover still wrote %q down", host)
	}

	// And the member is told the room is theirs to run, since it is.
	var standing struct {
		Yours bool `json:"yours"`
	}
	_ = json.Unmarshal(ask(mux, asking(http.MethodGet, "/api/rooms/standup@acme/host", member, "")).Body.Bytes(), &standing)

	if !standing.Yours {
		t.Error("a member was told a scoped room is not theirs to run")
	}
}

func TestAScopedNameCannotBeArranged(t *testing.T) {
	mux, st, _ := scoped(t)
	cookie := sessionFor(t, st, "ada", room.Trip(tripKey, adaPassphrase))

	answer := arrangeAs(t, mux, cookie, `{"room":"standup@acme","at":"`+soon()+`"}`)
	if answer.Code != http.StatusBadRequest || refusal(t, answer) != reasonScopedRoom {
		t.Errorf("arranging a scoped name answered %d %q, want 400 %q",
			answer.Code, refusal(t, answer), reasonScopedRoom)
	}

	if got := arrangeAs(t, mux, cookie, `{"room":"standup","at":"`+soon()+`"}`).Code; got != http.StatusOK {
		t.Errorf("arranging a plain name answered %d, want 200; the refusal above proves nothing", got)
	}
}
