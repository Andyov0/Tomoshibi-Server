package room

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var tripKey = []byte("a key that is not the api credentials")

func TestTheSamePassphraseAlwaysSignsTheSame(t *testing.T) {
	first := Trip(tripKey, "correct horse")
	second := Trip(tripKey, "correct horse")

	if first != second {
		t.Fatalf("%q and %q differ for one passphrase", first, second)
	}
	if len(first) != TripLength {
		t.Errorf("signature is %d characters, want %d", len(first), TripLength)
	}
	if Trip(tripKey, "correct horse ") == first {
		t.Error("a trailing space made no difference; the passphrase is not taken literally")
	}
}

// Without the key a signature cannot be attacked offline, which is the whole
// difference between this and the tripcodes it borrows from.
func TestADifferentKeyGivesADifferentSignature(t *testing.T) {
	if Trip(tripKey, "secret") == Trip([]byte("another key entirely"), "secret") {
		t.Fatal("the key does not affect the signature")
	}
}

func TestSignatureTravelsInTheIdentity(t *testing.T) {
	trip := Trip(tripKey, "secret")
	identity := MintIdentity(trip)

	mark, ok := SignatureOf(identity)
	if !ok {
		t.Fatalf("SignatureOf(%q) found nothing", identity)
	}
	if mark.Trip != trip {
		t.Errorf("read %q, want %q", mark.Trip, trip)
	}
	if !mark.Proven {
		t.Error("a passphrase-derived mark did not report itself as proven")
	}
	if !ValidIdentity(identity) {
		t.Errorf("ValidIdentity(%q) = false for one we minted", identity)
	}
}

// Everybody carries a mark. Without one, two people arriving under the same
// name are indistinguishable and the roster cannot say which of them spoke.
func TestSomebodyWithoutAPassphraseStillGetsAMark(t *testing.T) {
	identity := MintIdentity("")

	mark, ok := SignatureOf(identity)
	if !ok {
		t.Fatalf("SignatureOf(%q) found nothing", identity)
	}
	if len(mark.Trip) != TripLength {
		t.Errorf("mark is %d characters, want %d", len(mark.Trip), TripLength)
	}
	if !ValidIdentity(identity) {
		t.Errorf("ValidIdentity(%q) = false for one we minted", identity)
	}
}

// The whole mechanism rests on this. A mark nobody can tell apart from an
// earned one is worth nothing, because an impostor would point at theirs and
// claim it.
func TestAnIssuedMarkDoesNotPassForAnEarnedOne(t *testing.T) {
	earned, _ := SignatureOf(MintIdentity(Trip(tripKey, "secret")))
	given, _ := SignatureOf(MintIdentity(""))

	if !earned.Proven {
		t.Error("an earned mark is not marked proven")
	}
	if given.Proven {
		t.Fatal("an issued mark passes for an earned one")
	}
}

// An issued mark is fresh every time, so it says nothing about who somebody was
// last time — which is exactly what it must not claim.
func TestAnIssuedMarkIsDifferentEveryTime(t *testing.T) {
	first, _ := SignatureOf(MintIdentity(""))
	second, _ := SignatureOf(MintIdentity(""))

	if first.Trip == second.Trip {
		t.Fatal("two issued marks are the same, which would imply a persistent identity")
	}
}

// Two tabs with one passphrase are two participants who share a signature, not
// one who keeps evicting themselves.
func TestOnePassphraseStillGivesSeparateIdentities(t *testing.T) {
	trip := Trip(tripKey, "secret")

	if MintIdentity(trip) == MintIdentity(trip) {
		t.Fatal("two identities from one passphrase are the same")
	}
}

func TestSigningEndToEnd(t *testing.T) {
	grant, err := Authorise(key, secret, Request{
		Room: "demo", Display: "Alice", Passphrase: "hunter2", TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	mark, ok := SignatureOf(grant.Identity)
	if !ok {
		t.Fatalf("identity %q carries no signature", grant.Identity)
	}
	if !mark.Proven {
		t.Error("a passphrase produced a mark that does not report itself as proven")
	}
	if mark.Trip != Trip(tripKey, "hunter2") {
		t.Error("the signature is not the one this passphrase produces")
	}
}

// Changing or dropping a passphrase has to take effect immediately, rather than
// being masked by the identity a client happens to be holding.
func TestChangingThePassphraseReplacesTheIdentity(t *testing.T) {
	first, err := Authorise(key, secret, Request{
		Room: "demo", Passphrase: "one", TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	changed, err := Authorise(key, secret, Request{
		Room: "demo", Identity: first.Identity, Passphrase: "two", TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if changed.Identity == first.Identity {
		t.Fatal("a new passphrase kept the old signature")
	}

	dropped, err := Authorise(key, secret, Request{
		Room: "demo", Identity: first.Identity, TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if mark, _ := SignatureOf(dropped.Identity); mark.Proven {
		t.Error("dropping the passphrase left the earned signature behind")
	}
}

func TestAnUnchangedPassphraseKeepsTheIdentity(t *testing.T) {
	first, err := Authorise(key, secret, Request{
		Room: "demo", Passphrase: "same", TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	again, err := Authorise(key, secret, Request{
		Room: "demo", Identity: first.Identity, Passphrase: "same", TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if again.Identity != first.Identity {
		t.Error("an unchanged passphrase did not keep the identity")
	}
}

// A caller cannot wear a signature they did not earn, because the identity is
// signed into the token and rebuilt from the passphrase every time.
func TestAClaimedSignatureIsDiscarded(t *testing.T) {
	stolen := MintIdentity(Trip(tripKey, "somebody else's secret"))

	grant, err := Authorise(key, secret, Request{
		Room: "demo", Identity: stolen, TripKey: tripKey, TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if grant.Identity == stolen {
		t.Fatal("an identity carrying somebody else's signature was accepted")
	}
	if mark, _ := SignatureOf(grant.Identity); mark.Proven {
		t.Error("a caller with no passphrase was handed an earned signature")
	}
}

// The value must not reach a log, however the surrounding struct is formatted.
func TestAPassphraseNeverPrintsItself(t *testing.T) {
	held := struct{ Passphrase Passphrase }{Passphrase: "hunter2"}

	for _, printed := range []string{
		fmt.Sprint(Passphrase("hunter2")),
		fmt.Sprintf("%v", held),
		fmt.Sprintf("%+v", held),
		fmt.Sprintf("%#v", held),
	} {
		if strings.Contains(printed, "hunter2") {
			t.Errorf("a passphrase printed itself: %s", printed)
		}
	}
}

func TestTheKeyIsCreatedOnceAndThenReused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "tripcode.key")

	first, err := LoadTripKey(path)
	if err != nil {
		t.Fatalf("LoadTripKey: %v", err)
	}

	again, err := LoadTripKey(path)
	if err != nil {
		t.Fatalf("LoadTripKey: %v", err)
	}

	if string(first) != string(again) {
		t.Fatal("the key changed between runs, which changes everybody's signature")
	}

	// Readable only by its owner, where the platform has an opinion.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("mode is %o, want 600", mode)
	}
}

func TestAnUnreadableKeySaysWhatToDo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tripcode.key")
	if err := os.WriteFile(path, []byte("!!! not base32 !!!"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, err := LoadTripKey(path)
	if err == nil {
		t.Fatal("an unreadable key was accepted")
	}
	if !strings.Contains(err.Error(), "Delete it to start over") {
		t.Errorf("the error does not say what to do: %v", err)
	}
}
