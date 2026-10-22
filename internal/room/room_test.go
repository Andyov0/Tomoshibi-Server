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

func TestIdentityWeMintedIsKept(t *testing.T) {
	minted := MintIdentity("")

	grant, err := Authorise(key, secret, Request{
		Room: "demo", Identity: minted, Display: "Alice", TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if grant.Identity != minted {
		t.Fatalf("identity = %q, want the one sent back (%q)", grant.Identity, minted)
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
