package store

import (
	"testing"
	"time"
)

/*
 * Knocking, and what answering it does.
 *
 * A knock exists so that somebody who was told "we're on at four" and never got
 * the link is not simply refused. Admitting them mints an invite and nothing
 * else — the door already knows how to let in somebody holding one, and a
 * second way through it would be a second thing to keep correct.
 *
 * The two identifiers are the part worth testing. The store is keyed by the
 * hash of a token the knocker holds, so a listing cannot recover it — which is
 * why answering goes by a separate public id, and why a host is never handed
 * somebody else's secret in order to let them in.
 */
func TestAKnockIsAnsweredByItsIdAndReadByItsToken(t *testing.T) {
	st := open(t)

	now := time.Now().UTC()

	token, err := NewKnockToken()
	if err != nil {
		t.Fatal(err)
	}

	id, err := NewKnockID()
	if err != nil {
		t.Fatal(err)
	}

	if err := st.Knocked(token, Knock{
		ID: id, Room: "standup", Name: "Ada", State: Knocking, At: now,
	}); err != nil {
		t.Fatal(err)
	}

	waiting := st.Knocking("standup", now)
	if len(waiting) != 1 || waiting[0].ID != id {
		t.Fatalf("the room sees %d knocks, want one with the public id", len(waiting))
	}

	// The secret is not in the listing. A host answering does not need it and
	// must not be handed it.
	if waiting[0].Invite != "" {
		t.Error("a knock that nobody has answered carries an invite")
	}

	// Another room's door does not open with it.
	if _, err := st.Answered(id, "retro", Admitted, "an-invite", now); err == nil {
		t.Error("a knock at one door was answered from another")
	}

	if _, err := st.Answered(id, "standup", Admitted, "an-invite", now); err != nil {
		t.Fatal(err)
	}

	// The knocker reads their own answer by the token they kept.
	knock, err := st.AtTheDoor(token, now)
	if err != nil {
		t.Fatal(err)
	}

	if knock.State != Admitted || knock.Invite != "an-invite" {
		t.Errorf("the knocker was told %q with invite %q, want admitted and the invite",
			knock.State, knock.Invite)
	}

	// And it leaves the queue, so nobody is admitted twice by two people
	// pressing at once.
	if left := st.Knocking("standup", now); len(left) != 0 {
		t.Errorf("%d knocks still waiting after being answered", len(left))
	}
}

/*
 * A knock nobody answered stops being one.
 *
 * Somebody waits at a door for a minute or two and then does something else. A
 * list of knocks from the last hour is a list of people who are no longer
 * there, which is worse than an empty list because it invites somebody to admit
 * a stranger into a meeting that has moved on.
 */
func TestAKnockNobodyAnsweredStopsWaiting(t *testing.T) {
	st := open(t)

	now := time.Now().UTC()

	token, _ := NewKnockToken()
	id, _ := NewKnockID()

	if err := st.Knocked(token, Knock{
		ID: id, Room: "standup", Name: "Ada", State: Knocking, At: now.Add(-time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	if waiting := st.Knocking("standup", now); len(waiting) != 0 {
		t.Errorf("%d knocks from an hour ago are still at the door", len(waiting))
	}

	if _, err := st.AtTheDoor(token, now); err == nil {
		t.Error("a knock from an hour ago still reads as waiting")
	}

	gone, err := st.SweepKnocks(now)
	if err != nil {
		t.Fatal(err)
	}

	if gone != 1 {
		t.Errorf("the sweep took %d, want 1", gone)
	}
}
