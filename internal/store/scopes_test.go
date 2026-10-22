package store

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"tomoshibi/internal/room"
)

/*
 * A scope as the store keeps it: a tag on an account, written only in a form a
 * room name could carry, and going wherever the account goes.
 *
 * Who counts as a member is asked by the application, which alone knows who the
 * administrators are; what is kept here is the tag, and the links into a scoped
 * room that have to outlive a meeting.
 */

func TestAnAccountKeepsItsScopes(t *testing.T) {
	st := open(t)
	trip := room.Trip([]byte("key"), "ada's passphrase")

	if err := st.AddAccount(Account{Name: "ada", Trip: trip, Scopes: []string{"acme", "beta"}}); err != nil {
		t.Fatalf("AddAccount: %v", err)
	}

	read, _ := st.Account("ada")
	if !reflect.DeepEqual(read.Scopes, []string{"acme", "beta"}) {
		t.Errorf("scopes read back as %v", read.Scopes)
	}

	// Renamed, and the scopes go with the record rather than staying behind
	// under the old name for whoever takes it next.
	read.Name = "ada-l"
	if err := st.UpdateAccount("ada", read); err != nil {
		t.Fatalf("UpdateAccount: %v", err)
	}

	if renamed, _ := st.Account("ada-l"); !renamed.InScope("acme") {
		t.Error("a renamed account lost its scope")
	}

	if err := st.AddAccount(Account{Name: "ada", Trip: room.Trip([]byte("key"), "another")}); err != nil {
		t.Fatalf("AddAccount: %v", err)
	}

	if fresh, _ := st.Account("ada"); fresh.InScope("acme") {
		t.Error("an account given an old name inherited the scopes of whoever had it")
	}
}

func TestAScopeThatNoRoomCouldNameIsRefused(t *testing.T) {
	st := open(t)
	trip := room.Trip([]byte("key"), "ada's passphrase")

	for _, scope := range []string{"Acme", "ac me", "a@b", "-acme", ""} {
		err := st.AddAccount(Account{Name: "ada", Trip: trip, Scopes: []string{scope}})

		if !errors.Is(err, ErrAccountBadScope) {
			t.Errorf("scope %q: AddAccount = %v, want ErrAccountBadScope", scope, err)
		}
	}
}

// Said as an error rather than a no, because the door that asks fails closed
// and has to say which kind of refusal it made.
func TestAClosedStoreSaysItIsNotAnswering(t *testing.T) {
	st := open(t)

	if err := st.Answering(); err != nil {
		t.Fatalf("an open store is not answering: %v", err)
	}

	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	if err := st.Answering(); err == nil {
		t.Error("a closed store says it is answering")
	}
}

/*
 * Standing invitations: a name, a window, no ceiling, and a meeting ending that
 * does not take them.
 *
 * Every time is pinned to one instant rather than read from the clock, so a
 * window is tested against the moment it was written for and not against
 * however long the machine took to get there.
 */

var noon = time.Date(2026, time.March, 2, 12, 0, 0, 0, time.UTC)

func linked(t *testing.T, st *Store, invite Invite) string {
	t.Helper()

	token, err := NewInviteToken()
	if err != nil {
		t.Fatal(err)
	}

	if err := st.KeepInvite(token, invite); err != nil {
		t.Fatalf("KeepInvite: %v", err)
	}

	return token
}

// A zero end is a link for good, and the sweep has to read it that way. A
// comparison against the zero time would call every one of them expired and
// throw them away within the hour, which nobody would see until a client's
// link stopped working.
func TestALastingLinkIsNotSwept(t *testing.T) {
	st := open(t)

	lasting := linked(t, st, Invite{Room: "standup@acme", Created: noon.AddDate(-1, 0, 0)})
	spent := linked(t, st, Invite{Room: "standup", Created: noon.Add(-48 * time.Hour), Expires: noon.Add(-time.Hour)})

	gone, err := st.SweepInvites(noon)
	if err != nil {
		t.Fatalf("SweepInvites: %v", err)
	}

	if gone != 1 {
		t.Errorf("swept %d, want only the one that ran out", gone)
	}

	if _, ok := st.Invite(lasting); !ok {
		t.Error("a link with no end was swept")
	}

	if _, ok := st.Invite(spent); ok {
		t.Error("a link that ran out survived the sweep; the test above proves nothing")
	}
}

func TestALinkOpensAtItsTimeAndNotBefore(t *testing.T) {
	st := open(t)
	trip := room.Trip([]byte("key"), "ada")

	if err := st.AddAccount(Account{Name: "ada", Trip: trip, Scopes: []string{"acme"}}); err != nil {
		t.Fatal(err)
	}

	token := linked(t, st, Invite{
		Room: "standup@acme", By: trip, Created: noon,
		From: noon.Add(time.Hour), Expires: noon.Add(3 * time.Hour), Name: "Client",
	})

	if _, err := st.Redeem(token, "standup@acme", noon.Add(59*time.Minute)); !errors.Is(err, ErrInviteNotYet) {
		t.Errorf("a minute early: Redeem = %v, want ErrInviteNotYet", err)
	}

	invite, err := st.Redeem(token, "standup@acme", noon.Add(time.Hour))
	if err != nil {
		t.Fatalf("on the hour: Redeem = %v", err)
	}

	if invite.Name != "Client" {
		t.Errorf("redeemed as %q, want the name it was made for", invite.Name)
	}

	if _, err := st.Redeem(token, "standup@acme", noon.Add(3*time.Hour)); !errors.Is(err, ErrInviteExpired) {
		t.Errorf("at its end: Redeem = %v, want ErrInviteExpired", err)
	}
}

/*
 * Ending a meeting takes its links and leaves the standing ones; a revocation
 * takes both.
 *
 * Both halves asserted, because the easy versions of this each pass one of
 * them: dropping everything passes the revocation and kills next week's client
 * link whenever somebody ends this week's call, and sparing everything in a
 * scoped room passes the meeting and leaves a link made in the call working
 * after the host ended it.
 */
func TestEndingAMeetingSparesOnlyStandingLinks(t *testing.T) {
	st := open(t)

	meeting := linked(t, st, Invite{Room: "standup@acme", Created: noon, Expires: noon.Add(time.Hour)})
	standing := linked(t, st, Invite{Room: "standup@acme", Created: noon, Standing: true})

	if gone, err := st.DropInvites("standup@acme", false); err != nil || gone != 1 {
		t.Fatalf("ending the meeting dropped %d (%v), want the one made in it", gone, err)
	}

	if _, ok := st.Invite(meeting); ok {
		t.Error("ending the meeting left a link made in it working")
	}

	if _, ok := st.Invite(standing); !ok {
		t.Fatal("ending the meeting took a standing invitation")
	}

	if gone, err := st.DropInvites("standup@acme", true); err != nil || gone != 1 {
		t.Errorf("revoking dropped %d (%v), want the standing one", gone, err)
	}

	if _, ok := st.Invite(standing); ok {
		t.Error("revoking left a standing invitation working")
	}
}
