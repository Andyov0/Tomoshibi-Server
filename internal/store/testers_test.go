package store

import (
	"testing"
	"time"
)

/*
The count of invitations an account has made.

Two ways for it to be wrong without anything failing: an address written twice,
which spends two of an account's five on one person, and a passphrase change
that drops the record or overwrites another, which hands the account a fresh
allowance or takes somebody's away.
*/

func TestAnAddressIsCountedOnceHoweverItIsTyped(t *testing.T) {
	st := open(t)
	first := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

	if err := st.AddTester("aaaaabbbbb", Tester{Address: "Ada@Example.com", At: first}); err != nil {
		t.Fatal(err)
	}
	if err := st.AddTester("aaaaabbbbb", Tester{Address: " ada@example.com ", At: first.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}

	list, err := st.Testers("aaaaabbbbb")
	if err != nil {
		t.Fatal(err)
	}

	if len(list) != 1 || list[0].Address != "ada@example.com" || !list[0].At.Equal(first) {
		t.Errorf("one address typed two ways is recorded as %+v", list)
	}

	if other, _ := st.Testers("cccccddddd"); len(other) != 0 {
		t.Errorf("another account's record holds %+v", other)
	}
}

func TestARecordNeedsSomebodyAndSomething(t *testing.T) {
	st := open(t)

	if err := st.AddTester("", Tester{Address: "ada@example.com"}); err != ErrNoTester {
		t.Errorf("a record for nobody came to %v", err)
	}
	if err := st.AddTester("aaaaabbbbb", Tester{Address: "  "}); err != ErrNoTester {
		t.Errorf("a record of nothing came to %v", err)
	}
}

func TestInvitationsMoveWithAPassphraseAndMergeWithWhatIsThere(t *testing.T) {
	st := open(t)
	at := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

	for _, address := range []string{"one@example.com", "two@example.com"} {
		if err := st.AddTester("oldoldoldo", Tester{Address: address, At: at}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.AddTester("newnewnewn", Tester{Address: "two@example.com", At: at}); err != nil {
		t.Fatal(err)
	}

	if err := st.MoveTesters("oldoldoldo", "newnewnewn"); err != nil {
		t.Fatal(err)
	}

	if left, _ := st.Testers("oldoldoldo"); len(left) != 0 {
		t.Errorf("the old signature still holds %+v", left)
	}

	moved, _ := st.Testers("newnewnewn")
	if len(moved) != 2 {
		t.Errorf("after the move the new signature holds %+v, want the two addresses once each", moved)
	}

	// Nothing to move is not an error, and moving to oneself changes nothing.
	if err := st.MoveTesters("nobodyhere", "newnewnewn"); err != nil {
		t.Errorf("moving nothing came to %v", err)
	}
	if err := st.MoveTesters("newnewnewn", "newnewnewn"); err != nil {
		t.Errorf("moving to oneself came to %v", err)
	}
	if same, _ := st.Testers("newnewnewn"); len(same) != 2 {
		t.Errorf("a move to oneself left %+v", same)
	}
}
