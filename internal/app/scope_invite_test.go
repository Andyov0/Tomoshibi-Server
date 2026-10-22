package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * Links into a room held under a scope.
 *
 * A link is a member deciding to let one particular person in, so what it must
 * guarantee is narrow and each part of it fails silently: the guest is a guest
 * whatever else they brought, they wear the name the link was made for, the
 * window is kept at the door, the link is worth no more than its maker's
 * standing, and ending a meeting takes the links made in it and leaves the
 * standing ones, while revoking takes both. A link that let a guest in as
 * somebody else, or under their own name, or after the member who made it was
 * removed, would look from inside the call exactly like one that worked.
 *
 * The application's clock is pinned to one instant and every window is written
 * around it, so nothing here passes or fails by how long the machine took.
 */

var nine = time.Date(2026, time.March, 2, 9, 0, 0, 0, time.UTC)

// guarded is the scoped fixture with its clock stopped at nine.
func guarded(t *testing.T) (http.Handler, *store.Store) {
	t.Helper()

	mux, st, app := scoped(t)
	app.clock = func() time.Time { return nine }

	return mux, st
}

// link writes an invitation straight into the store.
func link(t *testing.T, st *store.Store, invite store.Invite) string {
	t.Helper()

	token, err := store.NewInviteToken()
	if err != nil {
		t.Fatal(err)
	}

	if invite.Created.IsZero() {
		invite.Created = nine
	}

	if err := st.KeepInvite(token, invite); err != nil {
		t.Fatalf("KeepInvite: %v", err)
	}

	return token
}

// mint asks for a link with a session, as the account page does.
func mint(mux http.Handler, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	if cookie != nil {
		request.AddCookie(cookie)
	}

	return ask(mux, request)
}

func TestAMemberMakesALinkWithANameAndAWindow(t *testing.T) {
	mux, st := guarded(t)
	ada := sessionFor(t, st, "ada", room.Trip(tripKey, adaPassphrase))

	answer := mint(mux, "/api/rooms/standup@acme/invites",
		`{"standing":true,"name":"Client Co","from":"2026-03-03T10:00:00+08:00","until":"2026-03-03T12:00:00+08:00"}`, ada)
	if answer.Code != http.StatusOK {
		t.Fatalf("a member making a link answered %d (%s)", answer.Code, answer.Body.String())
	}

	var said map[string]string
	_ = json.Unmarshal(answer.Body.Bytes(), &said)

	if said["name"] != "Client Co" || said["from"] != "2026-03-03T02:00:00Z" || said["expires"] != "2026-03-03T04:00:00Z" {
		t.Errorf("the link was described as %v", said)
	}

	invite, ok := st.Invite(said["token"])
	if !ok {
		t.Fatal("the link was not kept")
	}

	if invite.By != room.Trip(tripKey, adaPassphrase) || invite.Name != "Client Co" || !invite.Standing {
		t.Errorf("kept as %+v", invite)
	}

	// No end said is a link for good. Read into a fresh map: decoding into
	// the one above keeps its keys, and its end would still be there.
	lasting := mint(mux, "/api/rooms/standup@acme/invites", `{"standing":true}`, ada)
	said = map[string]string{}
	_ = json.Unmarshal(lasting.Body.Bytes(), &said)

	if invite, _ := st.Invite(said["token"]); !invite.Expires.IsZero() || said["expires"] != "" {
		t.Errorf("a link with no end was given one: %+v", invite)
	}

	// And a plain room's link is what it always was, whatever is asked for.
	plain := mint(mux, "/api/rooms/standup/invites", `{"standing":true,"name":"Client Co","until":"2027-01-01T00:00:00Z"}`,
		sessionFor(t, st, "adam", room.Trip(tripKey, adamPassphrase)))
	said = map[string]string{}
	_ = json.Unmarshal(plain.Body.Bytes(), &said)

	if invite, _ := st.Invite(said["token"]); !invite.Expires.Equal(nine.Add(24*time.Hour)) || invite.Name != "" || invite.Standing {
		t.Errorf("a plain room's link took what was asked of it: %+v", invite)
	}
}

/*
 * A link made from inside a scoped room's call is the meeting's.
 *
 * The panel says nothing but "a link", as it does in a plain room, and what it
 * gets is what a plain room gets: a day at most, nothing standing, and nothing
 * else in the body read without the request asking for a standing one. A press
 * in a call that made a link outliving the meeting would be a key handed out by
 * somebody who meant to share one call, and nothing on screen would say so.
 */
func TestALinkMadeInACallIsTheMeetings(t *testing.T) {
	mux, st := guarded(t)
	member, _ := tokenFor(t, "standup@acme", adaPassphrase)

	for _, body := range []string{"", `{"name":"Client Co","until":"2027-01-01T00:00:00Z"}`} {
		answer := ask(mux, asking(http.MethodPost, "/api/rooms/standup@acme/invites", member, body))
		if answer.Code != http.StatusOK {
			t.Fatalf("a member in the call making a link with %q answered %d (%s)", body, answer.Code, answer.Body.String())
		}

		var said map[string]string
		_ = json.Unmarshal(answer.Body.Bytes(), &said)

		invite, ok := st.Invite(said["token"])
		if !ok {
			t.Fatal("the link was not kept")
		}

		if invite.Standing || invite.Name != "" || !invite.Expires.Equal(nine.Add(inviteFor)) {
			t.Errorf("a link made in a call with %q was kept as %+v, want the meeting's", body, invite)
		}
	}
}

func TestALinkThatCouldNeverWorkIsRefusedWhenMade(t *testing.T) {
	mux, st := guarded(t)
	ada := sessionFor(t, st, "ada", room.Trip(tripKey, adaPassphrase))

	for _, tc := range []struct {
		body   string
		reason string
	}{
		{`{"standing":true,"name":"` + strings.Repeat("n", room.MaxDisplayName+1) + `"}`, reasonNameLong},
		{`{"standing":true,"until":"2026-03-02T08:59:00Z"}`, reasonBadTime},
		{`{"standing":true,"from":"2026-03-04T00:00:00Z","until":"2026-03-03T00:00:00Z"}`, reasonBadTime},
		{`{"standing":true,"until":"tomorrow"}`, reasonBadTime},
		{`{"standing":true,"from":"2026-03-04 10:00"}`, reasonBadTime},
		{`{"standing":tru`, reasonBadTime},
	} {
		answer := mint(mux, "/api/rooms/standup@acme/invites", tc.body, ada)

		if answer.Code != http.StatusBadRequest || refusal(t, answer) != tc.reason {
			t.Errorf("%s answered %d %q, want 400 %q", tc.body, answer.Code, refusal(t, answer), tc.reason)
		}
	}

	// And a name exactly as long as a name may be is not one of them.
	if answer := mint(mux, "/api/rooms/standup@acme/invites",
		`{"standing":true,"name":"`+strings.Repeat("n", room.MaxDisplayName)+`"}`, ada); answer.Code != http.StatusOK {
		t.Errorf("a name of the longest allowed length answered %d", answer.Code)
	}

	// Nor may somebody outside the scope make one at all.
	bob := sessionFor(t, st, "bob", room.Trip(tripKey, bobPassphrase))
	if answer := mint(mux, "/api/rooms/standup@acme/invites", `{"standing":true}`, bob); answer.Code != http.StatusForbidden {
		t.Errorf("an account outside the scope making a link answered %d, want 403", answer.Code)
	}
}

/*
 * The guest is a guest, under the name their link was made for.
 *
 * Somebody outside the scope may bring their own passphrase and their own
 * session and still arrive with an issued mark: the link is what let them in,
 * and anything else they carry is a claim the room did not ask for. The token
 * is decoded rather than the answer believed, because the token is what the
 * media server enforces.
 */
func TestAGuestWearsTheNameTheirLinkWasMadeFor(t *testing.T) {
	mux, st := guarded(t)
	ada := room.Trip(tripKey, adaPassphrase)
	token := link(t, st, store.Invite{Room: "standup@acme", By: ada, Name: "Client Co"})

	for _, tc := range []struct {
		who    string
		said   string
		cookie *http.Cookie
	}{
		{"somebody with nothing", "", nil},
		{"an account outside the scope, by passphrase", bobPassphrase, nil},
		{"an account outside the scope, signed in", "",
			sessionFor(t, st, "bob", room.Trip(tripKey, bobPassphrase))},
		{"a member by passphrase alone", adaPassphrase, nil},
	} {
		answer := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+token, tc.said, tc.cookie)
		if answer.Code != http.StatusOK {
			t.Errorf("%s with a link answered %d (%s)", tc.who, answer.Code, answer.Body.String())
			continue
		}

		claims := granted(t, answer)
		mark, _ := room.SignatureOf(claims.Identity)

		if mark.Proven {
			t.Errorf("%s with a link was minted %q, want an issued mark", tc.who, claims.Identity)
		}

		if claims.Name != "Client Co" {
			t.Errorf("%s with a link was called %q, want the name it was made for", tc.who, claims.Name)
		}
	}

	// Except a member who is signed in, who is that member: their session is
	// not something a link in the address bar can override.
	member := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+token, "", sessionFor(t, st, "ada", ada))
	if mark, _ := room.SignatureOf(granted(t, member).Identity); !mark.Account || mark.Trip != ada {
		t.Errorf("a member signed in with a link was minted %+v, want her account", mark)
	}
}

// Without a name on the link, what the guest typed.
func TestALinkWithoutANameLeavesTheGuestTheirOwn(t *testing.T) {
	mux, st := guarded(t)
	token := link(t, st, store.Invite{Room: "standup@acme", By: room.Trip(tripKey, adaPassphrase)})

	answer := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+token, "", nil)
	if answer.Code != http.StatusOK {
		t.Fatalf("a guest answered %d", answer.Code)
	}

	if name := granted(t, answer).Name; name != "somebody" {
		t.Errorf("a guest on a link with no name was called %q, want what they typed", name)
	}
}

func TestTheWindowIsKeptAtTheDoor(t *testing.T) {
	mux, st := guarded(t)
	ada := room.Trip(tripKey, adaPassphrase)

	for _, tc := range []struct {
		what   string
		invite store.Invite
		code   int
		reason string
	}{
		{"a link opening in an hour",
			store.Invite{Room: "standup@acme", By: ada, From: nine.Add(time.Hour)},
			http.StatusForbidden, reasonInviteNotYet},
		{"a link opening this minute",
			store.Invite{Room: "standup@acme", By: ada, From: nine},
			http.StatusOK, ""},
		{"a link that ended a minute ago",
			store.Invite{Room: "standup@acme", By: ada, Expires: nine.Add(-time.Minute)},
			http.StatusGone, reasonInviteExpired},
		{"a link with no end, made a year ago",
			store.Invite{Room: "standup@acme", By: ada, Created: nine.AddDate(-1, 0, 0)},
			http.StatusOK, ""},
		{"a link to another room under the same scope",
			store.Invite{Room: "other@acme", By: ada},
			http.StatusForbidden, reasonNotInScope},
		{"a link made by somebody outside the scope",
			store.Invite{Room: "standup@acme", By: room.Trip(tripKey, bobPassphrase)},
			http.StatusForbidden, reasonNoSuchInvite},
	} {
		answer := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+link(t, st, tc.invite), "", nil)

		if answer.Code != tc.code || refusal(t, answer) != tc.reason {
			t.Errorf("%s answered %d %q, want %d %q", tc.what, answer.Code, refusal(t, answer), tc.code, tc.reason)
		}
	}
}

// A link is worth its maker's standing, asked when it is used. Taking somebody
// out of a scope, or blocking them, or removing an administrator, takes their
// links with them, without anybody having to find and revoke each one.
func TestALinkDiesWithItsMakersMembership(t *testing.T) {
	mux, st := guarded(t)
	adam := room.Trip(tripKey, adamPassphrase)

	hers := link(t, st, store.Invite{Room: "standup@acme", By: room.Trip(tripKey, adaPassphrase)})
	his := link(t, st, store.Invite{Room: "standup@acme", By: adam})

	for name, token := range map[string]string{"a member's": hers, "an administrator's": his} {
		if got := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+token, "", nil).Code; got != http.StatusOK {
			t.Fatalf("%s link did not work while its maker could make one: %d", name, got)
		}
	}

	withdrawn := func(what, token string) {
		t.Helper()

		answer := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+token, "", nil)
		if answer.Code != http.StatusForbidden || refusal(t, answer) != reasonNoSuchInvite {
			t.Errorf("%s answered %d %q, want 403 %q", what, answer.Code, refusal(t, answer), reasonNoSuchInvite)
		}
	}

	account, _ := st.Account("ada")
	account.Blocked = true
	if err := st.UpdateAccount("ada", account); err != nil {
		t.Fatal(err)
	}

	withdrawn("a link whose maker was blocked", hers)

	account.Blocked, account.Scopes = false, []string{"elsewhere"}
	if err := st.UpdateAccount("ada", account); err != nil {
		t.Fatal(err)
	}

	withdrawn("a link whose maker left the scope", hers)

	// Not the last who may moderate, so the removal below is allowed.
	if err := st.AddAdmin(store.Admin{
		Trip: room.Trip(tripKey, "another moderator"), Name: "other", Can: []string{config.Moderate},
	}); err != nil {
		t.Fatal(err)
	}

	if err := st.RemoveAdmin(adam); err != nil {
		t.Fatal(err)
	}

	withdrawn("a link from a removed administrator", his)

	// Refused before it is counted, so the record does not say somebody came
	// through a link that let nobody in.
	if invite, _ := st.Invite(hers); invite.Spent != 1 {
		t.Errorf("a link refused for its maker was counted: spent %d, want 1", invite.Spent)
	}
}

/*
 * An administrator who exists only in the configuration is an administrator
 * for their links as well.
 *
 * Where nothing is stored, the configured list is the list, and the door
 * already let such an administrator in and let them make links. The check on a
 * link's maker read the store's own list instead, found nobody, and refused
 * every one of those links as withdrawn — a link that looked fine to whoever
 * made it and turned its guest away.
 */
func TestALinkFromAConfiguredAdministratorWorks(t *testing.T) {
	mux, st, app := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"})
	app.clock = func() time.Time { return nine }

	cara := room.Trip(tripKey, "cara only in the file")
	app.conf.Meet.Admins = []config.Admin{{Trip: cara, Name: "cara", Can: []string{config.Moderate}}}

	token := link(t, st, store.Invite{Room: "standup@acme", By: cara})

	if answer := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+token, "", nil); answer.Code != http.StatusOK {
		t.Errorf("a link from a configured administrator answered %d (%s), want 200", answer.Code, answer.Body.String())
	}
}

/*
 * A member who is holding a link that is no good is still a member.
 *
 * The cookie a guest visit leaves is sent with every join for a day, and a tab
 * keeps the last link it was let in on. A link for another room, or one that has
 * run out, is not a reason to turn away somebody whose passphrase would have let
 * them in on its own.
 */
func TestAStaleLinkDoesNotShutOutAMember(t *testing.T) {
	mux, st := guarded(t)
	ada := room.Trip(tripKey, adaPassphrase)

	for name, token := range map[string]string{
		"a link to another room": link(t, st, store.Invite{Room: "other@acme", By: ada}),
		"a link that ran out":    link(t, st, store.Invite{Room: "standup@acme", By: ada, Expires: nine.Add(-time.Hour)}),
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup@acme/join",
			strings.NewReader(`{"name":"ada","passphrase":"`+adaPassphrase+`"}`))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(&http.Cookie{Name: inviteCookie, Value: token})

		answer := ask(mux, request)
		if answer.Code != http.StatusOK {
			t.Errorf("a member holding %s answered %d (%s)", name, answer.Code, answer.Body.String())
			continue
		}

		if mark, _ := room.SignatureOf(granted(t, answer).Identity); !mark.Proven || mark.Trip != ada {
			t.Errorf("a member holding %s was minted %+v, want her own mark", name, mark)
		}
	}
}

func TestAGuestDoesNotRunTheRoom(t *testing.T) {
	mux, st := guarded(t)
	token := link(t, st, store.Invite{Room: "standup@acme", By: room.Trip(tripKey, adaPassphrase)})

	var joined joinResponse
	_ = json.Unmarshal(scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+token, "", nil).Body.Bytes(), &joined)

	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/rooms/standup@acme/invites"},
		{http.MethodPost, "/api/rooms/standup@acme/close"},
		{http.MethodDelete, "/api/rooms/standup@acme/invites"},
	} {
		if got := ask(mux, asking(tc.method, tc.path, joined.Token, "")).Code; got != http.StatusForbidden {
			t.Errorf("a guest's %s %s answered %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
 * Ending a meeting, and revoking.
 *
 * A standing invitation is not the meeting's, so ending one keeps it; a link
 * made in the call is, in a scoped room exactly as in a plain one, and ending it
 * throws that away as it always did. All three are asserted, because a version
 * that kept every scoped room's links would pass the first alone and leave a
 * link working that its host deliberately ended. Revoking is the way to keep
 * somebody out of a scoped room, and it takes every link to it.
 */
func TestEndingAScopedMeetingKeepsOnlyStandingLinks(t *testing.T) {
	mux, st := guarded(t)
	ada := room.Trip(tripKey, adaPassphrase)
	adam := room.Trip(tripKey, adamPassphrase)

	scopedLink := link(t, st, store.Invite{Room: "standup@acme", By: ada, Standing: true})
	meetingLink := link(t, st, store.Invite{Room: "standup@acme", By: ada, Expires: nine.Add(time.Hour)})
	plainLink := link(t, st, store.Invite{Room: "standup", By: adam, Expires: nine.Add(time.Hour)})

	// The media server is absent, so the close itself answers 502 — after the
	// links have been dealt with, which is the order dissolve keeps.
	for _, path := range []string{"/api/rooms/standup@acme/close", "/api/rooms/standup/close"} {
		request := asking(http.MethodPost, path, "", "")
		request.AddCookie(sessionFor(t, st, "adam", adam))
		_ = ask(mux, request)
	}

	if _, ok := st.Invite(scopedLink); !ok {
		t.Error("ending a scoped meeting threw a standing invitation away")
	}

	if _, ok := st.Invite(meetingLink); ok {
		t.Error("ending a scoped meeting kept a link made in it")
	}

	if _, ok := st.Invite(plainLink); ok {
		t.Error("ending a plain meeting kept its links")
	}

	if got := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+scopedLink, "", nil).Code; got != http.StatusOK {
		t.Errorf("a scoped link after the meeting ended answered %d, want 200", got)
	}

	revoke := asking(http.MethodDelete, "/api/rooms/standup@acme/invites", "", "")
	revoke.AddCookie(sessionFor(t, st, "ada", ada))

	if got := ask(mux, revoke).Code; got != http.StatusOK {
		t.Fatalf("a member revoking answered %d", got)
	}

	if got := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+scopedLink, "", nil).Code; got != http.StatusForbidden {
		t.Errorf("a revoked link answered %d, want 403", got)
	}
}

func TestTheLandingPageIsToldWhatTheLinkIsFor(t *testing.T) {
	mux, st := guarded(t)
	ada := room.Trip(tripKey, adaPassphrase)

	read := func(token string) (int, map[string]string) {
		answer := ask(mux, httptest.NewRequest(http.MethodGet, "/api/invites/"+token, nil))

		var said map[string]string
		_ = json.Unmarshal(answer.Body.Bytes(), &said)

		return answer.Code, said
	}

	code, said := read(link(t, st, store.Invite{
		Room: "standup@acme", By: ada, Name: "Client Co", From: nine.Add(-time.Hour), Expires: nine.Add(time.Hour),
		Standing: true,
	}))
	if code != http.StatusOK || said["room"] != "standup@acme" || said["name"] != "Client Co" ||
		said["from"] != "2026-03-02T08:00:00Z" || said["expires"] != "2026-03-02T10:00:00Z" {
		t.Errorf("a windowed link read as %d %v", code, said)
	}

	if _, present := said["by"]; present {
		t.Error("the page was told who made the link, which is their identity everywhere")
	}

	code, said = read(link(t, st, store.Invite{Room: "standup@acme", By: ada, Standing: true}))
	if _, present := said["expires"]; code != http.StatusOK || present {
		t.Errorf("a lasting link read as %d %v, want no end", code, said)
	}

	// A link made in a call says only where it goes, as it always did: its end
	// is the meeting's, and the day under it is not something to plan around.
	code, said = read(link(t, st, store.Invite{Room: "standup@acme", By: ada, Expires: nine.Add(inviteFor)}))
	if _, present := said["expires"]; code != http.StatusOK || present || said["room"] != "standup@acme" {
		t.Errorf("a meeting's link read as %d %v, want the room and nothing else", code, said)
	}

	code, said = read(link(t, st, store.Invite{
		Room: "standup@acme", By: ada, From: nine.Add(26 * time.Hour), Standing: true,
	}))
	if code != http.StatusForbidden || said["error"] != reasonInviteNotYet || said["from"] != "2026-03-03T11:00:00Z" {
		t.Errorf("an early link read as %d %v, want 403 %q with when", code, said, reasonInviteNotYet)
	}
}

// The closed store refuses a scoped join with a link as well. A link the store
// cannot read is a link it cannot vouch for, and the door has no other way to
// tell it from a guessed token.
func TestAClosedStoreRefusesALinkToo(t *testing.T) {
	mux, st := guarded(t)
	token := link(t, st, store.Invite{Room: "standup@acme", By: room.Trip(tripKey, adaPassphrase)})

	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	if got := scopedJoin(mux, "/api/rooms/standup@acme/join?invite="+token, "", nil).Code; got != http.StatusServiceUnavailable {
		t.Errorf("a link with the store closed answered %d, want 503", got)
	}
}
