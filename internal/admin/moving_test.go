package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"errors"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

/*
 * Moving somebody to another machine, and what they are told about it.
 *
 * There is no message in the protocol that asks a browser to move: it holds a
 * connection to the machine it dialled, and the only way somebody comes in
 * through a different door is by coming in again. So a person is moved by being
 * let go of — which is the same thing a host does to throw somebody out, and
 * produces the same disconnection code.
 *
 * Before this they were told nothing else, so an operator putting one person on
 * a healthier relay sent them a notice saying they had been removed from the
 * meeting, and a call that did not come back.
 *
 * The warning has to be addressed to them rather than said to the room, and
 * that is what this file is mostly about. A message on this topic arms a tab to
 * rejoin after the next disconnection; broadcast, it arms every tab in the
 * room, and the next time a host legitimately ended the meeting all of them
 * would quietly rebuild it. That fault has happened once here already, from the
 * other direction, and it is the reason Tell exists at all.
 */

// listening records what was said and to whom.
type listening struct {
	absent

	mu        sync.Mutex
	announced []string
	told      []string
	// In order, because the order is the whole of what makes a move move.
	did []string
	// When the warning went and when the call ended, for the time between.
	warnedAt, endedAt time.Time
}

func (l *listening) Hold(_ context.Context, room, node string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.did = append(l.did, "hold "+room+" on "+node)

	return nil
}

func (l *listening) Announce(_ context.Context, room, topic string, data []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.announced = append(l.announced, room+"/"+topic+"/"+string(data))
	l.warnedAt = time.Now()

	return nil
}

func (l *listening) Tell(_ context.Context, room, identity, topic string, data []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.told = append(l.told, room+"/"+identity+"/"+topic+"/"+string(data))
	l.warnedAt = time.Now()

	return nil
}

// Letting go of somebody, and closing a room, both work here. absent refuses
// them, which is right for the tests it was written for and wrong for these:
// what is under test is what is said on the way to the disconnection, and a
// disconnection that never happens says nothing.
func (l *listening) Remove(context.Context, string, string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.endedAt = time.Now()

	return nil
}

func (l *listening) Close(_ context.Context, room string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.did = append(l.did, "close "+room)
	l.endedAt = time.Now()

	return nil
}

func (l *listening) order() []string {
	l.mu.Lock()
	defer l.mu.Unlock()

	return append([]string(nil), l.did...)
}

func (l *listening) said() ([]string, []string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	return append([]string(nil), l.announced...), append([]string(nil), l.told...)
}

// A store that takes what it is given, so these tests are about what is said
// rather than about what is written down.
type placed struct{}

func (placed) HoldRoom(string, string) error         { return nil }
func (placed) HeldOn(string) (string, bool)          { return "", false }
func (placed) PlaceRoom(string, string) error        { return nil }
func (placed) ReleaseRoom(string) error              { return nil }
func (placed) PinEntry(string, string, string) error { return nil }

// A fleet that answers which node each relay is, which is what a move has to
// ask before it can put a room anywhere.
type nodes struct{}

func (nodes) Relays() []string { return []string{"wss://jp.example"} }

func (nodes) AskStats(_ context.Context, relay string) (rtc.Stats, error) {
	if relay == "wss://jp.example" {
		return rtc.Stats{Node: "ND_tokyo"}, nil
	}

	return rtc.Stats{}, errors.New("no such relay")
}

func moving(t *testing.T) (*listening, http.Handler, string) {
	t.Helper()

	admin := config.Admin{
		Trip: room.Trip(key, "moderator"), Name: "adam",
		Can: []string{config.Observe, config.Moderate},
	}
	heard := &listening{}

	api := &API{
		conf:     &config.Config{Meet: config.Meet{Admins: []config.Admin{admin}}, LiveKit: livekitDefaults()},
		sessions: NewSessions(func() []config.Admin { return []config.Admin{admin} }, key),
		media:    absent{},
		control:  heard,
		log:      NewLog(),
		store:    unwritten{},
		relays: &listed{relays: []store.Relay{
			{Name: "tokyo", URL: "wss://jp.example", Node: "ND_tokyo"},
		}},
		placing: placed{},
		fleet:   nodes{},
		history: NewHistory(nil),
		stop:    make(chan struct{}),
		heed:    testHeed,
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	_, token, _ := api.sessions.Open("", "moderator")

	return heard, mux, cookieName + "=" + token
}

func place(t *testing.T, mux http.Handler, cookie, path, body string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", cookie)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder
}

func TestMovingOnePersonWarnsThatPersonAndNobodyElse(t *testing.T) {
	heard, mux, cookie := moving(t)

	recorder := place(t, mux,
		cookie, "/api/admin/rooms/standup/participants/t9abc/relay", `{"relay":"tokyo"}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("placing somebody answered %d: %s", recorder.Code, recorder.Body.String())
	}

	announced, told := heard.said()

	// The whole point. Said to the room, this arms every tab in it.
	if len(announced) != 0 {
		t.Errorf("moving one person was announced to the room: %v", announced)
	}

	if len(told) != 1 {
		t.Fatalf("the person moved was told %d times, want once: %v", len(told), told)
	}

	if want := "standup/t9abc/placing/tokyo"; told[0] != want {
		t.Errorf("told %q, want %q", told[0], want)
	}
}

// And the other direction, which is a whole room and is a broadcast on purpose:
// everybody in it is going to the same machine.
func TestMovingARoomTellsEverybodyInIt(t *testing.T) {
	heard, mux, cookie := moving(t)

	// "now", because without it the room is written down as belonging to that
	// machine and goes there at the next call rather than this one — and a move
	// nobody is being disconnected for is a move nobody needs warning about.
	recorder := place(t, mux, cookie, "/api/admin/rooms/standup/relay", `{"relay":"tokyo","now":true}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("moving a room answered %d: %s", recorder.Code, recorder.Body.String())
	}

	announced, told := heard.said()

	if len(told) != 0 {
		t.Errorf("moving a room was addressed to somebody: %v", told)
	}

	if len(announced) != 1 || announced[0] != "standup/moving/tokyo" {
		t.Errorf("announced %v, want one standup/moving/tokyo", announced)
	}
}

// A relay this deployment does not have is refused before anybody is disturbed.
func TestMovingSomebodyToANonexistentRelayTellsNobody(t *testing.T) {
	heard, mux, cookie := moving(t)

	recorder := place(t, mux,
		cookie, "/api/admin/rooms/standup/participants/t9abc/relay", `{"relay":"atlantis"}`)

	if recorder.Code == http.StatusOK {
		t.Fatalf("an unknown relay was accepted")
	}

	var refusal struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &refusal)

	announced, told := heard.said()
	if len(announced) != 0 || len(told) != 0 {
		t.Errorf("a refused move still said something: %v %v", announced, told)
	}
}

/*
 * A move that moves the room, rather than closing it and hoping.
 *
 * Rooms here are never created deliberately: the first person to connect makes
 * one, on whichever node the media server picks for the machine they dialled.
 * So closing a room and letting everybody reconnect creates it again wherever
 * whoever got back first happened to be — and the record said the machine the
 * operator chose, while the meeting was somewhere else entirely.
 *
 * That is a control which reports success and does nothing, and it is what
 * "moving the room in the panel does not work" was.
 *
 * The order settles it, and this test exists because the first order tried was
 * the wrong one. Putting the room up on the target *before* closing looks right
 * and is not: closing is by name and reaches every node, so it takes down the
 * room that was just put up, and the move falls straight back into the race.
 * That version shipped and reproduced the original fault exactly.
 *
 * Close, then create the empty room pinned to the chosen node. Everybody who
 * reconnects finds a room that is already there, and a room that already exists
 * is not created a second time somewhere else.
 */
func TestAMoveHoldsTheRoomAfterClosingIt(t *testing.T) {
	heard, mux, cookie := moving(t)

	recorder := place(t, mux, cookie, "/api/admin/rooms/standup/relay", `{"relay":"tokyo","now":true}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("moving a room answered %d: %s", recorder.Code, recorder.Body.String())
	}

	did := heard.order()

	if len(did) != 2 {
		t.Fatalf("a move did %v, want a close and a hold", did)
	}

	if did[0] != "close standup" {
		t.Errorf("the first thing a move did was %q, want the old room closed", did[0])
	}

	// The one that matters. Held first, this reads "hold standup on ND_tokyo"
	// as well — and the room still ends up wherever the race sends it, because
	// the close in between destroyed it. Only the order tells the two apart.
	if did[1] != "hold standup on ND_tokyo" {
		t.Errorf("the second thing a move did was %q, want the room held on the new node", did[1])
	}
}

// A move that is not immediate does not disturb anybody, so there is nothing to
// put up first: the room goes to the new machine at the next call.
func TestAMoveForLaterHoldsNothing(t *testing.T) {
	heard, mux, cookie := moving(t)

	place(t, mux, cookie, "/api/admin/rooms/standup/relay", `{"relay":"tokyo"}`)

	if did := heard.order(); len(did) != 0 {
		t.Errorf("a move for later did %v, want nothing", did)
	}
}

/*
 * A move that could not put the room anywhere says so, and says it as a failure.
 *
 * The node identifier is assigned when a media server starts, so it changes on
 * every restart and nothing written down survives an upgrade. The first version
 * of this read it from the relay's record — where it is never written — so the
 * hold silently did not happen, the move fell back to the race it was meant to
 * settle, and the only evidence was a meeting in the wrong place. Moved to
 * Shanghai, landed on Hong Kong.
 *
 * It answered 200 for a while after that, on the argument that the placement was
 * written and the room would go to the right machine at the next join. True, and
 * not what was asked for: what was asked for was the room put up there, and
 * without it whoever reconnects first decides which node holds the media. A
 * control that reports a coin toss as success is how the first fault stayed
 * hidden for a week.
 *
 * So it refuses, and the placement stands, and pressing it again once the relay
 * is answering does the rest.
 */
func TestAMoveThatCannotHoldTheRoomRefuses(t *testing.T) {
	admin := config.Admin{
		Trip: room.Trip(key, "moderator"), Name: "adam",
		Can: []string{config.Observe, config.Moderate},
	}
	heard := &listening{}
	audit, written := auditing()

	api := &API{
		conf:     &config.Config{Meet: config.Meet{Admins: []config.Admin{admin}}, LiveKit: livekitDefaults()},
		sessions: NewSessions(func() []config.Admin { return []config.Admin{admin} }, key),
		media:    absent{},
		control:  heard,
		log:      audit,
		store:    unwritten{},
		relays: &listed{relays: []store.Relay{
			{Name: "tokyo", URL: "wss://jp.example"},
		}},
		placing: placed{},
		// No fleet, which is a control node that cannot ask the relays anything.
		history: NewHistory(nil),
		stop:    make(chan struct{}),
		heed:    testHeed,
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	_, token, _ := api.sessions.Open("", "moderator")

	recorder := place(t, mux, cookieName+"="+token,
		"/api/admin/rooms/standup/relay", `{"relay":"tokyo","now":true}`)

	if recorder.Code != http.StatusBadGateway {
		t.Errorf("a move that could not hold the room answered %d, want 502", recorder.Code)
	}

	var said bool
	for _, entry := range written.recorded() {
		if entry.Action == "hold room" && entry.Failed {
			said = true
		}
	}

	if !said {
		t.Error("a move put the room nowhere and wrote nothing down, which is the failure " +
			"that took an afternoon to find the first time")
	}
}

// drop sends a DELETE, which place cannot: the method is the difference between
// closing a room and forgetting one, and a helper that quietly used the wrong
// one would test the wrong endpoint.
func drop(t *testing.T, mux http.Handler, cookie, path string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(http.MethodDelete, path, nil)
	request.Header.Set("Cookie", cookie)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder
}

// Shorter than a real deployment's, so the tests do not wait on it, and long
// enough to tell from no wait at all.
const testHeed = 40 * time.Millisecond

/*
 * The warning is given time to arrive before the call it warns about ends.
 *
 * They were two calls one after the other, and on a phone the disconnection
 * sometimes got there first: the person placed on another relay was shown the
 * join page saying they had been removed, twice in nine tries. Measured as the
 * time between the warning and the ending, through the router.
 */
func TestAWarningIsGivenTimeToArriveBeforeTheCallEnds(t *testing.T) {
	for _, c := range []struct{ what, path, body string }{
		{"one person", "/api/admin/rooms/standup/participants/t9abc/relay", `{"relay":"tokyo"}`},
		{"a room", "/api/admin/rooms/standup/relay", `{"relay":"tokyo","now":true}`},
	} {
		heard, mux, cookie := moving(t)

		if recorder := place(t, mux, cookie, c.path, c.body); recorder.Code != http.StatusOK {
			t.Fatalf("%s: moving answered %d: %s", c.what, recorder.Code, recorder.Body.String())
		}

		heard.mu.Lock()
		gap := heard.endedAt.Sub(heard.warnedAt)
		warned := !heard.warnedAt.IsZero()
		heard.mu.Unlock()

		if !warned || gap < testHeed {
			t.Errorf("%s: the call ended %v after the warning, want at least %v", c.what, gap, testHeed)
		}
	}
}
