package config

import (
	"strings"
	"testing"
)

/*
What an administrator written down before the finer capabilities may do.

Every route that used to ask for moderate now asks for one of four narrower
things, and the only reason an existing moderator still reaches all of them is
that moderate is read as holding the four. Lose that rule and nothing fails to
start, no page errors, and every moderator on the deployment finds the rooms,
the accounts, the relays and the settings refusing them — while an entry with
nothing written keeps exactly what it had, which was looking.
*/

func TestAModeratorHoldsEveryFinerCapability(t *testing.T) {
	moderator := Admin{Trip: "abcdefghij", Can: []string{Moderate}}

	for _, capability := range Capabilities() {
		if !moderator.Allows(capability) {
			t.Errorf("an administrator written as [moderate] does not hold %q; every "+
				"moderator on the deployment would lose it on upgrade", capability)
		}
	}
}

func TestAnEntryWithNothingStillOnlyWatches(t *testing.T) {
	watcher := Admin{Trip: "abcdefghij"}

	for _, capability := range Capabilities() {
		if watcher.Allows(capability) != (capability == Observe) {
			t.Errorf("an administrator written with nothing: Allows(%q) = %v",
				capability, watcher.Allows(capability))
		}
	}
}

// A finer capability is that and nothing else: not moderate, and not its
// neighbours.
func TestAFinerCapabilityIsOnlyItself(t *testing.T) {
	finer := []string{ManageRooms, ManageAccounts, ManageRelays, ManageSettings}

	for _, given := range finer {
		admin := Admin{Trip: "abcdefghij", Can: []string{given}}

		for _, asked := range Capabilities() {
			want := asked == Observe || asked == given

			if admin.Allows(asked) != want {
				t.Errorf("given only %q, Allows(%q) = %v, want %v", given, asked, admin.Allows(asked), want)
			}
		}
	}
}

func TestTheFileAcceptsEveryCapabilityAndNothingElse(t *testing.T) {
	for _, capability := range Capabilities() {
		if err := checkAdmins([]Admin{{Trip: "abcdefghij", Can: []string{capability}}}); err != nil {
			t.Errorf("an administrator given %q in the file was refused: %v", capability, err)
		}
	}

	err := checkAdmins([]Admin{{Trip: "abcdefghij", Can: []string{"everything"}}})
	if err == nil {
		t.Fatal("an administrator given a capability that does not exist was accepted")
	}

	// The message names what would have been accepted, which is the way out.
	if !strings.Contains(err.Error(), ManageSettings) {
		t.Errorf("the refusal does not say what the choices are: %v", err)
	}
}
