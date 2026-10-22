package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"time"

	"github.com/livekit/protocol/livekit"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
Whether picking a server does anything for the second person into a room.

For the first person it always did: an empty name is opened wherever they are
sent. For everybody after them it did nothing at all, and the reason is that a
meeting lives on one node — the media server binds a room to whoever opened it
and forwards the rest. This server used to settle that by discarding the choice
and sending them to the holder, which is defensible and was also the reason a
relay bought for the route into it could sit for a month carrying no calls.

So the choice is kept and the media is forwarded through it. That turns one
decision into three, and each of them is a way for this to be quietly wrong:

  - the client must still dial the relay it picked, or forwarding has nothing to
    forward through;
  - it must be given credentials for that relay and not for the holder, which is
    the mistake that reads correctly in a diff and fails only in a call;
  - a relay that will not forward must send them to the holder instead, because
    a client pointed at a TURN server that is not there gathers no candidates at
    all and never connects — worse than the behaviour this replaced.

The room record is the fixture here. It is what says where a meeting already is,
and every case below is really a question about what this server does with it.
*/

// where a relay has a TURN server, is allowed to use it, and is on the same side
// of the border as the others here.
//
// The region is not decoration. Forwarding is refused between networks, and a
// relay with none is paired with nobody — so a fixture that leaves it out tests
// the guard rather than the thing it was written for, and does it silently.
func forwarder(name, url, turn string) store.Relay {
	return store.Relay{Name: name, URL: url, Turn: turn, Forwards: true, Region: "CN-East"}
}

// joinVia asks to join a room through a named relay and reads the answer.
func joinVia(t *testing.T, mux http.Handler, roomName, relay string) struct {
	URL     string `json:"url"`
	Relay   string `json:"relay"`
	Forward *struct {
		URL        string `json:"url"`
		Username   string `json:"username"`
		Credential string `json:"credential"`
	} `json:"forward"`
} {
	t.Helper()

	var answer struct {
		URL     string `json:"url"`
		Relay   string `json:"relay"`
		Forward *struct {
			URL        string `json:"url"`
			Username   string `json:"username"`
			Credential string `json:"credential"`
		} `json:"forward"`
	}

	body := `{"name":"somebody","relay":"` + relay + `"}`

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/"+roomName+"/join",
		strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Host = "meet.example.com"

	recorder := ask(mux, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("join through %q answered %d: %s", relay, recorder.Code, recorder.Body)
	}

	if err := json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}

	return answer
}

func TestSomebodyJoiningARoomHeldElsewhereKeepsTheRelayTheyPicked(t *testing.T) {
	mux := control(t, config.PickProbe,
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	// The first person opens it, which is what puts the meeting on a machine.
	opened := joinVia(t, mux, "standup", "guangzhou")
	if opened.Forward != nil {
		t.Error("the first person into a room was sent through a relay to reach the " +
			"relay they were already on; every call would pay a hop for nothing")
	}

	second := joinVia(t, mux, "standup", "shanghai")

	if second.URL != "wss://sh.example.invalid" {
		t.Fatalf("the second person was sent to %s after picking shanghai; the choice was "+
			"discarded, which is the whole fault this exists to fix", second.URL)
	}

	if second.Forward == nil {
		t.Fatal("no forwarding was offered for a room held on another machine; the media " +
			"would go straight past the relay that was picked, and it would carry none " +
			"of the call it was chosen for")
	}

	// The relay they dialled, not the one holding the room. Handing over the
	// holder's TURN would read correctly, connect, and quietly restore exactly
	// the behaviour being replaced.
	if !strings.Contains(second.Forward.URL, "sh.example.invalid:39219") {
		t.Errorf("media was pointed at %q, which is not the relay that was picked",
			second.Forward.URL)
	}

	if second.Forward.Username == "" || second.Forward.Credential == "" {
		t.Error("forwarding was offered with no credentials; the browser would gather " +
			"no candidates at all and the call would never connect")
	}
}

func TestARelayThatWillNotForwardSendsThemToTheRoomInstead(t *testing.T) {
	for _, tc := range []struct {
		why   string
		entry store.Relay
	}{
		{
			"whoever pays for it said no, which is a real answer: relaying costs " +
				"the machine two bytes for every one it carries",
			store.Relay{
				Name: "shanghai", URL: "wss://sh.example.invalid", Region: "CN-East",
				Turn: "sh.example.invalid:39219", Forwards: false,
			},
		},
		{
			"it runs no TURN server, so there is nothing to point a browser at",
			store.Relay{
				Name: "shanghai", URL: "wss://sh.example.invalid", Region: "CN-East",
				Forwards: true,
			},
		},
	} {
		mux := control(t, config.PickProbe,
			tc.entry,
			forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
		)

		joinVia(t, mux, "standup", "guangzhou")

		second := joinVia(t, mux, "standup", "shanghai")

		if second.Forward != nil {
			t.Errorf("%s: forwarding was offered anyway; the browser would be sent to a "+
				"TURN server that will not answer, gather nothing, and never connect", tc.why)
		}

		if second.URL != "wss://gz.example.invalid" {
			t.Errorf("%s: sent to %s rather than to the machine holding the room; with no "+
				"way to forward, that is a call that does not happen", tc.why, second.URL)
		}
	}
}

// A room nobody has been in for hours is not held anywhere, so the next person
// picks freely and pays no hop. This is the other half of the expiry: without
// it, forwarding would be permanent — every room would forward to the machine it
// first landed on, for good.
func TestAQuietRoomIsPickedAfreshRatherThanForwardedTo(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	joinVia(t, mux, "standup", "guangzhou")

	// Let go of, rather than waited out. What is being checked is that this
	// server reads the record on every join instead of deciding once.
	if err := st.ReleaseRoom("standup"); err != nil {
		t.Fatal(err)
	}

	fresh := joinVia(t, mux, "standup", "shanghai")

	if fresh.Forward != nil {
		t.Error("a room nobody had been in for hours still forwarded to where it used " +
			"to be; the hop would be paid forever and the choice would stop meaning " +
			"anything the second time a name was used")
	}

	if fresh.URL != "wss://sh.example.invalid" {
		t.Errorf("sent to %s rather than to the freshly picked relay", fresh.URL)
	}
}

/*
Signing in is a way of having proved a name.

Under the middle setting a new name is refused unless whoever asked can prove
one, and until accounts existed the only proof was a passphrase in the request.
Now there are two doors and only one of them was being looked at: somebody who
signed in at their own page has no reason to type their passphrase again, and
would be turned away from starting a room while signed in, known to this server
by name, for having left blank a field they had already answered elsewhere.

The refusal is also silent in the useful sense — it arrives as a 403 on a name
nobody has used, which reads as the name being taken or the deployment being
broken rather than as a field not filled in.
*/

func TestSomebodySignedInMayOpenARoomWithoutTypingTheirPassphraseAgain(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"},
	)

	if err := st.SetOpening(room.BySigned); err != nil {
		t.Fatal(err)
	}

	// An administrator has to exist, or the policy resolves to "anyone" and this
	// would pass without proving anything.
	if err := st.AddAdmin(store.Admin{Trip: "aaaaabbbbb", Name: "someone"}); err != nil {
		t.Fatal(err)
	}

	// Nobody, with nothing. Refused, which is the setting working.
	anonymous := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
		strings.NewReader(`{"name":"nobody"}`))
	anonymous.Header.Set("Content-Type", "application/json")

	if got := ask(mux, anonymous).Code; got != http.StatusForbidden {
		t.Fatalf("an anonymous visitor opened a new name and got %d; the setting does nothing", got)
	}

	// The same request, from somebody with a session.
	account := store.Account{Name: "friend", Trip: "cccccddddd"}
	if err := st.AddAccount(account); err != nil {
		t.Fatal(err)
	}

	token := "a-session-token-for-this-test"
	now := time.Now().UTC()

	if err := st.KeepSession(token, store.Session{
		Trip: account.Trip, Name: account.Name, Kind: "account",
		Opened: now, Expires: now.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	signed := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
		strings.NewReader(`{"name":"friend"}`))
	signed.Header.Set("Content-Type", "application/json")
	signed.AddCookie(&http.Cookie{Name: "meet-live.account", Value: token})

	recorder := ask(mux, signed)
	if recorder.Code != http.StatusOK {
		t.Fatalf("somebody signed in was refused a new name with %d: %s; they are known to "+
			"this server by name and were turned away for leaving blank a field they had "+
			"already answered somewhere else", recorder.Code, recorder.Body)
	}
}

/*
An administrator signing in at the front of the site.

Administrators and accounts are kept in two lists because they answer two
questions — who may run this deployment, and who has been given a name here — and
for a while that meant the one group of people who certainly have credentials
were the one group who could not sign in. They typed the name and passphrase they
use for the management pages and were told the pair does not go together, which
is true of the accounts list and useless to the person reading it.

What must not follow from fixing it is authority leaking across. Being an
administrator is decided by the administrator list every time it is asked; a
session says who somebody is and never what they may do.
*/

func TestAnAdministratorCanSignInAtTheFrontOfTheSite(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"},
	)

	const passphrase = "the administrator's own passphrase"

	if err := st.AddAdmin(store.Admin{
		Trip: room.Trip(tripKey, passphrase), Name: "andy", Can: []string{"moderate"},
	}); err != nil {
		t.Fatal(err)
	}

	sign := func(name, secret string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/account/session",
			strings.NewReader(`{"name":"`+name+`","passphrase":"`+secret+`"}`))
		request.Header.Set("Content-Type", "application/json")

		return ask(mux, request)
	}

	recorder := sign("andy", passphrase)
	if recorder.Code != http.StatusOK {
		t.Fatalf("an administrator was refused their own name and passphrase with %d: %s",
			recorder.Code, recorder.Body)
	}

	// The session has to work afterwards, which is a different question: the
	// name in it is looked up again on every request, and looking it up in only
	// one of the two lists would sign them straight back out.
	cookie := recorder.Result().Cookies()
	if len(cookie) == 0 {
		t.Fatal("signing in left no session")
	}

	me := httptest.NewRequest(http.MethodGet, "/api/account/me", nil)
	me.AddCookie(cookie[0])

	if got := ask(mux, me).Code; got != http.StatusOK {
		t.Errorf("a session made a moment ago was not recognised: %d; the name is read back "+
			"from the accounts list alone, so an administrator is signed out by their "+
			"next request", got)
	}

	// And the wrong passphrase is still the wrong passphrase.
	if got := sign("andy", "not it").Code; got != http.StatusUnauthorized {
		t.Errorf("a wrong passphrase signed in as an administrator with %d", got)
	}
}

/*
Two relays that must not carry each other's calls.

Reachability between two machines is a fact about the networks between them and
nothing here can derive it: two relays can both be fast, both be in the same
country, both answer every probe, and still carry nothing usable between each
other. So the pairs that are no good are written down by whoever found out.

It is worth a test rather than a comment because it is invisible when wrong. The
call still connects; it just goes the long way through a path that does not work,
and the only symptom is somebody saying the meeting was bad — which reads as the
relay they picked being bad rather than as a pair that should never have formed.

The symmetry is the part that would rot. Written on one side of the comparison
only, the pair would forward or not depending on which end a client happened to
come in at, and every test of the remembered half would pass.
*/

func TestRelaysKeptApartDoNotCarryEachOthersCalls(t *testing.T) {
	// Only one of them says so, and it has to hold from both directions.
	hongKong := store.Relay{
		Name: "hong kong", URL: "wss://hk.example.invalid", Region: "Oversea/Asia",
		Turn: "hk.example.invalid:39219", Forwards: true, Apart: []string{"shanghai ct"},
	}
	shanghai := store.Relay{
		Name: "shanghai ct", URL: "wss://shct.example.invalid", Region: "CN-East",
		Turn: "shct.example.invalid:39219", Forwards: true,
	}

	for _, tc := range []struct{ first, second store.Relay }{
		{shanghai, hongKong},
		{hongKong, shanghai},
	} {
		mux := control(t, config.PickProbe, tc.first, tc.second)

		joinVia(t, mux, "standup", tc.first.Name)

		second := joinVia(t, mux, "standup", tc.second.Name)

		if second.Forward != nil {
			t.Errorf("a room held on %q was forwarded through %q, which is a pair somebody "+
				"wrote down as no good; the call goes the long way through a path that "+
				"does not work and looks like the relay was bad",
				tc.first.Name, tc.second.Name)
		}

		// And they are sent straight to the machine holding the room, which is
		// the behaviour forwarding replaced and is still correct here.
		if second.URL != tc.first.URL {
			t.Errorf("sent to %s rather than to the machine holding the room", second.URL)
		}
	}
}

func TestARelayKeptApartFromOneStillForwardsForTheRest(t *testing.T) {
	// The rule is about a pair and not about a machine. A relay excluded from one
	// other must go on forwarding for everybody else, or writing down a single
	// bad pair would quietly take it out of service.
	mux := control(t, config.PickProbe,
		store.Relay{
			Name: "hong kong", URL: "wss://hk.example.invalid", Region: "Oversea/Asia",
			Turn: "hk.example.invalid:39219", Forwards: true, Apart: []string{"shanghai ct"},
		},
		store.Relay{
			Name: "guangzhou", URL: "wss://gz.example.invalid", Region: "CN-South",
			Turn: "gz.example.invalid:39219", Forwards: true,
		},
	)

	joinVia(t, mux, "standup", "guangzhou")

	if joinVia(t, mux, "standup", "hong kong").Forward == nil {
		t.Fatal("a relay kept apart from one other stopped forwarding for everybody; one " +
			"bad pair took the machine out of service")
	}
}

/*
A machine that can carry a call the picked one cannot.

The fleet has machines on both sides of a border and nothing abroad can usefully
carry media to anything inside it. Without a way round that, choosing a server
abroad and joining a meeting held inside gets the behaviour forwarding replaced —
a direct connection across the border, which is the thing every relay here exists
to avoid. One machine can talk to both sides, so somebody who lands on a pair
that will not work is sent to that one instead.

Sent, rather than left where they were with their media routed elsewhere. That is
the part worth a test: the entry has to change, or the panel says one machine, the
packets go through another, and nothing anywhere reconciles them.

It is symmetrical, and that is not an accident of the code — it falls out of
asking whether the pair works rather than which side anybody is on. Somebody
inside joining a meeting held abroad hits exactly the same case, and a guard
written for one direction would leave the other going direct.

And a bridge is not a wildcard. It stands in only where it is itself usable: a
bridge kept apart from the room's own machine is no more use than the entry that
could not reach it, which is the case that decides whether "route everything
through the one that works" quietly becomes "route everything through the one
that does not".
*/

func overseasAndInland(t *testing.T, bridgeApart ...string) http.Handler {
	t.Helper()

	return control(t, config.PickProbe,
		store.Relay{
			Name: "singapore", URL: "wss://sg.example.invalid", Region: "Oversea/Asia",
			Turn: "sg.example.invalid:39219", Forwards: true,
			Apart: []string{"guangzhou", "shanghai ct"},
		},
		store.Relay{
			Name: "guangzhou", URL: "wss://gz.example.invalid", Region: "CN-South",
			Turn: "gz.example.invalid:39219", Forwards: true,
			Apart: []string{"singapore"},
		},
		store.Relay{
			Name: "hong kong", URL: "wss://hk.example.invalid", Region: "Oversea/Asia",
			Turn: "hk.example.invalid:39219", Forwards: true, Bridge: true,
			Apart: bridgeApart,
		},
	)
}

func TestSomebodyOnAPairThatWillNotWorkIsSentToTheOneThatDoes(t *testing.T) {
	for _, tc := range []struct{ opened, picked string }{
		// Abroad joining a meeting held inside, and the reverse. The same case
		// from either end, which is the point: the question is whether the pair
		// works, not which side anybody is on.
		{"guangzhou", "singapore"},
		{"singapore", "guangzhou"},
	} {
		mux := overseasAndInland(t)

		joinVia(t, mux, "standup", tc.opened)

		second := joinVia(t, mux, "standup", tc.picked)

		if second.URL != "wss://hk.example.invalid" {
			t.Errorf("somebody who picked %q for a room on %q was sent to %s; the pair does "+
				"not carry media, so this is a direct connection across the border — "+
				"the thing every relay here exists to avoid",
				tc.picked, tc.opened, second.URL)
		}

		if second.Forward == nil || !strings.Contains(second.Forward.URL, "hk.example.invalid") {
			t.Errorf("picked %q for a room on %q and was given %v to send media through",
				tc.picked, tc.opened, second.Forward)
		}
	}
}

func TestABridgeThatCannotReachTheRoomIsNotUsed(t *testing.T) {
	// The bridge is kept apart from the machine holding the meeting, which is
	// the real arrangement here: one domestic relay cannot reach the bridge at
	// all. Standing in would route the call through a machine that cannot
	// deliver it, which is worse than the direct connection it replaced.
	mux := overseasAndInland(t, "guangzhou")

	joinVia(t, mux, "standup", "guangzhou")

	second := joinVia(t, mux, "standup", "singapore")

	if second.URL == "wss://hk.example.invalid" {
		t.Fatal("a bridge that cannot reach the room was used anyway; the call is routed " +
			"through a machine with no path to the meeting")
	}

	if second.Forward != nil {
		t.Error("media was forwarded over a pair that does not carry it")
	}

	if second.URL != "wss://gz.example.invalid" {
		t.Errorf("sent to %s rather than directly to the room, which is the only thing "+
			"left that can work", second.URL)
	}
}

func TestABridgeReservedForAdministratorsStaysReserved(t *testing.T) {
	mux := control(t, config.PickProbe,
		store.Relay{
			Name: "singapore", URL: "wss://sg.example.invalid", Region: "Oversea/Asia",
			Turn: "sg.example.invalid:39219", Forwards: true, Apart: []string{"guangzhou"},
		},
		store.Relay{
			Name: "guangzhou", URL: "wss://gz.example.invalid", Region: "CN-South",
			Turn: "gz.example.invalid:39219", Forwards: true, Apart: []string{"singapore"},
		},
		store.Relay{
			Name: "private", URL: "wss://priv.example.invalid", Region: "Oversea/Asia",
			Turn: "priv.example.invalid:39219", Forwards: true, Bridge: true, AdminOnly: true,
		},
	)

	joinVia(t, mux, "standup", "guangzhou")

	// A machine reserved for administrators does not stop being reserved by
	// being useful, and being handed one is how somebody discovers a relay they
	// were never meant to know about.
	if got := joinVia(t, mux, "standup", "singapore").URL; got == "wss://priv.example.invalid" {
		t.Error("a visitor was bridged through a relay reserved for administrators")
	}
}

/*
A name reused after the meeting under it has ended.

The note saying where a room is being held exists so the second person into a
live meeting lands where the meeting is. Believed on its own it does the opposite
of its job the moment the meeting ends: somebody closes a call, opens another
under the same name a minute later, and is sent to the machine the old one was
on — whatever they picked, and with nothing anywhere saying why. It reads as the
server choice being ignored, because it is.

It aged out after two hours, which is a long time to be told your choice does not
matter, and no time at all if the room is still running. So the clock is the
backstop and the media server is the answer: the note is honoured while there is
a meeting to honour it for.
*/

func TestANameReusedAfterAMeetingEndsIsPickedAfresh(t *testing.T) {
	mux, st, self := controlWithStore(t, config.PickProbe,
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	// A media server that answers, and says there is no meeting under any name.
	// Without one the join cannot tell "ended" from "cannot ask", and believes
	// the note — which is the right thing to do when nothing can be reached and
	// the wrong thing to test with.
	self.control = quiet{}

	joinVia(t, mux, "standup", "guangzhou")

	// The note is still there — this is not the expiry being tested — and there
	// is no media server behind these tests, so nothing can confirm a meeting is
	// running under that name.
	if got, _ := st.HeldOn("standup"); got != "guangzhou" {
		t.Fatalf("the room was noted on %q, wanted guangzhou", got)
	}

	second := joinVia(t, mux, "standup", "shanghai")

	if second.URL != "wss://sh.example.invalid" {
		t.Errorf("somebody picked shanghai for a name whose meeting had ended and was sent "+
			"to %s; the note outlived the meeting and the choice counted for nothing",
			second.URL)
	}

	if second.Forward != nil {
		t.Error("media was forwarded to a machine holding nothing")
	}

	// And the note is gone, so the next join does not ask the same question.
	if got, _ := st.HeldOn("standup"); got == "guangzhou" {
		t.Error("a note about a meeting that has ended was left in place; every join for " +
			"the next two hours asks the media server the same question and gets the " +
			"same answer")
	}
}

// quiet is a media server holding no rooms at all.
//
// Its whole job is to answer, so that a test can tell the difference between a
// meeting that has ended and a media server that could not be asked — which the
// join treats as opposite cases and which look identical without one.
type quiet struct{}

func (quiet) Rooms(context.Context) ([]*livekit.Room, error) { return nil, nil }

func (quiet) Participants(context.Context, string) ([]*livekit.ParticipantInfo, error) {
	return nil, nil
}

func (quiet) Remove(context.Context, string, string) error       { return nil }
func (quiet) Mute(context.Context, string, string, string) error { return nil }
func (quiet) Close(context.Context, string) error                { return nil }

/*
An operator moving one person to a different way in.

Where somebody enters is theirs — their browser measures the relays and picks —
and that is right until it is not: a path that is bad in a way nothing here can
measure, on the one call they are in now. So an operator can say which door, and
the join takes that over what the browser sent.

Once, and this is the part worth pinning down. It is about the call somebody is
being moved out of. Left in place it would silently overrule every choice they
made afterwards, in every meeting, from a page they cannot see — and the symptom
would be a picker that appears to do nothing, months later, for one person.
*/

func TestAPinnedEntryOverridesTheBrowserAndThenGoesAway(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	// Joined once, so there is an identity to pin against and a record to hold
	// it — which is how an operator reaches somebody: by name in a room.
	first := joinVia(t, mux, "standup", "shanghai")

	var identity struct {
		Identity string `json:"identity"`
	}

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
		strings.NewReader(`{"name":"somebody","relay":"shanghai"}`))
	request.Header.Set("Content-Type", "application/json")

	if err := json.Unmarshal(ask(mux, request).Body.Bytes(), &identity); err != nil {
		t.Fatal(err)
	}

	if first.URL != "wss://sh.example.invalid" {
		t.Fatalf("the first join went to %s, wanted shanghai", first.URL)
	}

	if err := st.PinEntry("standup", identity.Identity, "guangzhou"); err != nil {
		t.Fatal(err)
	}

	// The same person asking for the same relay their browser measured.
	again := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
		strings.NewReader(`{"name":"somebody","identity":"`+identity.Identity+`","relay":"shanghai"}`))
	again.Header.Set("Content-Type", "application/json")

	var moved struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(ask(mux, again).Body.Bytes(), &moved); err != nil {
		t.Fatal(err)
	}

	if moved.URL != "wss://gz.example.invalid" {
		t.Errorf("came back to %s despite being moved to guangzhou; an operator moving "+
			"somebody out of a bad path did nothing at all", moved.URL)
	}

	// And once. The next join is theirs again.
	back := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
		strings.NewReader(`{"name":"somebody","identity":"`+identity.Identity+`","relay":"shanghai"}`))
	back.Header.Set("Content-Type", "application/json")

	var third struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(ask(mux, back).Body.Bytes(), &third); err != nil {
		t.Fatal(err)
	}

	if third.URL != "wss://sh.example.invalid" {
		t.Errorf("came back to %s a second time; the pin outlived the call it was for, "+
			"and now overrules every choice this person makes with nothing on screen "+
			"to say why", third.URL)
	}
}

func (quiet) Announce(context.Context, string, string, []byte) error { return nil }

func (quiet) Tell(context.Context, string, string, string, []byte) error { return nil }

func (quiet) Hold(context.Context, string, string) error { return nil }

// The region a join answers with is the entry's, not the holder's.
//
// It is what a client reads to decide whether its viewer is in mainland China,
// where YouTube cannot be reached and a video goes straight to the relayed copy.
// The holder is the wrong machine to ask: somebody in Shanghai joining a meeting
// held in Guangzhou came in through Shanghai, and somebody abroad joining a
// meeting held in the mainland did not come in through the mainland at all —
// whether or not their relay forwards; see the test after this one.
func TestAJoinSaysTheRegionOfTheRelayItCameInThrough(t *testing.T) {
	south := forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219")
	south.Region = "CN-South"

	mux := control(t, config.PickProbe,
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		south,
	)

	region := func(relay string) (string, bool) {
		request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
			strings.NewReader(`{"name":"somebody","relay":"`+relay+`"}`))
		request.Header.Set("Content-Type", "application/json")

		var answer struct {
			Region  string          `json:"region"`
			Forward json.RawMessage `json:"forward"`
		}
		if err := json.Unmarshal(ask(mux, request).Body.Bytes(), &answer); err != nil {
			t.Fatal(err)
		}

		return answer.Region, len(answer.Forward) > 0
	}

	if got, _ := region("guangzhou"); got != "CN-South" {
		t.Errorf("the first join, through guangzhou, said region %q", got)
	}

	got, forwarded := region("shanghai")
	if !forwarded {
		t.Fatal("the second join was not forwarded, so it cannot tell the entry from the holder")
	}

	if got != "CN-East" {
		t.Errorf("a join through shanghai into a meeting held in guangzhou said region %q, "+
			"want the entry's CN-East", got)
	}
}

// And it is the relay the person chose, not the one the join sent them to.
//
// The test above has the entry forward, so the entry and the relay chosen are
// the same machine and it cannot tell them apart. Where the chosen relay does
// not forward, the join sends the person to the holder instead — and the region
// used to be read off the entry after that, so somebody abroad whose relay does
// not forward, joining a meeting held in Shanghai, was told CN-East and had every
// YouTube video relayed by this deployment for nothing (found in review,
// 2026-10-14). And where nobody chose — no relay named, or one that is not ours —
// the relay is a hash of the room's name, which says nothing about the person
// and on this fleet is usually in the mainland; that says nothing either.
func TestAJoinSaysTheRegionOfTheRelayTheyChoseNotTheOneTheyWereSentTo(t *testing.T) {
	shanghai := forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219")
	tokyo := forwarder("tokyo", "wss://tk.example.invalid", "tk.example.invalid:39219")
	tokyo.Region = "JP"
	tokyo.Forwards = false

	mux := control(t, config.PickProbe, shanghai, tokyo)

	join := func(relay string) (region, sentTo string) {
		request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
			strings.NewReader(`{"name":"somebody","relay":"`+relay+`"}`))
		request.Header.Set("Content-Type", "application/json")

		var answer struct {
			Region string `json:"region"`
			URL    string `json:"url"`
		}
		if err := json.Unmarshal(ask(mux, request).Body.Bytes(), &answer); err != nil {
			t.Fatal(err)
		}
		return answer.Region, answer.URL
	}

	if got, _ := join("shanghai"); got != "CN-East" {
		t.Fatalf("the first join, through shanghai, said region %q", got)
	}

	got, sentTo := join("tokyo")
	if !strings.Contains(sentTo, "sh.example.invalid") {
		t.Fatalf("a join through tokyo, which does not forward, was sent to %q rather than to the holder; "+
			"the fixture no longer exercises the fault", sentTo)
	}
	if got != "JP" {
		t.Errorf("somebody who chose tokyo and was sent to shanghai was told region %q; "+
			"want the region of the relay they chose, JP", got)
	}

	for _, unchosen := range []string{"", "nowhere"} {
		if got, _ := join(unchosen); got != "" {
			t.Errorf("a join naming relay %q, which is no choice of ours, was told region %q; "+
				"a hash of the room's name says nothing about where somebody is", unchosen, got)
		}
	}
}
