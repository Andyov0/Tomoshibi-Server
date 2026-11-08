package store

import (
	"errors"
	"reflect"
	"testing"

	"tomoshibi/internal/room"
)

/*
What these guard is a relay of somebody's own quietly stopping being theirs, or
quietly becoming somebody else's.

Each fault below would be silent. A rename that left the account naming the old
relay would leave its holder refused at every join with their machine working;
a removal that cleared it from the account would hand them every other relay
without anybody deciding to; and a relay both kept for administrators and given
to somebody would be one whose holder is refused it at the door.
*/

func ownStore(t *testing.T) *Store {
	t.Helper()

	st := open(t)

	for _, relay := range []Relay{
		{Name: "theirs", URL: "wss://theirs.example", Enabled: true},
		{Name: "public", URL: "wss://public.example", Enabled: true},
		{Name: "kept", URL: "wss://kept.example", Enabled: true, AdminOnly: true},
	} {
		if err := st.AddRelay(relay); err != nil {
			t.Fatalf("AddRelay %s: %v", relay.Name, err)
		}
	}

	if err := st.AddAccount(Account{Name: "ada", Trip: room.Trip([]byte("key"), "ada's passphrase")}); err != nil {
		t.Fatalf("AddAccount: %v", err)
	}

	return st
}

func give(t *testing.T, st *Store, name string, relays ...string) error {
	t.Helper()

	account, ok := st.Account(name)
	if !ok {
		t.Fatalf("no account %q", name)
	}

	account.Relays = relays

	return st.UpdateAccount(name, account)
}

func TestARelayOfOnesOwnIsKeptAndTidied(t *testing.T) {
	st := ownStore(t)

	if err := give(t, st, "ada", " theirs ", "theirs", ""); err != nil {
		t.Fatalf("giving ada her relay: %v", err)
	}

	account, _ := st.Account("ada")
	if !reflect.DeepEqual(account.Relays, []string{"theirs"}) {
		t.Errorf("stored %q, want [theirs]: each once, trimmed, nothing empty", account.Relays)
	}

	owners, err := st.RelayOwners()
	if err != nil {
		t.Fatalf("RelayOwners: %v", err)
	}

	if !reflect.DeepEqual(owners, map[string][]string{"theirs": {"ada"}}) {
		t.Errorf("owners %v, want theirs held by ada and nothing else", owners)
	}
}

func TestOnlyARelayThatIsHereCanBeSomebodysOwn(t *testing.T) {
	st := ownStore(t)

	if err := give(t, st, "ada", "nowhere"); !errors.Is(err, ErrAccountNoSuchRelay) {
		t.Errorf("giving a relay nobody has: %v, want ErrAccountNoSuchRelay", err)
	}
}

// Kept for administrators and somebody's own cannot both be true, in either
// order.
func TestARelayKeptForAdministratorsIsNobodysOwn(t *testing.T) {
	st := ownStore(t)

	if err := give(t, st, "ada", "kept"); !errors.Is(err, ErrAccountRelayReserved) {
		t.Errorf("giving a relay kept for administrators: %v, want ErrAccountRelayReserved", err)
	}

	if err := give(t, st, "ada", "theirs"); err != nil {
		t.Fatalf("giving ada her relay: %v", err)
	}

	relays, _ := st.Relays()
	for _, relay := range relays {
		if relay.Name != "theirs" {
			continue
		}

		relay.AdminOnly = true
		if err := st.UpdateRelay(relay); !errors.Is(err, ErrRelayIsSomebodys) {
			t.Errorf("keeping somebody's own relay for administrators: %v, want ErrRelayIsSomebodys", err)
		}

		relay.AdminOnly = false
		relay.Label = "Ada's"
		if err := st.UpdateRelay(relay); err != nil {
			t.Errorf("an ordinary change to somebody's own relay was refused: %v", err)
		}
	}
}

func TestARelayOfSomebodysOwnFollowsARename(t *testing.T) {
	st := ownStore(t)

	if err := give(t, st, "ada", "theirs", "public"); err != nil {
		t.Fatalf("giving ada two relays: %v", err)
	}

	if err := st.RenameRelay("theirs", "adas"); err != nil {
		t.Fatalf("RenameRelay: %v", err)
	}

	account, _ := st.Account("ada")
	if !reflect.DeepEqual(account.Relays, []string{"adas", "public"}) {
		t.Errorf("after the rename ada holds %q, want [adas public]: an account left naming "+
			"the old name holds a relay that is not there, and is refused at every join", account.Relays)
	}
}

func TestARelayOfSomebodysOwnIsNotRemovedFromUnderThem(t *testing.T) {
	st := ownStore(t)

	if err := give(t, st, "ada", "theirs"); err != nil {
		t.Fatalf("giving ada her relay: %v", err)
	}

	if err := st.RemoveRelay("theirs"); !errors.Is(err, ErrRelayIsSomebodys) {
		t.Fatalf("removing somebody's own relay: %v, want ErrRelayIsSomebodys", err)
	}

	if err := give(t, st, "ada"); err != nil {
		t.Fatalf("taking it off ada: %v", err)
	}

	if err := st.RemoveRelay("theirs"); err != nil {
		t.Errorf("removing a relay nobody holds any more: %v", err)
	}
}

// An account already holding a relay is not refused an unrelated change over
// it. Only the relays being given are asked about.
func TestAnAccountsOtherFieldsChangeWhateverItHolds(t *testing.T) {
	st := ownStore(t)

	if err := give(t, st, "ada", "theirs"); err != nil {
		t.Fatalf("giving ada her relay: %v", err)
	}

	account, _ := st.Account("ada")
	account.Note = "provided her own machine"

	if err := st.UpdateAccount("ada", account); err != nil {
		t.Errorf("a note on an account holding a relay was refused: %v", err)
	}
}
