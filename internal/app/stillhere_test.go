package app

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/room"
)

/*
A host who opened a room with a passphrase, and has no session anywhere, runs
it for the whole meeting.

The join token is the only thing that says who they are, and it lives five
minutes. Past that, it used to be refused at every host endpoint, so the panel
went dead a few minutes into every meeting for exactly the people with no other
way in. It is now accepted past its expiry while the identity it names is in
the room, as the media servers report it, and for no more than a day after it
was minted. Held apart here: the host still in the call is let in; the same
token presented by somebody whose identity is not in the room, or after the
day, is refused; and a room service that cannot be asked counts as no.
*/

// stillHere is a media server that reports who is in each room, and does
// whatever a host asks.
type stillHere struct {
	admin.Control

	mu     sync.Mutex
	in     map[string][]string
	asked  int
	broken bool
}

func (s *stillHere) Participants(_ context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.asked++
	if s.broken {
		return nil, errors.New("no relay answered")
	}

	var out []*livekit.ParticipantInfo
	for _, identity := range s.in[room] {
		out = append(out, &livekit.ParticipantInfo{Identity: identity})
	}

	return out, nil
}

func (s *stillHere) Close(context.Context, string) error                        { return nil }
func (s *stillHere) Remove(context.Context, string, string) error               { return nil }
func (s *stillHere) Announce(context.Context, string, string, []byte) error     { return nil }
func (s *stillHere) Tell(context.Context, string, string, string, []byte) error { return nil }

func TestAPassphraseHostRunsTheRoomPastTheTokensFiveMinutes(t *testing.T) {
	mux, st, app := controlWithStore(t, "")

	token, identity := tokenFor(t, "standup", "the host's own passphrase")
	mark, _ := room.SignatureOf(identity)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}
	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	media := &stillHere{in: map[string][]string{"standup": {identity}}}
	app.control = media

	// tokenFor mints for an hour; two hours on, it is long expired and well
	// inside the day.
	later := time.Now().Add(2 * time.Hour)
	app.clock = func() time.Time { return later }

	for _, call := range []struct{ method, path string }{
		{http.MethodPost, "/api/rooms/standup/invites"},
		{http.MethodDelete, "/api/rooms/standup/people/" + room.MintIdentity("")},
		{http.MethodPost, "/api/rooms/standup/close"},
	} {
		if code := ask(mux, asking(call.method, call.path, token, "")).Code; code == http.StatusForbidden || code == http.StatusUnauthorized {
			t.Errorf("%s %s with the host's expired token, the host still in the room, answered %d",
				call.method, call.path, code)
		}
	}

	// The same token, its owner gone from the room: a copy of it is worth
	// nothing.
	media.mu.Lock()
	media.in["standup"] = nil
	media.mu.Unlock()
	app.clock = func() time.Time { return later.Add(time.Minute) }

	if code := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, "")).Code; code != http.StatusForbidden {
		t.Errorf("an expired token whose identity is not in the room answered %d, want 403", code)
	}

	// Back in the room, and past the day: refused however present.
	media.mu.Lock()
	media.in["standup"] = []string{identity}
	media.mu.Unlock()
	app.clock = func() time.Time { return time.Now().Add(25 * time.Hour) }

	if code := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, "")).Code; code != http.StatusForbidden {
		t.Errorf("a token minted more than a day ago answered %d, want 403", code)
	}

	// And a media server that cannot be asked is a no, not a yes.
	media.mu.Lock()
	media.broken = true
	media.mu.Unlock()
	app.clock = func() time.Time { return later.Add(time.Hour) }

	if code := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, "")).Code; code != http.StatusForbidden {
		t.Errorf("with the room service unreachable, an expired token answered %d, want 403", code)
	}
}

// A live token is still taken without asking anybody, and the answer about
// who is in a room is reused for a few seconds rather than asked per press.
func TestTheRoomIsAskedOnlyForAnExpiredTokenAndNotOnEveryPress(t *testing.T) {
	mux, st, app := controlWithStore(t, "")

	token, identity := tokenFor(t, "standup", "the host's own passphrase")
	mark, _ := room.SignatureOf(identity)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}
	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	media := &stillHere{in: map[string][]string{"standup": {identity}}}
	app.control = media

	ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, ""))
	if media.asked != 0 {
		t.Errorf("a live token made %d calls to the room service", media.asked)
	}

	later := time.Now().Add(2 * time.Hour)
	app.clock = func() time.Time { return later }

	for range 5 {
		ask(mux, asking(http.MethodGet, "/api/rooms/standup/host", token, ""))
	}
	if media.asked != 1 {
		t.Errorf("five presses with an expired token asked the room service %d times, want once", media.asked)
	}
}
