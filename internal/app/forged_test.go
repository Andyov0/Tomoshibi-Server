package app

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
A token a relay wrote is not a token this node minted.

Every relay holds the key pair join tokens are signed with, because every relay
verifies the tokens clients bring it. So one relay broken into can sign a token
for anybody, and the host endpoints here — close, remove, mute, move, mint a
standing invitation into a scoped room — believed any token that verified. An
administrator's signature is printed beside their name in every call, and the
host's is inside the identity everybody in the room can read, so the forgery
needed nothing but the key pair.

Two rules hold it now, and each is tested apart from the other. A token must
carry this node's proof, which is keyed from the tripcode key no relay holds.
And being an administrator is something a session says, never a token, so even
a token this node minted for somebody who typed an administrator's passphrase
into the join field is a participant's token and nothing more.
*/

const fleetKey, fleetSecret = "APIkey", "a secret long enough for the media server to accept it"

// forged is what a relay holding the key pair could write: any identity, any
// room, as long as it likes.
func forged(t *testing.T, name, identity string) string {
	t.Helper()

	token, err := auth.NewAccessToken(fleetKey, fleetSecret).
		SetIdentity(identity).
		SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).
		SetValidFor(time.Hour).
		ToJWT()
	if err != nil {
		t.Fatal(err)
	}

	return token
}

func TestATokenARelayWroteDoesNotRunTheRoom(t *testing.T) {
	mux, st := hosted(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	token, identity := tokenFor(t, "standup", "the host's passphrase")
	mark, _ := room.SignatureOf(identity)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	// The same identity, signed with the same key pair, by somebody who is not
	// this node.
	if got := ask(mux, asking(http.MethodPost, "/api/rooms/standup/close", forged(t, "standup", identity), "")).Code; got != http.StatusForbidden {
		t.Errorf("a token a relay wrote, wearing the host's identity, closing the room answered %d, want 403", got)
	}

	if got := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", forged(t, "standup", identity), "")).Code; got != http.StatusForbidden {
		t.Errorf("a token a relay wrote minted an invitation: %d", got)
	}

	// And the host's own token still does: without this the test passes on a
	// server that refuses everybody.
	if got := ask(mux, asking(http.MethodPost, "/api/rooms/standup/close", token, "")).Code; got == http.StatusForbidden {
		t.Errorf("the host's own token was refused")
	}
}

func TestAnAdministratorsSignatureInATokenIsNotASession(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid", Region: "CN-East"},
	)

	const passphrase = "the administrator's own passphrase"
	trip := room.Trip(tripKey, passphrase)

	if err := st.AddAdmin(store.Admin{Trip: trip, Name: "andy", Can: []string{config.Moderate}}); err != nil {
		t.Fatal(err)
	}

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	_, theirs := tokenFor(t, "standup", "somebody else's passphrase")
	host, _ := room.SignatureOf(theirs)

	if err := st.SetHost("standup", host.Trip); err != nil {
		t.Fatal(err)
	}

	// A token this node minted, for somebody who typed the administrator's
	// passphrase into the join field — and the forgery of one, which is what a
	// relay would write.
	minted, identity := tokenFor(t, "standup", passphrase)

	for name, token := range map[string]string{
		"minted here": minted,
		"forged":      forged(t, "standup", identity),
	} {
		if got := ask(mux, asking(http.MethodPost, "/api/rooms/standup/close", token, "")).Code; got != http.StatusForbidden {
			t.Errorf("an administrator's signature in a token (%s) closed somebody else's room: %d", name, got)
		}

		if got := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, "")).Code; got != http.StatusForbidden {
			t.Errorf("an administrator's signature in a token (%s) minted an invitation: %d", name, got)
		}
	}

	var standing struct {
		Admin bool `json:"admin"`
	}
	_ = json.Unmarshal(ask(mux, asking(http.MethodGet, "/api/rooms/standup/host", minted, "")).Body.Bytes(), &standing)

	if standing.Admin {
		t.Error("the room told a token-only administrator they administer it")
	}

	// The session is what says so.
	now := time.Now().UTC()
	if err := st.KeepSession("andy-session", store.Session{
		Trip: trip, Name: "andy", Kind: "account", Opened: now, Expires: now.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	signed := asking(http.MethodPost, "/api/rooms/standup/invites", minted, "")
	signed.AddCookie(&http.Cookie{Name: "meet-live.account", Value: "andy-session"})

	if got := ask(mux, signed).Code; got != http.StatusOK {
		t.Errorf("an administrator with a session was refused the room: %d", got)
	}
}
