package store

import (
	"errors"
	"testing"
	"time"
)

/*
What an arranged meeting has to guarantee, and the ways it was going to get it
wrong.

The link is a bearer token and the record is kept against its hash, like an
invite. But unlike an invite it is not redeemed at a door: it answers whether
the meeting has begun, and only its host can make that answer yes. So the
things worth testing are the two directions of that: the host can, and nobody
else can — including somebody who holds the link, which is everybody invited.

And a host who asks twice is not an error. Browsers reconnect, people rejoin,
and a meeting that could only be started once would refuse its own host the
second time they came through the door.
*/
func TestOnlyTheHostBeginsAMeetingAndMayDoSoTwice(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()

	if err := st.Arrange("tok-standup", Meeting{
		ID: "m1", Room: "Standup", At: now.Add(30 * time.Minute), Held: "HK Gomami", Host: "hosttrip00",
	}, now); err != nil {
		t.Fatal(err)
	}

	read, err := st.Arranged("tok-standup")
	if err != nil {
		t.Fatal(err)
	}

	if read.Room != "standup" {
		t.Errorf("room = %q, want it lowered: a name is compared lowered everywhere else", read.Room)
	}

	if read.Begun() {
		t.Error("a meeting nobody has started reads as begun")
	}

	// Somebody with the link, which is everybody invited, cannot start it.
	if _, err := st.Begin("standup", "guesttrip0", "inv-guest", now); !errors.Is(err, ErrNotTheHost) {
		t.Errorf("a stranger starting the meeting got %v, want %v", err, ErrNotTheHost)
	}

	// And an empty signature is nobody, not everybody.
	if _, err := st.Begin("standup", "", "inv-nobody", now); !errors.Is(err, ErrNotTheHost) {
		t.Errorf("no signature at all got %v, want %v", err, ErrNotTheHost)
	}

	started, err := st.Begin("standup", "hosttrip00", "inv-first", now)
	if err != nil {
		t.Fatal(err)
	}

	if !started.Begun() || !started.Started.Equal(now) {
		t.Errorf("begun at %v, want %v", started.Started, now)
	}

	if started.Invite != "inv-first" {
		t.Errorf("the call that began it was handed back %q, want the invite it brought", started.Invite)
	}

	// Again, later, with a different invite in hand. The first time stands,
	// and so does the first invite: everybody already holding it must go on
	// being let in by it.
	again, err := st.Begin("standup", "hosttrip00", "inv-second", now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}

	if !again.Started.Equal(now) {
		t.Errorf("a second start moved the time to %v; the first, %v, is when it began", again.Started, now)
	}

	if again.Invite != "inv-first" {
		t.Errorf("a second start replaced the invite with %q; the one everybody holds is inv-first", again.Invite)
	}

	if _, err := st.Begin("retro", "hosttrip00", "inv-x", now); !errors.Is(err, ErrNoSuchMeeting) {
		t.Errorf("a room with no meeting got %v, want %v", err, ErrNoSuchMeeting)
	}
}

/*
A join outside the window is not the meeting beginning early.

A host who uses a name every day and arranges Thursday's meeting on it must not
begin Thursday's meeting on Monday: the people holding Thursday's link would be
handed an invitation to Monday's call, and it would have expired before
Thursday came. So Monday's join finds nothing to begin, and a join an hour
before Thursday's time does.
*/
func TestAMeetingBeginsOnlyInsideItsWindow(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()
	thursday := now.Add(72 * time.Hour)

	if err := st.Arrange("tok-thu", Meeting{ID: "thu", Room: "standup", At: thursday, Host: "h"}, now); err != nil {
		t.Fatal(err)
	}

	if _, err := st.Begin("standup", "h", "inv-mon", now); !errors.Is(err, ErrNoSuchMeeting) {
		t.Errorf("a join three days early got %v, want %v: that is Monday's call, not Thursday's meeting", err, ErrNoSuchMeeting)
	}

	// Just too early.
	if _, err := st.Begin("standup", "h", "inv-early", thursday.Add(-BeginsFrom-time.Minute)); !errors.Is(err, ErrNoSuchMeeting) {
		t.Errorf("a join a minute before the window got %v, want %v", err, ErrNoSuchMeeting)
	}

	// Setting up early, which is the ordinary case.
	began, err := st.Begin("standup", "h", "inv-ok", thursday.Add(-BeginsFrom+time.Minute))
	if err != nil {
		t.Fatalf("a join inside the window: %v", err)
	}

	if !began.Begun() {
		t.Error("began inside the window and is not begun")
	}
}

/*
One name holds one pending meeting.

Two on the same name would be indistinguishable at the door and the window rule
would begin whichever was nearest, so the second is refused at the moment it is
arranged, when the person arranging it can pick another name. A name whose
meeting has begun, or been cancelled, is free again.
*/
func TestOneNameHoldsOnePendingMeeting(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()

	if err := st.Arrange("tok-a", Meeting{ID: "a", Room: "standup", At: now.Add(time.Hour), Host: "h"}, now); err != nil {
		t.Fatal(err)
	}

	if err := st.Arrange("tok-b", Meeting{ID: "b", Room: "standup", At: now.Add(48 * time.Hour), Host: "h"}, now); !errors.Is(err, ErrRoomArranged) {
		t.Errorf("a second meeting on the name got %v, want %v", err, ErrRoomArranged)
	}

	// Somebody else's name is somebody else's problem too.
	if err := st.Arrange("tok-c", Meeting{ID: "c", Room: "standup", At: now.Add(time.Hour), Host: "other"}, now); !errors.Is(err, ErrRoomArranged) {
		t.Errorf("another host arranging on the same name got %v, want %v", err, ErrRoomArranged)
	}

	if _, err := st.Cancel("a", "h"); err != nil {
		t.Fatal(err)
	}

	if err := st.Arrange("tok-b", Meeting{ID: "b", Room: "standup", At: now.Add(48 * time.Hour), Host: "h"}, now); err != nil {
		t.Errorf("after cancelling, the name is still taken: %v", err)
	}

	// A name the door would refuse is refused here, so a link is never handed
	// out for a room nobody can enter.
	if err := st.Arrange("tok-bad", Meeting{ID: "bad", Room: "Not A Room!", At: now.Add(time.Hour), Host: "h"}, now); err == nil {
		t.Error("a name with spaces and punctuation was accepted; the join would refuse it")
	}
}

/*
A host sees their own arrangements and nobody else's, soonest first, and can
cancel only their own. Cancelling answers what was dropped, because whoever
cancels has to withdraw the invitation a begun meeting handed out.
*/
func TestArrangementsAreTheHostsOwn(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()

	for _, one := range []struct {
		id, room, host string
		in             time.Duration
	}{
		{"a", "standup", "hostA", 5 * time.Hour},
		{"b", "retro", "hostA", time.Hour},
		{"c", "planning", "hostB", time.Hour},
	} {
		if err := st.Arrange("tok-"+one.id, Meeting{ID: one.id, Room: one.room, At: now.Add(one.in), Host: one.host}, now); err != nil {
			t.Fatal(err)
		}
	}

	mine := st.Arrangements("hostA", now)
	if len(mine) != 2 {
		t.Fatalf("hostA sees %d arrangements, want 2", len(mine))
	}

	if mine[0].ID != "b" {
		t.Errorf("first listed is %q, want the soonest, b", mine[0].ID)
	}

	if got := st.Arrangements("hostB", now); len(got) != 1 {
		t.Errorf("hostB sees %d arrangements, want 1", len(got))
	}

	if got := st.Arrangements("nobody", now); len(got) != 0 {
		t.Errorf("a stranger sees %d arrangements, want none", len(got))
	}

	if got := st.Arrangements("", now); len(got) != 0 {
		t.Errorf("no signature sees %d arrangements, want none: empty is nobody", len(got))
	}

	if _, err := st.Cancel("a", "hostB"); !errors.Is(err, ErrNoSuchMeeting) {
		t.Errorf("hostB cancelling hostA's meeting got %v, want %v", err, ErrNoSuchMeeting)
	}

	dropped, err := st.Cancel("a", "hostA")
	if err != nil {
		t.Fatal(err)
	}

	if dropped.Room != "standup" {
		t.Errorf("cancel answered %q, want the record that was dropped", dropped.Room)
	}

	if got := st.Arrangements("hostA", now); len(got) != 1 {
		t.Errorf("after cancelling one, hostA sees %d, want 1", len(got))
	}
}

/*
Ending a meeting is a fact the link has to be able to report, and it frees the
name for the next one.
*/
func TestEndingAMeetingIsRememberedAndFreesTheName(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()

	if err := st.Arrange("tok-e", Meeting{ID: "e", Room: "standup", At: now, Host: "h"}, now); err != nil {
		t.Fatal(err)
	}

	if _, err := st.Begin("standup", "h", "inv", now); err != nil {
		t.Fatal(err)
	}

	if _, ok := st.ArrangedFor("standup", now); !ok {
		t.Error("a begun meeting is not found for its room")
	}

	if err := st.End("standup", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	ended, err := st.Arranged("tok-e")
	if err != nil {
		t.Fatal(err)
	}

	if !ended.Over() {
		t.Error("ended, and does not say so")
	}

	if _, ok := st.ArrangedFor("standup", now.Add(time.Hour)); ok {
		t.Error("an ended meeting still answers for its room")
	}

	if err := st.Arrange("tok-f", Meeting{ID: "f", Room: "standup", At: now.Add(2 * time.Hour), Host: "h"}, now.Add(time.Hour)); err != nil {
		t.Errorf("the name is not free after its meeting ended: %v", err)
	}

	// Ending a room with no meeting is nothing, not an error: most rooms have
	// none.
	if err := st.End("retro", now); err != nil {
		t.Errorf("ending a room with no meeting: %v", err)
	}
}

/*
The sweep counts from the later of when it was meant to start and when it did.

A meeting that began late must not be swept out from under the people in it
because its planned time is old; and one that never began must go eventually,
or a store fills with meetings nobody came to.
*/
func TestMeetingsAreSweptFromWhenTheyLastMattered(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()

	arrange := func(id string, at, started time.Time) {
		t.Helper()

		if err := st.Arrange("tok-"+id, Meeting{ID: id, Room: id, At: at, Host: "h", Started: started}, at.Add(-time.Hour)); err != nil {
			t.Fatal(err)
		}
	}

	// Planned two days ago, never started: gone.
	arrange("forgotten", now.Add(-48*time.Hour), time.Time{})
	// Planned two days ago, but started an hour ago: still going.
	arrange("late", now.Add(-48*time.Hour), now.Add(-time.Hour))
	// Planned for tomorrow: not yet.
	arrange("tomorrow", now.Add(24*time.Hour), time.Time{})

	gone, err := st.SweepMeetings(now)
	if err != nil {
		t.Fatal(err)
	}

	if gone != 1 {
		t.Errorf("swept %d, want 1: only the meeting nobody came to", gone)
	}

	left := st.Arrangements("h", now)
	if len(left) != 2 {
		t.Fatalf("%d left, want 2", len(left))
	}

	for _, one := range left {
		if one.ID == "forgotten" {
			t.Error("the meeting nobody came to is still here")
		}
	}
}

/*
The token in a link is derived from the id and the key, so a host can be shown
their link again without the store holding it, and nobody without the key can
turn a public id into a working link.
*/
func TestTheLinkIsDerivedFromTheIdAndTheKey(t *testing.T) {
	key := []byte("a tripcode key")

	one := MeetingToken(key, "m1")
	if one != MeetingToken(key, "m1") {
		t.Error("the same id under the same key gave two tokens; the link would change every time it was shown")
	}

	if one == MeetingToken(key, "m2") {
		t.Error("two ids gave one token")
	}

	if one == MeetingToken([]byte("another key"), "m1") {
		t.Error("two keys gave one token; a public id would be a working link on every deployment")
	}

	if len(one) < 24 {
		t.Errorf("token is %d characters, too short to be unguessable", len(one))
	}
}

/*
Yesterday's meeting that nobody closed does not stop today's.

A host who leaves without ending the meeting leaves a record that is begun and
not over for a day. Today's arrangement on the same name is allowed — only a
pending meeting holds a name — and when the host walks in, it is today's that
begins. The first version picked whichever record the walk met last, which is
the order of token hashes, and so began yesterday's about half the time; and
closing the room ended only one of the two.
*/
func TestYesterdaysUnclosedMeetingDoesNotBlockTodays(t *testing.T) {
	st := open(t)
	now := time.Now().UTC()
	yesterday := now.Add(-23 * time.Hour)

	if err := st.Arrange("tok-y", Meeting{ID: "y", Room: "standup", At: yesterday, Host: "h"}, yesterday.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	if _, err := st.Begin("standup", "h", "inv-y", yesterday); err != nil {
		t.Fatal(err)
	}

	// Still "going" as far as the store can tell: begun, not ended, not a day
	// old yet. That is the record that used to get in the way.
	if err := st.Arrange("tok-t", Meeting{ID: "t", Room: "standup", At: now.Add(10 * time.Minute), Host: "h"}, now); err != nil {
		t.Fatalf("today's meeting could not be arranged beside yesterday's un-closed one: %v", err)
	}

	if found, ok := st.ArrangedFor("standup", now); !ok || found.ID != "t" {
		t.Errorf("the room's meeting is %q, want today's (t): the one still to come wins", found.ID)
	}

	began, err := st.Begin("standup", "h", "inv-t", now)
	if err != nil {
		t.Fatal(err)
	}

	if began.ID != "t" || !began.Started.Equal(now) || began.Invite != "inv-t" {
		t.Errorf("began %+v; want today's, begun now, with today's invite", began)
	}

	if err := st.End("standup", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	for _, tok := range []string{"tok-y", "tok-t"} {
		m, err := st.Arranged(tok)
		if err != nil {
			t.Fatal(err)
		}

		if !m.Over() {
			t.Errorf("%s is not ended; closing the room closes every meeting under way on the name", m.ID)
		}
	}
}
