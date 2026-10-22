package store

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
)

/*
What somebody may use, as the store keeps it.

The failures worth a test here are the quiet ones. A grant that survives being
taken away, because a page holding an older copy of the record wrote the whole
of it back. A grant that a newcomer inherits along with a name somebody else gave
up. A deployment whose every account loses the music library on the day this
field arrives, because a record with nothing in it was read as "nothing". None of
these breaks a page; each of them is found, if at all, by somebody noticing that
a person can do something they should not, or cannot do something they could.
*/

func TestAnAccountWrittenBeforePermissionsMeansTheDefaults(t *testing.T) {
	st := open(t)

	// The record exactly as the build before this wrote it: no perms at all.
	raw := []byte(`{"name":"ada","trip":"abcdefghij","created":"2026-01-02T03:04:05Z",` +
		`"lastSeen":"0001-01-01T00:00:00Z","scopes":["acme"]}`)

	if err := st.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(accountsBucket)
		if err != nil {
			return err
		}

		return bucket.Put(accountKey("ada"), raw)
	}); err != nil {
		t.Fatal(err)
	}

	account, ok := st.Account("ada")
	if !ok {
		t.Fatal("an account written by the previous build could not be read")
	}

	for _, permission := range Permissions() {
		byDefault, _ := Permission(permission)

		if account.May(permission) != byDefault {
			t.Errorf("an account written before permissions existed holds %s = %v, want its "+
				"default %v; every account on the deployment would change on the day this "+
				"field arrived", permission, account.May(permission), byDefault)
		}
	}

	if account.May(PermEmby) {
		t.Error("an account nobody granted anything was given Emby")
	}
}

func TestAnAccountKeepsItsPermissionsAndNobodyInheritsThem(t *testing.T) {
	st := open(t)
	trip := room.Trip([]byte("key"), "ada's passphrase")

	if err := st.AddAccount(Account{
		Name: "ada", Trip: trip, Perms: map[string]bool{PermEmby: true, PermMusic: false},
	}); err != nil {
		t.Fatalf("AddAccount: %v", err)
	}

	read, _ := st.Account("ada")
	if !read.May(PermEmby) || read.May(PermMusic) || !read.May(PermWatch) {
		t.Fatalf("read back as %v", read.Effective())
	}

	// Renamed, and the grants go with the record rather than staying behind
	// under the old name for whoever takes it next.
	read.Name = "ada-l"
	if err := st.UpdateAccount("ada", read); err != nil {
		t.Fatalf("UpdateAccount: %v", err)
	}

	if renamed, _ := st.Account("ada-l"); !renamed.May(PermEmby) || renamed.May(PermMusic) {
		t.Errorf("a renamed account holds %v; its grants should have gone with it",
			renamed.Effective())
	}

	if err := st.AddAccount(Account{Name: "ada", Trip: room.Trip([]byte("key"), "another")}); err != nil {
		t.Fatalf("AddAccount: %v", err)
	}

	fresh, _ := st.Account("ada")
	if fresh.May(PermEmby) {
		t.Error("an account given an old name inherited the Emby grant of whoever had it")
	}
	if !fresh.May(PermMusic) {
		t.Error("an account given an old name inherited a refusal of whoever had it")
	}
}

/*
The race the carrying-over exists for.

Changing one's own picture reads the account when the request arrives and writes
the whole record back. An administrator taking somebody's Emby away in between
is a write the picture change has never seen, and before the store carried the
grants over itself, the picture change put the grant back — silently, and in the
direction that costs money.
*/
func TestARecordWrittenBackCannotRestoreARevokedGrant(t *testing.T) {
	st := open(t)
	trip := room.Trip([]byte("key"), "ada's passphrase")

	if err := st.AddAccount(Account{Name: "ada", Trip: trip, Perms: map[string]bool{PermEmby: true}}); err != nil {
		t.Fatal(err)
	}

	// What the person's own page holds: the record as it was when they signed in.
	stale, _ := st.Account("ada")

	// The administrator takes Emby away.
	if err := st.SetAccountPerms("ada", nil); err != nil {
		t.Fatalf("SetAccountPerms: %v", err)
	}

	// And the person changes their picture, with the copy they had.
	stale.Avatar = "data:image/png;base64,AAAA"
	if err := st.UpdateAccount("ada", stale); err != nil {
		t.Fatalf("UpdateAccount: %v", err)
	}

	after, _ := st.Account("ada")

	if after.May(PermEmby) {
		t.Error("changing a picture with an older copy of the account gave back the Emby " +
			"grant an administrator had just taken away")
	}

	if after.Avatar != stale.Avatar {
		t.Error("the picture change itself was lost; the guard has to keep the grants " +
			"without throwing away the edit")
	}

	// The other direction is the same rule: a grant given in between is not
	// taken away by a page that did not know about it.
	stale, _ = st.Account("ada")

	if err := st.SetAccountPerms("ada", map[string]bool{PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	stale.Note = "a note"
	if err := st.UpdateAccount("ada", stale); err != nil {
		t.Fatal(err)
	}

	if after, _ := st.Account("ada"); !after.May(PermEmby) {
		t.Error("a record written back from an older copy took away a grant given since")
	}
}

func TestAPermissionNobodyKnowsIsNotWritten(t *testing.T) {
	st := open(t)
	trip := room.Trip([]byte("key"), "ada's passphrase")

	err := st.AddAccount(Account{Name: "ada", Trip: trip, Perms: map[string]bool{"teleport": true}})
	if !errors.Is(err, ErrUnknownPermission) {
		t.Fatalf("AddAccount with an unknown permission = %v, want ErrUnknownPermission", err)
	}

	if err := st.AddAccount(Account{Name: "ada", Trip: trip}); err != nil {
		t.Fatal(err)
	}

	err = st.SetAccountPerms("ada", map[string]bool{PermMusic: false, "teleport": true})
	if !errors.Is(err, ErrUnknownPermission) {
		t.Fatalf("SetAccountPerms with an unknown permission = %v, want ErrUnknownPermission", err)
	}

	// Refused whole: the known half of a refused change is not written either.
	if account, _ := st.Account("ada"); !account.May(PermMusic) {
		t.Error("a refused change still took the music library away")
	}

	// And a word nobody knows is held by nobody, whatever a record says.
	if (Account{Perms: map[string]bool{"teleport": true}}).May("teleport") {
		t.Error("an account holds a permission this build has never heard of")
	}
}

// Only what differs from the defaults is kept, so a page that sends every box
// back and a page that sends only the one that moved store the same record.
func TestPermissionsAreKeptAsOverrides(t *testing.T) {
	st := open(t)
	trip := room.Trip([]byte("key"), "ada's passphrase")

	if err := st.AddAccount(Account{Name: "ada", Trip: trip}); err != nil {
		t.Fatal(err)
	}

	every := map[string]bool{}
	for _, permission := range Permissions() {
		every[permission], _ = Permission(permission)
	}
	every[PermMusic] = false

	if err := st.SetAccountPerms("ada", every); err != nil {
		t.Fatal(err)
	}

	account, _ := st.Account("ada")
	if !reflect.DeepEqual(account.Perms, map[string]bool{PermMusic: false}) {
		t.Errorf("stored %v, want only the one that differs from its default", account.Perms)
	}

	// Every box at its default is a record that says nothing.
	every[PermMusic] = true
	if err := st.SetAccountPerms("ada", every); err != nil {
		t.Fatal(err)
	}

	if account, _ := st.Account("ada"); account.Perms != nil {
		t.Errorf("every permission at its default stored %v, want nothing", account.Perms)
	}
}

/*
When somebody was last here.

It was never written. AccountSeen set it on a copy and handed the copy to
UpdateAccount, which carries LastSeen over from the stored record — so what was
written was the old value, every time, and the accounts page said "never here"
about everybody who had ever been.
*/
func TestWhenSomebodyWasLastHereIsWrittenDown(t *testing.T) {
	st := open(t)
	trip := room.Trip([]byte("key"), "ada's passphrase")

	if err := st.AddAccount(Account{Name: "ada", Trip: trip}); err != nil {
		t.Fatal(err)
	}

	at := time.Date(2026, 10, 1, 9, 30, 0, 0, time.UTC)
	st.AccountSeen(trip, at)

	if account, _ := st.Account("ada"); !account.LastSeen.Equal(at) {
		t.Fatalf("last seen reads %v after a join at %v", account.LastSeen, at)
	}

	// Two joins finishing out of order leave the later.
	st.AccountSeen(trip, at.Add(-time.Hour))

	if account, _ := st.Account("ada"); !account.LastSeen.Equal(at) {
		t.Errorf("an earlier join moved last seen back to %v", account.LastSeen)
	}

	// And a record written back from a copy that predates the join does not
	// erase it, which is the other half of LastSeen not being the caller's.
	stale := Account{Name: "ada", Trip: trip, Note: "edited"}
	if err := st.UpdateAccount("ada", stale); err != nil {
		t.Fatal(err)
	}

	if account, _ := st.Account("ada"); !account.LastSeen.Equal(at) {
		t.Errorf("an edit erased last seen: %v", account.LastSeen)
	}
}

/*
Administrators and the same field.

Everything that defaults to yes they hold, whatever is written; Emby they hold
only where it was given. And the role editor, which rebuilds an administrator
from what the page sent, must not take the picture or the grant with it.
*/

func TestAnAdministratorHoldsTheDefaultsAndNotEmby(t *testing.T) {
	plain := Admin{Trip: "abcdefghij"}

	for _, permission := range Permissions() {
		byDefault, _ := Permission(permission)

		if plain.May(permission) != byDefault {
			t.Errorf("an administrator holds %s = %v, want %v", permission, plain.May(permission), byDefault)
		}
	}

	// A refusal written against one of the defaults is read as nothing.
	denied := Admin{Trip: "abcdefghij", Perms: map[string]bool{PermMusic: false}}
	if !denied.May(PermMusic) {
		t.Error("an administrator was denied a permission every administrator holds")
	}

	// And the owner's moderate carries no Emby with it.
	owner := Admin{Trip: "abcdefghij", Can: []string{config.Moderate}}
	if owner.May(PermEmby) {
		t.Error("an administrator who may moderate holds Emby without being given it")
	}

	if !(Admin{Perms: map[string]bool{PermEmby: true}}).May(PermEmby) {
		t.Error("an administrator given Emby does not hold it")
	}
}

func TestChangingAnAdministratorsRoleKeepsTheirPictureAndGrants(t *testing.T) {
	st := listing(t, owner, second)

	if err := st.SetAdminAvatar(second.Trip, "data:image/png;base64,AAAA"); err != nil {
		t.Fatalf("SetAdminAvatar: %v", err)
	}

	if err := st.SetAdminPerms(second.Trip, map[string]bool{PermEmby: true}); err != nil {
		t.Fatalf("SetAdminPerms: %v", err)
	}

	// What the role editor writes: a trip, a name and a role, and nothing else.
	if err := st.UpdateAdmin(Admin{Trip: second.Trip, Name: "samuel", Can: []string{config.ManageRooms}}); err != nil {
		t.Fatalf("UpdateAdmin: %v", err)
	}

	after, _ := st.AdminBySignature(second.Trip)

	if after.Avatar == "" {
		t.Error("changing an administrator's role took their picture away")
	}
	if !after.May(PermEmby) {
		t.Error("changing an administrator's role took their Emby grant away")
	}
	if after.Name != "samuel" || !reflect.DeepEqual(after.Can, []string{config.ManageRooms}) {
		t.Errorf("the change itself did not take: %+v", after)
	}

	// And an older copy written back does not restore a grant taken away since.
	stale := after

	if err := st.SetAdminPerms(second.Trip, nil); err != nil {
		t.Fatal(err)
	}

	stale.Name = "sam"
	if err := st.UpdateAdmin(stale); err != nil {
		t.Fatal(err)
	}

	if again, _ := st.AdminBySignature(second.Trip); again.May(PermEmby) {
		t.Error("an older copy of an administrator, written back, restored a revoked Emby grant")
	}
}

func TestAnAdministratorsPictureIsBounded(t *testing.T) {
	st := listing(t, owner)

	large := make([]byte, maxAvatar+1)
	for i := range large {
		large[i] = 'a'
	}

	if err := st.SetAdminAvatar(owner.Trip, string(large)); !errors.Is(err, ErrAvatarTooLarge) {
		t.Errorf("an oversized picture gave %v, want ErrAvatarTooLarge", err)
	}
}

// The finer capabilities are things an administrator can be given and hold, in
// the store as in the file; a word that is none of them is still refused.
func TestTheFinerCapabilitiesCanBeStored(t *testing.T) {
	for _, capability := range []string{config.ManageRooms, config.ManageAccounts, config.ManageRelays, config.ManageSettings} {
		admin := Admin{Trip: "abcdefghij", Can: []string{capability}}

		if err := admin.Valid(); err != nil {
			t.Errorf("an administrator given %q was refused: %v", capability, err)
		}

		if !admin.Allows(capability) || admin.Allows(config.Moderate) {
			t.Errorf("an administrator given only %q: holds it %v, holds moderate %v",
				capability, admin.Allows(capability), admin.Allows(config.Moderate))
		}
	}

	if err := (Admin{Trip: "abcdefghij", Can: []string{"everything"}}).Valid(); !errors.Is(err, ErrAdminBadCan) {
		t.Errorf("an unknown capability gave %v, want ErrAdminBadCan", err)
	}

	if err := (Admin{Trip: "abcdefghij", Perms: map[string]bool{"teleport": true}}).Valid(); !errors.Is(err, ErrUnknownPermission) {
		t.Errorf("an unknown permission on an administrator gave %v, want ErrUnknownPermission", err)
	}
}

/*
The switch above every Emby grant.

Off unless somebody turned it on. Absent and unreadable both read as off, which
is the direction to fail in for a setting whose "on" spends money.
*/
func TestTheEmbyRelayIsOffUntilTurnedOn(t *testing.T) {
	st := open(t)

	if st.EmbyRelay() {
		t.Fatal("a deployment that never touched the switch relays Emby")
	}

	if err := st.SetEmbyRelay(true); err != nil {
		t.Fatal(err)
	}

	if !st.EmbyRelay() {
		t.Fatal("turning the relay on did not take")
	}

	if err := st.SetEmbyRelay(false); err != nil {
		t.Fatal(err)
	}

	if st.EmbyRelay() {
		t.Fatal("turning the relay off did not take")
	}

	// Something else written there by hand, or by a later build.
	if err := st.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(settings).Put(embyRelay, []byte("yes"))
	}); err != nil {
		t.Fatal(err)
	}

	if st.EmbyRelay() {
		t.Error("a value that is not \"on\" turned the relay on")
	}
}

/*
The ledger of tickets the relay agreed to carry.

An expired one is not there whether or not the sweep has run, because the gate
in front of the media must not depend on a timer being on time. And the file is
not a list of working links: the key is the ticket's hash.
*/
func TestAWatchTicketIsHonouredUntilItExpires(t *testing.T) {
	st := open(t)

	grant := WatchGrant{Name: "ada", Trip: "abcdefghij", Expires: time.Now().Add(time.Hour).UTC()}

	if err := st.PutWatchTicket("live-ticket", grant); err != nil {
		t.Fatalf("PutWatchTicket: %v", err)
	}

	got, ok := st.WatchTicket("live-ticket")
	if !ok || got.Trip != grant.Trip || got.Name != grant.Name {
		t.Fatalf("read back %+v, %v", got, ok)
	}

	if _, ok := st.WatchTicket("some-other-ticket"); ok {
		t.Error("a ticket nobody recorded was honoured")
	}

	if err := st.PutWatchTicket("spent-ticket", WatchGrant{
		Name: "ada", Trip: "abcdefghij", Expires: time.Now().Add(-time.Second),
	}); err != nil {
		t.Fatal(err)
	}

	if _, ok := st.WatchTicket("spent-ticket"); ok {
		t.Error("an expired ticket was honoured because nothing had swept it yet")
	}

	// A grant with nobody behind it, or no end, is refused rather than kept.
	for _, bad := range []WatchGrant{
		{Name: "ada", Expires: time.Now().Add(time.Hour)},
		{Name: "ada", Trip: "abcdefghij"},
	} {
		if err := st.PutWatchTicket("bad-ticket", bad); !errors.Is(err, ErrNoTicket) {
			t.Errorf("PutWatchTicket(%+v) = %v, want ErrNoTicket", bad, err)
		}
	}

	gone, err := st.SweepWatchTickets(time.Now())
	if err != nil {
		t.Fatal(err)
	}

	if gone != 1 {
		t.Errorf("the sweep removed %d tickets, want only the expired one", gone)
	}

	if _, ok := st.WatchTicket("live-ticket"); !ok {
		t.Error("the sweep removed a ticket still in its time")
	}

	// Not stored as itself.
	_ = st.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(ticketsBucket).ForEach(func(key, raw []byte) error {
			if string(key) == "live-ticket" {
				t.Error("a watch ticket is stored as itself; a copy of the file is a list of working links")
			}

			var grant WatchGrant
			if err := json.Unmarshal(raw, &grant); err != nil {
				t.Errorf("an entry is not readable: %v", err)
			}

			return nil
		})
	})
}

/*
A record this build cannot read is left as it is when somebody changes it.

The whole-record writers carry the permissions over from what is stored, and
from a record that will not read there is nothing to carry: written anyway, the
record put in its place holds every permission at its default, which for
anybody who had one taken away is giving it back, and for an administrator given
Emby is taking it. So each refuses instead, and leaves the bytes for the build
that can read them. As does every writer of one field, for the same reason.
*/
func TestARecordThatWillNotReadIsNotWrittenOver(t *testing.T) {
	st := open(t)

	const unreadable = `{"name":"ada","trip":` // cut short, as a crash mid-write would

	put := func(bucket []byte, key string) {
		t.Helper()

		if err := st.db.Update(func(tx *bolt.Tx) error {
			b, err := tx.CreateBucketIfNotExists(bucket)
			if err != nil {
				return err
			}

			return b.Put([]byte(key), []byte(unreadable))
		}); err != nil {
			t.Fatal(err)
		}
	}

	stored := func(bucket []byte, key string) string {
		t.Helper()

		var raw string
		_ = st.db.View(func(tx *bolt.Tx) error {
			raw = string(tx.Bucket(bucket).Get([]byte(key)))
			return nil
		})

		return raw
	}

	put(accountsBucket, "ada")

	for name, write := range map[string]func() error{
		"UpdateAccount": func() error {
			return st.UpdateAccount("ada", Account{Name: "ada", Trip: "abcdefghij", Avatar: "data:image/png;base64,AAAA"})
		},
		"SetAccountAvatar":   func() error { return st.SetAccountAvatar("ada", "data:image/png;base64,AAAA") },
		"SetAccountTrip":     func() error { return st.SetAccountTrip("ada", "abcdefghij", "bcdefghijk") },
		"ChangeAccountPerms": func() error { return st.ChangeAccountPerms("ada", map[string]bool{PermMusic: false}) },
	} {
		if err := write(); err == nil {
			t.Errorf("%s wrote over an account record that would not read", name)
		}

		if got := stored(accountsBucket, "ada"); got != unreadable {
			t.Fatalf("after %s the record is %q", name, got)
		}
	}

	trip := room.Trip([]byte("a key"), "an administrator")
	put(adminsBucket, trip)

	if err := st.UpdateAdmin(Admin{Trip: trip, Name: "andy", Can: []string{config.Moderate}}); err == nil {
		t.Error("UpdateAdmin wrote over an administrator's record that would not read")
	}

	if got := stored(adminsBucket, trip); got != unreadable {
		t.Errorf("after UpdateAdmin the record is %q", got)
	}
}
