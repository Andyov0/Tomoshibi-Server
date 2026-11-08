package room

import (
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
)

const (
	key    = "APItest"
	secret = "a-secret-long-enough-to-sign-with"
)

func TestValidName(t *testing.T) {
	for _, name := range []string{"demo", "weekly-standup", "room-2", "a"} {
		if !ValidName(name) {
			t.Errorf("ValidName(%q) = false, want true", name)
		}
	}

	// Rejected for reasons worth stating: uppercase and spaces because the name
	// is normalised before it gets here, edge dashes because they read as
	// truncation, and length because a name is meant to be repeatable aloud.
	for _, name := range []string{"", "Demo", "with space", "-lead", "trail-", "under_score",
		strings.Repeat("a", MaxName+1)} {
		if ValidName(name) {
			t.Errorf("ValidName(%q) = true, want false", name)
		}
	}
}

// A scope is a second plain name after one `@`, and nothing looser. The cases
// refused are the ones that would make a name split two ways or carry a half
// that a plain name could not be.
func TestScopedNames(t *testing.T) {
	for _, name := range []string{"standup@acme", "a@b", "weekly-standup@acme-cn",
		strings.Repeat("a", MaxName) + "@" + strings.Repeat("b", MaxScope)} {
		if !ValidName(name) {
			t.Errorf("ValidName(%q) = false, want true", name)
		}
	}

	for _, name := range []string{"@acme", "standup@", "standup@acme@else", "standup@Acme",
		"standup@-acme", "standup@acme-", "stand up@acme", "standup@ac_me",
		strings.Repeat("a", MaxName+1) + "@acme",
		"standup@" + strings.Repeat("b", MaxScope+1)} {
		if ValidName(name) {
			t.Errorf("ValidName(%q) = true, want false", name)
		}
	}

	for _, scope := range []string{"", "a@b", "-acme", strings.Repeat("b", MaxScope+1)} {
		if ValidScope(scope) {
			t.Errorf("ValidScope(%q) = true, want false", scope)
		}
	}

	if local, scope := Split("standup@acme"); local != "standup" || scope != "acme" {
		t.Errorf("Split(standup@acme) = %q, %q", local, scope)
	}

	if local, scope := Split("standup"); local != "standup" || scope != "" {
		t.Errorf("Split(standup) = %q, %q; a plain name has no scope", local, scope)
	}
}

func TestMintedIdentityIsValid(t *testing.T) {
	minted := MintIdentity("")

	if !ValidIdentity(minted) {
		t.Fatalf("ValidIdentity(%q) = false for a minted identity", minted)
	}

	if minted == MintIdentity("") {
		t.Fatal("two minted identities are the same")
	}
}

func TestIdentityWeDidNotMintIsRejected(t *testing.T) {
	for _, identity := range []string{
		"", "alice", "g-short",
		"g" + strings.Repeat("z", 10) + "-" + strings.Repeat("Z", 32),
		"x" + strings.Repeat("z", 10) + "-" + strings.Repeat("a", 32),
	} {
		if ValidIdentity(identity) {
			t.Errorf("ValidIdentity(%q) = true, want false", identity)
		}
	}
}

// An identity a caller invented is replaced rather than refused, so they get a
// working session instead of an error they cannot act on, and cannot choose what
// they are known as.
func TestInventedIdentityIsReplaced(t *testing.T) {
	grant, err := Authorise(key, secret, Request{
		Room: "demo", Identity: "alice", Display: "Alice", TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if grant.Identity == "alice" {
		t.Fatal("a caller chose their own identity")
	}
	if !ValidIdentity(grant.Identity) {
		t.Fatalf("replacement identity %q is not one we would mint", grant.Identity)
	}
}

// An issued identity is kept for the tab it was issued to, which proves that by
// sending back what came with it.
func TestIdentityWeMintedIsKept(t *testing.T) {
	tripKey := []byte("a tripcode key for this test only")

	first, err := Authorise(key, secret, Request{
		Room: "demo", Display: "Alice", TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if first.Proof == "" {
		t.Fatal("an issued identity came without the proof that keeps it")
	}

	grant, err := Authorise(key, secret, Request{
		Room: "demo", Identity: first.Identity, IdentityProof: first.Proof,
		Display: "Alice", TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if grant.Identity != first.Identity {
		t.Fatalf("identity = %q, want the one sent back (%q)", grant.Identity, first.Identity)
	}
}

// And for nobody else. The identity is on every roster in the room; sent back
// by somebody who read it there, without the proof, it is replaced — or the
// media server seats the copy and removes the guest it belonged to.
func TestAnIssuedIdentityCopiedFromTheRosterIsReplaced(t *testing.T) {
	tripKey := []byte("a tripcode key for this test only")

	guest, err := Authorise(key, secret, Request{Room: "demo", Display: "Guest", TripKey: tripKey, TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}

	other, err := Authorise(key, secret, Request{Room: "demo", Display: "Other", TripKey: tripKey, TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}

	for name, proof := range map[string]string{
		"no proof":             "",
		"its own proof":        other.Proof,
		"a proof with no key":  GuestProof(nil, guest.Identity),
		"another key's proof":  GuestProof([]byte("another key"), guest.Identity),
		"the proof, truncated": guest.Proof[:len(guest.Proof)-1],
	} {
		copied, err := Authorise(key, secret, Request{
			Room: "demo", Identity: guest.Identity, IdentityProof: proof,
			Display: "Guest", TripKey: tripKey, TTL: time.Minute,
		})
		if err != nil {
			t.Fatal(err)
		}

		if copied.Identity == guest.Identity {
			t.Errorf("a guest's identity sent back with %s was honoured, and the guest would be removed", name)
		}
	}

	// Without a key nothing can be proven, so nothing is kept.
	keyless, err := Authorise(key, secret, Request{Room: "demo", Identity: guest.Identity, Display: "Guest", TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}

	if keyless.Identity == guest.Identity {
		t.Error("an issued identity was kept where there is no key to prove it with")
	}
}

// The grant has to be narrow, since a leaked token is one somebody else holds.
func TestGrantIsScopedToOneRoom(t *testing.T) {
	grant, err := Authorise(key, secret, Request{
		Room: "demo", Display: "Alice", TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	verified, err := auth.ParseAPIToken(grant.Token)
	if err != nil {
		t.Fatalf("parse the token: %v", err)
	}

	_, claims, err := verified.Verify(secret)
	if err != nil {
		t.Fatalf("verify the token: %v", err)
	}

	if claims.Video.Room != "demo" {
		t.Errorf("room = %q, want demo", claims.Video.Room)
	}
	if claims.Video.RoomAdmin || claims.Video.RoomCreate || claims.Video.RoomList {
		t.Error("the grant carries administrative rights it has no use for")
	}
	if claims.Identity != grant.Identity {
		t.Errorf("identity = %q, want %q", claims.Identity, grant.Identity)
	}
}

// Signed in rather than set after connecting, so nobody can rename themselves to
// somebody else mid-call.
func TestDisplayNameIsSignedIn(t *testing.T) {
	grant, err := Authorise(key, secret, Request{
		Room: "demo", Display: "  Alice  ", TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	claims := verify(t, grant.Token)
	if claims.Name != "Alice" {
		t.Errorf("name = %q, want it trimmed to Alice", claims.Name)
	}
}

// An empty name would leave a tile with nothing under it and no way to tell
// whose it is.
func TestAnEmptyNameFallsBackToTheIdentity(t *testing.T) {
	grant, err := Authorise(key, secret, Request{Room: "demo", Display: "   ", TTL: time.Minute})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if claims := verify(t, grant.Token); claims.Name != grant.Identity {
		t.Errorf("name = %q, want the identity %q", claims.Name, grant.Identity)
	}
}

func TestALongNameIsTrimmedRatherThanRefused(t *testing.T) {
	grant, err := Authorise(key, secret, Request{
		Room: "demo", Display: strings.Repeat("a", MaxDisplayName+20), TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if claims := verify(t, grant.Token); len([]rune(claims.Name)) != MaxDisplayName {
		t.Errorf("name is %d runes, want %d", len([]rune(claims.Name)), MaxDisplayName)
	}
}

func TestAnInvalidRoomIsRefused(t *testing.T) {
	if _, err := Authorise(key, secret, Request{Room: "Bad Room", TTL: time.Minute}); err == nil {
		t.Fatal("an invalid room name was authorised")
	}
}

func verify(t *testing.T, token string) *auth.ClaimGrants {
	t.Helper()

	parsed, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatalf("parse the token: %v", err)
	}

	_, claims, err := parsed.Verify(secret)
	if err != nil {
		t.Fatalf("verify the token: %v", err)
	}

	return claims
}

/*
Who may wear an account's picture.

The signature is the same whether it came from a passphrase typed at the door or
from a session already signed in — it is derived the same way and it is the same
person. So the mark alone cannot answer the question the picture asks, which is
not "who is this" but "did they arrive as the account".

The distinction exists because a picture shown to anybody who types the right
passphrase into a join form is a second credential nobody chose to make one. It
also has to survive the identity a client holds across a sign-out: a tab that
kept its old identity would keep wearing the picture with no session behind it.
*/

func TestAnAccountsMarkIsOnlyWornBySomebodySignedIn(t *testing.T) {
	key, secret := "APIkey", "a secret long enough for the media server to accept it"
	tripKey := []byte("a key for signing passphrases here")

	signature := Trip(tripKey, "the account passphrase")

	// Typed at the door. The same mark, and not the account.
	typed, err := Authorise(key, secret, Request{
		Room: "standup", Display: "somebody", Passphrase: "the account passphrase",
		TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}

	byPassphrase, ok := SignatureOf(typed.Identity)
	if !ok {
		t.Fatal("a passphrase produced no mark at all")
	}

	if !byPassphrase.Proven {
		t.Error("a mark from a passphrase is not proven; it is the same person on every visit")
	}

	if byPassphrase.Account {
		t.Error("typing the right passphrase into a join form wore the account's mark; the " +
			"picture on that account would become a second credential, and a weaker one")
	}

	// Signed in. The same mark, and the account.
	held, err := Authorise(key, secret, Request{
		Room: "standup", Display: "somebody", Account: signature,
		TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}

	bySession, ok := SignatureOf(held.Identity)
	if !ok {
		t.Fatal("a session produced no mark at all")
	}

	if !bySession.Account || !bySession.Proven {
		t.Errorf("somebody signed in got %+v, wanted a mark that is both", bySession)
	}

	if bySession.Trip != byPassphrase.Trip {
		t.Error("the two routes produced different marks; signing in would make somebody a " +
			"stranger to everybody who knows them")
	}

	// And the identity does not survive signing out. A tab holding the old one
	// would go on wearing the picture with no session behind it.
	after, err := Authorise(key, secret, Request{
		Room: "standup", Identity: held.Identity, Display: "somebody",
		Passphrase: "the account passphrase", TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}

	if mark, _ := SignatureOf(after.Identity); mark.Account {
		t.Error("an identity minted while signed in was handed back after signing out and " +
			"kept the account's mark")
	}
}

// The token is signed here rather than by the media server's library, so the
// library's own verifier has to read it exactly as it reads its own: same key,
// same grants, same identity. A token it could not read is every call refused.
func TestAJoinTokenReadsAsTheMediaServerReadsItsOwn(t *testing.T) {
	key := []byte("a tripcode key for this test only")

	grant, err := Authorise("APIkey", "a secret long enough for the media server", Request{
		Room: "standup", Display: "Ada", Passphrase: "ada's passphrase", TripKey: key, TTL: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}

	verifier, err := auth.ParseAPIToken(grant.Token)
	if err != nil {
		t.Fatal(err)
	}

	if verifier.APIKey() != "APIkey" || verifier.Identity() != grant.Identity {
		t.Fatalf("the library reads key %q and identity %q", verifier.APIKey(), verifier.Identity())
	}

	claims, grants, err := verifier.Verify("a secret long enough for the media server")
	if err != nil {
		t.Fatalf("the library refused a join token: %v", err)
	}

	if grants.Name != "Ada" || grants.Video == nil || !grants.Video.RoomJoin || grants.Video.Room != "standup" ||
		!grants.Video.GetCanPublish() || !grants.Video.GetCanSubscribe() || !grants.Video.GetCanPublishData() {
		t.Errorf("the grants read back as %+v / %+v", grants, grants.Video)
	}

	if !Vouched(key, grants.Identity, grants.Video.Room, claims.ExpiresAt.Time, claims.ID) {
		t.Error("this node's own token does not carry its proof")
	}

	// Each of the three things the proof covers, changed.
	for name, changed := range map[string]bool{
		"another identity": Vouched(key, MintIdentity(""), grants.Video.Room, claims.ExpiresAt.Time, claims.ID),
		"another room":     Vouched(key, grants.Identity, "other", claims.ExpiresAt.Time, claims.ID),
		"a later expiry":   Vouched(key, grants.Identity, grants.Video.Room, claims.ExpiresAt.Time.Add(time.Hour), claims.ID),
		"another key":      Vouched([]byte("another key"), grants.Identity, grants.Video.Room, claims.ExpiresAt.Time, claims.ID),
	} {
		if changed {
			t.Errorf("the proof still holds for %s", name)
		}
	}
}

// Present reads only this node's tokens, and reports the expiry rather than
// enforcing it: the host endpoints accept one past it on conditions of their
// own, and a token the media server refreshed, or a relay wrote, is not one
// of this node's at all.
func TestPresentReadsOnlyThisNodesTokens(t *testing.T) {
	tripKey := []byte("a tripcode key for this test only")
	const k, s = "APIkey", "a secret long enough for the media server"

	grant, err := Authorise(k, s, Request{Room: "standup", Display: "Ada", Passphrase: "ada's", TripKey: tripKey, TTL: time.Second})
	if err != nil {
		t.Fatal(err)
	}

	time.Sleep(1100 * time.Millisecond)

	presented, ok := Present(grant.Token, k, s, tripKey)
	if !ok || presented.Identity != grant.Identity || presented.Room != "standup" {
		t.Fatalf("an expired token of this node's read as %+v, %v", presented, ok)
	}
	if !time.Now().After(presented.Expires) || presented.Issued.IsZero() {
		t.Errorf("the expiry and the minting were not reported: %+v", presented)
	}

	refreshed, err := auth.NewAccessToken(k, s).SetIdentity(grant.Identity).
		SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: "standup"}).SetValidFor(time.Hour).ToJWT()
	if err != nil {
		t.Fatal(err)
	}

	for name, raw := range map[string]string{
		"one the media server or a relay signed": refreshed,
		"one under another secret":               mustAuthorise(t, k, "another secret entirely, long enough", tripKey),
		"one under another key":                  mustAuthorise(t, "APIother", s, tripKey),
	} {
		if _, ok := Present(raw, k, s, tripKey); ok {
			t.Errorf("Present accepted %s", name)
		}
	}

	if _, ok := Present(grant.Token, k, s, []byte("another tripcode key")); ok {
		t.Error("Present accepted a token whose proof another node's key would not write")
	}
}

func mustAuthorise(t *testing.T, key, secret string, tripKey []byte) string {
	t.Helper()

	grant, err := Authorise(key, secret, Request{Room: "standup", Display: "Ada", TripKey: tripKey, TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}

	return grant.Token
}
