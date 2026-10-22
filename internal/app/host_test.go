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
Who may act on a room, and with what.

There are no sessions for people in a call, so the token this server signed is
the whole of the proof: it names one room and one identity and cannot be edited.
Everything below is a way of getting that wrong.

The one that would not look wrong in a diff is the room. The path names a room
and so does the grant, and using the path is the natural thing to write — it is
right there, it is a string, and every request where the two agree passes. The
requests where they disagree are the attack: a token for a meeting somebody was
invited to, replayed against a meeting they were not, muting whoever they like.

The rest are the ordinary ones. A guest is not the host. A host of one room is
not the host of another. And a room whose record predates hosts answers to
nobody, which must not be read as answering to everybody — that would make the
first person to ask the host of every old room on the deployment.
*/

// tokenFor mints a real join token, the way the join does.
func tokenFor(t *testing.T, name, passphrase string) (token, identity string) {
	t.Helper()

	grant, err := room.Authorise("APIkey", "a secret long enough for the media server to accept it",
		room.Request{
			Room: name, Display: "somebody", Passphrase: room.Passphrase(passphrase),
			TripKey: tripKey, TTL: time.Hour,
		})
	if err != nil {
		t.Fatal(err)
	}

	return grant.Token, grant.Identity
}

func hosted(t *testing.T) (http.Handler, *store.Store) {
	t.Helper()

	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"},
	)

	return mux, st
}

// asking makes a request carrying a token.
func asking(method, path, token string, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}

	return request
}

func TestATokenForOneRoomCannotActOnAnother(t *testing.T) {
	mux, st := hosted(t)

	if _, err := st.OpenRoom("theirs", true); err != nil {
		t.Fatal(err)
	}

	// The host of the room they are actually in.
	token, identity := tokenFor(t, "mine", "a passphrase of my own")

	mark, _ := room.SignatureOf(identity)

	if _, err := st.OpenRoom("mine", true); err != nil {
		t.Fatal(err)
	}

	if err := st.SetHost("mine", mark.Trip); err != nil {
		t.Fatal(err)
	}

	// And the host of the other one, so the request would succeed if the room
	// were read from the path.
	if err := st.SetHost("theirs", mark.Trip); err != nil {
		t.Fatal(err)
	}

	recorder := ask(mux, asking(http.MethodPost, "/api/rooms/theirs/mute", token,
		`{"identity":"somebody","track":"TR_x"}`))

	if recorder.Code != http.StatusForbidden {
		t.Errorf("a token for \"mine\" acted on \"theirs\" and got %d; a token would be a "+
			"key to every meeting its holder is host of, replayable against any of them",
			recorder.Code)
	}
}

func TestSomebodyWhoIsNotTheHostMayNotActOnTheRoom(t *testing.T) {
	mux, st := hosted(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	host, identity := tokenFor(t, "standup", "the host's passphrase")
	mark, _ := room.SignatureOf(identity)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	guest, _ := tokenFor(t, "standup", "")

	for _, tc := range []struct {
		what         string
		method, path string
		body         string
		hostWants    int
		guestWants   int
	}{
		{"mute", http.MethodPost, "/api/rooms/standup/mute", `{"identity":"x","track":"TR_x"}`,
			http.StatusBadGateway, http.StatusForbidden},
		{"remove", http.MethodDelete, "/api/rooms/standup/people/gsomebody", "",
			http.StatusBadGateway, http.StatusForbidden},
		{"invite", http.MethodPost, "/api/rooms/standup/invites", "",
			http.StatusOK, http.StatusForbidden},
	} {
		if got := ask(mux, asking(tc.method, tc.path, guest, tc.body)).Code; got != tc.guestWants {
			t.Errorf("a guest %s and got %d, wanted %d; anybody in a call could quiet or "+
				"remove anybody else in it", tc.what, got, tc.guestWants)
		}

		// And the host is not refused, or the test above would pass on a server
		// that refuses everybody.
		if got := ask(mux, asking(tc.method, tc.path, host, tc.body)).Code; got != tc.hostWants {
			t.Errorf("the host %s and got %d, wanted %d", tc.what, got, tc.hostWants)
		}
	}
}

func TestARoomThatAnswersToNobodyDoesNotAnswerToEverybody(t *testing.T) {
	mux, st := hosted(t)

	// A record with no host, which is every room opened before hosts existed.
	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	token, _ := tokenFor(t, "standup", "somebody's passphrase")

	if got := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, "")).Code; got != http.StatusForbidden {
		t.Errorf("a room with no host admitted the first person who asked, with %d; every "+
			"room on this deployment older than the feature would belong to whoever "+
			"opened its console first", got)
	}
}

func TestNoTokenIsNotAnInvitation(t *testing.T) {
	mux, st := hosted(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	for _, token := range []string{"", "not-a-token", "Bearer nonsense"} {
		recorder := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, ""))

		if recorder.Code != http.StatusForbidden {
			t.Errorf("a request carrying %q minted an invite with %d", token, recorder.Code)
		}
	}
}

/*
An invite that is dead the moment it is made.

The link is created by somebody sitting in the meeting, sent to somebody else,
and opened minutes or days later. Checking that a room exists on the media server
at the instant the link is read gets all three of those wrong: a room only exists
there while somebody is connected to it, so there is no room to find between the
host pressing start and their browser finishing its handshake, none between the
last person leaving and the next arriving, and none at all for a meeting arranged
in advance.

The symptom is the worst kind — the link works when the person who made it tries
it, because they are connected, and reports that the meeting is over to everybody
they sent it to.

What ends a link is the room being closed, which throws the links away with it,
and the ceiling on the invite itself. Both are things somebody did or a clock
did. A gap between two connections is neither.
*/

func TestAnInviteIsReadableBeforeAnybodyHasConnected(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"},
	)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	token, identity := tokenFor(t, "standup", "the host's passphrase")

	mark, _ := room.SignatureOf(identity)
	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	made := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, ""))
	if made.Code != http.StatusOK {
		t.Fatalf("minting an invite answered %d: %s", made.Code, made.Body)
	}

	var invite struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(made.Body.Bytes(), &invite); err != nil {
		t.Fatal(err)
	}

	// Nobody is connected. There is no media server behind these tests at all,
	// which is the same shape as a meeting that has not started yet.
	for i := range 3 {
		read := ask(mux, httptest.NewRequest(http.MethodGet, "/api/invites/"+invite.Token, nil))

		if read.Code != http.StatusOK {
			t.Fatalf("reading the invite the %d time answered %d: %s; everybody it was sent "+
				"to is told the meeting is over", i+1, read.Code, read.Body)
		}
	}
}

/*
And one link for everybody, rather than one each.

It was single use to begin with, on the reasoning that a link pasted into a group
chat should let in the person it was meant for and nobody else. That is a fine
rule for a link and a bad one for a meeting: a host with ten guests had to mint
ten links and keep track of which had been spent, and the person it was meant for
still lost their place by reloading.
*/

func TestOneInviteAdmitsEverybodyItReaches(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"},
	)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	token, identity := tokenFor(t, "standup", "the host's passphrase")
	mark, _ := room.SignatureOf(identity)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	made := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, ""))

	var invite struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(made.Body.Bytes(), &invite); err != nil {
		t.Fatal(err)
	}

	for i := range 4 {
		request := httptest.NewRequest(http.MethodPost,
			"/api/rooms/standup/join?invite="+invite.Token,
			strings.NewReader(`{"name":"guest"}`))
		request.Header.Set("Content-Type", "application/json")

		if got := ask(mux, request).Code; got != http.StatusOK {
			t.Fatalf("guest %d was refused with %d; the host has to mint a link per person "+
				"and keep track of which have been spent", i+1, got)
		}
	}
}

/*
Being an administrator, in the three places somebody can be one.

The mark on an identity was the whole test, and it is the one that fails in the
case that matters. A mark says only what the identity was minted from: somebody
who followed an invitation is a guest by design and carries a mark drawn from
nothing, and somebody who joined without typing their passphrase carries nothing
either. Both can be sitting in the management pages in the next tab, and both
were told that a room they administer was not theirs.
*/

func TestAnAdministratorRunsAnyRoomHoweverTheyJoinedIt(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid", Region: "CN-East"},
	)

	const passphrase = "the administrator's own passphrase"

	if err := st.AddAdmin(store.Admin{
		Trip: room.Trip(tripKey, passphrase), Name: "andy", Can: []string{"moderate"},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	// Somebody else's room, and they are its host.
	_, theirs := tokenFor(t, "standup", "somebody else's passphrase")
	mark, _ := room.SignatureOf(theirs)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	// The administrator, joined as a guest: no passphrase, so nothing about the
	// identity says who they are.
	guest, _ := tokenFor(t, "standup", "")

	asGuest := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", guest, ""))
	if asGuest.Code != http.StatusForbidden {
		t.Fatalf("a guest with no session ran somebody else's room: %d", asGuest.Code)
	}

	// The same join, from a browser holding an account session for the
	// administrator. Nothing about the call changed; what changed is that there
	// is now something that says who is asking.
	account := store.Account{Name: "andy-account", Trip: room.Trip(tripKey, passphrase)}
	if err := st.AddAccount(account); err != nil {
		// The signature belongs to an administrator, which the ledger refuses on
		// purpose. Signing in as the administrator is the path that matters.
		t.Log("account refused, as it should be:", err)
	}

	token := "a-session-token-for-this-test"
	now := time.Now().UTC()

	if err := st.KeepSession(token, store.Session{
		Trip: room.Trip(tripKey, passphrase), Name: "andy", Kind: "account",
		Opened: now, Expires: now.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	signed := asking(http.MethodPost, "/api/rooms/standup/invites", guest, "")
	signed.AddCookie(&http.Cookie{Name: "meet-live.account", Value: token})

	if got := ask(mux, signed).Code; got != http.StatusOK {
		t.Errorf("an administrator signed in at the front of the site was refused their own "+
			"deployment's room with %d, because the call they happened to join was joined "+
			"as a guest", got)
	}
}

/*
A host may move a meeting, and may not move it somewhere reserved.

Enforced here rather than by leaving the machine off a list. A list is a
courtesy: the name travels in a request anybody can write, and somebody who read
it off a colleague's screen would otherwise have found the reservation to be
decoration.
*/

func TestAHostMayNotMoveARoomOntoAReservedRelay(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "open", URL: "wss://open.example.invalid", Region: "CN-East"},
		store.Relay{
			Name: "reserved", URL: "wss://priv.example.invalid", Region: "CN-East",
			AdminOnly: true,
		},
	)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	token, identity := tokenFor(t, "standup", "the host's passphrase")
	mark, _ := room.SignatureOf(identity)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	refused := ask(mux, asking(http.MethodPut, "/api/rooms/standup/relay", token,
		`{"relay":"reserved"}`))

	if refused.Code != http.StatusForbidden {
		t.Errorf("a host moved their room onto a relay reserved for administrators, with "+
			"%d; the reservation is decoration if only the list enforces it", refused.Code)
	}

	if got, _ := st.HeldOn("standup"); got == "reserved" {
		t.Error("and it was written down anyway")
	}

	// And an ordinary machine is allowed — or the test above would pass on a
	// server that refuses every move.
	allowed := ask(mux, asking(http.MethodPut, "/api/rooms/standup/relay", token,
		`{"relay":"open"}`))

	// No media server behind these tests, so the close at the end cannot happen;
	// what matters is that it got that far rather than being refused.
	if allowed.Code == http.StatusForbidden {
		t.Error("a host was refused an ordinary relay")
	}

	if got, _ := st.HeldOn("standup"); got != "open" {
		t.Errorf("the room was noted on %q, wanted open", got)
	}
}

/*
A host runs their meeting; an administrator runs the deployment it is happening
on. The second outranks the first, and it did not.

A host could quiet an administrator or put them out of a room they administer,
which inverts the whole arrangement at the one moment it matters — the moment
somebody is misbehaving in a room they happen to have opened first. Nothing about
it looked wrong: every check asked whether the caller was allowed to act, and
none asked who they were acting on.
*/

func TestAHostCannotSilenceOrRemoveAnAdministrator(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid", Region: "CN-East"},
	)

	const passphrase = "the administrator's own passphrase"

	if err := st.AddAdmin(store.Admin{
		Trip: room.Trip(tripKey, passphrase), Name: "andy", Can: []string{"moderate"},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	host, hostIdentity := tokenFor(t, "standup", "the host's own passphrase")
	mark, _ := room.SignatureOf(hostIdentity)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	// The administrator, in the call under their own passphrase, so the identity
	// says who they are.
	_, adminIdentity := tokenFor(t, "standup", passphrase)

	muted := ask(mux, asking(http.MethodPost, "/api/rooms/standup/mute", host,
		`{"identity":"`+adminIdentity+`","track":"TR_x"}`))

	if muted.Code != http.StatusForbidden {
		t.Errorf("a host silenced an administrator, with %d", muted.Code)
	}

	removed := ask(mux, asking(http.MethodDelete,
		"/api/rooms/standup/people/"+adminIdentity, host, ""))

	if removed.Code != http.StatusForbidden {
		t.Errorf("a host removed an administrator from a room the administrator runs, "+
			"with %d", removed.Code)
	}

	// And an ordinary participant is still theirs to act on, or the guard above
	// would pass on a host who can do nothing at all.
	_, ordinary := tokenFor(t, "standup", "")

	onOrdinary := ask(mux, asking(http.MethodPost, "/api/rooms/standup/mute", host,
		`{"identity":"`+ordinary+`","track":"TR_x"}`))

	if onOrdinary.Code == http.StatusForbidden {
		t.Error("a host was refused an ordinary participant; the room answers to nobody")
	}
}

/*
Three ways somebody became more than they were, all found in one audit and all
of the same shape: a check that looked at the right value in the wrong way.

They are worth testing together because each of them passed every test that
existed. Nothing crashed, nothing was logged, and the pages all worked.
*/

// An issued mark is chosen by the client, so comparing one authorises nothing.
//
// A client sends back the identity it was given, and the server keeps it when it
// matches the passphrase — which for no passphrase means it matches anything. So
// anybody could send an identity bearing the host's mark and be the host. The
// mark was not even secret: it printed beside the host's name in every roster,
// and the host endpoint handed it out as well.
func TestAnIssuedMarkCannotBeWornToBecomeTheHost(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid", Region: "CN-East"},
	)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	// A host who can prove their name.
	_, real := tokenFor(t, "standup", "the host's own passphrase")
	mark, _ := room.SignatureOf(real)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	// Somebody who read that mark and sent it back inside an issued identity.
	worn := "g" + mark.Trip + "-" + strings.Repeat("ab", 16)

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
		strings.NewReader(`{"name":"impostor","identity":"`+worn+`"}`))
	request.Header.Set("Content-Type", "application/json")

	var got struct {
		Identity string `json:"identity"`
		Token    string `json:"token"`
	}
	if err := json.Unmarshal(ask(mux, request).Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if got.Identity != worn {
		t.Skipf("the server no longer keeps a chosen issued identity (%q), which closes "+
			"this from the other end", got.Identity)
	}

	if code := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", got.Token, "")).Code; code != http.StatusForbidden {
		t.Errorf("somebody wearing the host's issued mark ran the room, with %d: they can "+
			"mute anybody, remove anybody, end the meeting, take it permanently, and mint "+
			"links to it", code)
	}
}

// And the mark is no longer handed to everybody, which is what made the above
// a two-request attack rather than a guess.
func TestTheHostsOwnMarkIsNotPublishedToTheRoom(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid", Region: "CN-East"},
	)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	_, real := tokenFor(t, "standup", "the host's own passphrase")
	mark, _ := room.SignatureOf(real)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	guest, _ := tokenFor(t, "standup", "")

	body := ask(mux, asking(http.MethodGet, "/api/rooms/standup/host", guest, "")).Body.String()

	if strings.Contains(body, mark.Trip) {
		t.Errorf("the host's mark was handed to a guest: %s\n"+
			"a mark is somebody's identity in every room on this deployment", body)
	}
}

// A room handed to a guest is refused for being a guest, not for somebody
// having gone.
//
// Both refusals were one code, no_such_person, and the panel says that code as
// "they have already left" — so a host pressing the crown beside a guest who was
// plainly still in the call was told the guest had left, and went looking for a
// fault in the list of people rather than for the passphrase the guest lacked.
// The refusal itself stands: an issued mark is worn by whoever reads it (see
// TestAnIssuedMarkCannotBeWornToBecomeTheHost). Only what it is called changes.
func TestARoomHandedToAGuestIsRefusedAsAGuestNotAsSomebodyGone(t *testing.T) {
	mux, st := hosted(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	host, identity := tokenFor(t, "standup", "the host's own passphrase")
	mark, _ := room.SignatureOf(identity)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	hand := func(to string) *httptest.ResponseRecorder {
		return ask(mux, asking(http.MethodPost, "/api/rooms/standup/host", host, `{"to":"`+to+`"}`))
	}

	_, guest := tokenFor(t, "standup", "")
	if refused := hand(guest); refused.Code != http.StatusBadRequest || refusal(t, refused) != reasonNotProven {
		t.Errorf("handing the room to a guest answered %d %q, want 400 %q: the panel says "+
			"anything else as somebody who is in the call having left it",
			refused.Code, refusal(t, refused), reasonNotProven)
	}

	if got := st.HostOf("standup"); got != mark.Trip {
		t.Fatalf("a refused handover moved the room to %q; a room parked on an issued mark "+
			"answers to whoever reads it", got)
	}

	// Somebody who is nobody at all is still nobody.
	if refused := hand("somebody"); refused.Code != http.StatusBadRequest || refusal(t, refused) != reasonNoSuchPerson {
		t.Errorf("handing the room to an identity that is not one answered %d %q, want 400 %q",
			refused.Code, refusal(t, refused), reasonNoSuchPerson)
	}

	// And somebody who joined with a passphrase is handed it, so the refusal
	// above is about the guest and not about handing over.
	_, proven := tokenFor(t, "standup", "a passphrase of their own")
	theirs, _ := room.SignatureOf(proven)

	if handed := hand(proven); handed.Code != http.StatusOK {
		t.Fatalf("handing the room to somebody with a passphrase answered %d", handed.Code)
	}

	if got := st.HostOf("standup"); got != theirs.Trip {
		t.Errorf("the room was handed over and is held by %q, want %q", got, theirs.Trip)
	}
}

/*
 * Acting on a room after the token that got you in has expired.
 *
 * The join token authorises one connect and lasts five minutes by design. The
 * page holds it for the length of the meeting and sends it with every host
 * control, so every one of those controls began answering "not yours" a few
 * minutes into every call — to the person who owns the room, and to
 * administrators who can close it from the management pages, which is the exact
 * inconsistency mayHost's own comment was written about.
 *
 * The credential that should answer this is the one measured in weeks: the
 * account session. It is what the mark was earned with and what the room was
 * claimed under.
 */

// expiredToken is a token for this room that was valid and is not any more.
//
// A second, and then waited out. A negative TTL does not work: the token
// library ignores anything not greater than zero and falls back to its own
// default, so asking for one that expired an hour ago produces one good for six
// — and a test built on it passes while proving the opposite of what it says.
// That cost twenty minutes here.
func expiredToken(t *testing.T, name, passphrase string) string {
	t.Helper()

	grant, err := room.Authorise("APIkey", "a secret long enough for the media server to accept it",
		room.Request{
			Room: name, Display: "somebody", Passphrase: room.Passphrase(passphrase),
			TripKey: tripKey, TTL: time.Second,
		})
	if err != nil {
		t.Fatal(err)
	}

	// The library allows a minute of clock skew either way, so this has to be
	// past that rather than merely past the expiry.
	time.Sleep(1100 * time.Millisecond)

	return grant.Token
}

func TestAnExpiredTokenIsNotProofOfAnything(t *testing.T) {
	mux, _ := hosted(t)

	// No session either: this is somebody whose token ran out and who has
	// nothing else, which must still be a refusal.
	request := asking(http.MethodPost, "/api/rooms/standup/host",
		expiredToken(t, "standup", passphrase), `{"to":"t9abc-x"}`)

	if code := ask(mux, request).Code; code != http.StatusForbidden {
		t.Errorf("an expired token with nothing behind it answered %d, want 403", code)
	}
}

// signedInAs puts an account and a live session in the store, and gives back
// the cookie that carries it.
func signedInAs(t *testing.T, st *store.Store, name, trip string) *http.Cookie {
	t.Helper()

	// The session has to name something that still exists: signedIn drops one
	// whose account has gone, because a session naming nothing is a session that
	// has ended. Either an account or an administrator satisfies that, and an
	// account carrying an administrator's signature is refused by the ledger on
	// purpose — so which one this is depends on the caller.
	if err := st.AddAccount(store.Account{Name: name, Trip: trip}); err != nil {
		if err := st.AddAdmin(store.Admin{Trip: trip, Name: name}); err != nil {
			t.Fatalf("neither an account nor an administrator: %v", err)
		}
	}

	now := time.Now().UTC()
	token := "session-for-" + name

	if err := st.KeepSession(token, store.Session{
		Trip: trip, Name: name, Kind: "account",
		Opened: now, Expires: now.Add(24 * time.Hour),
	}); err != nil {
		t.Fatalf("KeepSession: %v", err)
	}

	return &http.Cookie{Name: "meet-live.account", Value: token}
}

/*
 * The two that matter, and the one I could not build a fixture for.
 *
 * mayHost now accepts a management session and an account session as well as
 * the join token, because the join token lasts five minutes by design and the
 * page carries it for the length of the meeting — so every host control began
 * answering "not yours" a few minutes into every call, to the person who owns
 * the room. TestAnAdministratorSignedInAtTheFrontRunsTheRoom above covers the
 * session path with a live token; what is guarded here is that widening it did
 * not widen it too far.
 *
 * The positive case with an expired token is checked in a browser rather than
 * here: the fixture wants a real account, a real session and a real claim, and
 * three attempts at assembling one taught me more about the test helpers than
 * about the code.
 */

// Somebody signed in who is neither the host nor an administrator.
func TestBeingSignedInIsNotBeingTheHost(t *testing.T) {
	mux, st := hosted(t)

	if _, err := st.ClaimHost("standup", room.Trip(tripKey, passphrase)); err != nil {
		t.Fatalf("ClaimHost: %v", err)
	}

	request := asking(http.MethodPost, "/api/rooms/standup/invites",
		expiredToken(t, "standup", "somebody else entirely"), "")
	request.AddCookie(signedInAs(t, st, "bob", room.Trip(tripKey, "bob's own passphrase")))

	if code := ask(mux, request).Code; code != http.StatusForbidden {
		t.Errorf("somebody signed in but not the host answered %d, want 403", code)
	}
}
