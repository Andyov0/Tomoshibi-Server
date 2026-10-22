package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tomoshibi/internal/room"

	bolt "go.etcd.io/bbolt"
)

func open(t *testing.T) *Store {
	t.Helper()

	st, err := Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	return st
}

func TestAFirstJoinCreatesTheTally(t *testing.T) {
	tally, err := open(t).OpenRoom("standup", true)
	if err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	if tally.Joins != 1 {
		t.Errorf("joins = %d, want 1", tally.Joins)
	}
	if !tally.Created.Equal(tally.Seen) {
		t.Error("the first join should create and see at the same moment")
	}
}

func TestJoinsAccumulateAgainstOneName(t *testing.T) {
	st := open(t)

	first, err := st.OpenRoom("standup", true)
	if err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	second, err := st.OpenRoom("standup", true)
	if err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	if second.Joins != 2 {
		t.Errorf("joins = %d, want 2", second.Joins)
	}
	if !second.Created.Equal(first.Created) {
		t.Error("the creation time belongs to the name, not to the visit")
	}
}

func TestRoomsComeBackMostRecentFirst(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("older", true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}
	if _, err := st.OpenRoom("newer", true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	rooms, err := st.Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}

	if len(rooms) != 2 {
		t.Fatalf("listed %d rooms, want 2", len(rooms))
	}
	if rooms[0].Name != "newer" {
		t.Errorf("first room is %q, want newer", rooms[0].Name)
	}
}

// The bucket is created by the first write, so a store nothing has been written
// to lists nothing rather than failing.
func TestAnUntouchedStoreListsNothing(t *testing.T) {
	rooms, err := open(t).Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}

	if len(rooms) != 0 {
		t.Errorf("listed %d rooms, want none", len(rooms))
	}
}

/*
 * The gate, and the thing it rests on.
 *
 * "Opening a room" is not an operation anybody performs here, so there is no
 * created-at to compare against and no object whose existence could be checked.
 * There is a name, and the only fact about it is whether it has ever been used.
 * Everything below is about that one fact holding still while two people ask
 * about it at once.
 */

func TestAnUnusedNameIsRefusedToSomebodyWhoMayNotOpenOne(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", false); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("OpenRoom refused with %v, want ErrNotOpen", err)
	}

	// And left no trace, so that a refusal is not itself what opens the room
	// for whoever asks next.
	rooms, err := st.Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}
	if len(rooms) != 0 {
		t.Errorf("a refused name was written down anyway: %v", rooms)
	}
}

// The case the whole policy exists to leave alone. Once a name is in use it is
// nobody's to open again, so the question is never asked of it — a meeting in
// progress cannot be interrupted by this.
func TestANameInUseIsOpenToEverybody(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	tally, err := st.OpenRoom("standup", false)
	if err != nil {
		t.Fatalf("somebody was refused a room that was already open: %v", err)
	}
	if tally.Joins != 2 {
		t.Errorf("joins = %d, want 2", tally.Joins)
	}
}

/*
 * Two people arriving at a fresh name in the same instant.
 *
 * The reason the check and the tally are one transaction. Asked separately —
 * read, decide, write — every one of these would find nothing there and the
 * answer would come down to which of them the scheduler ran first. Here exactly
 * one opens the room and the rest are let in behind them, which is what anybody
 * would expect of a link sent to a group who all click it at once.
 */
func TestOnlyOneOfManyArrivalsOpensTheRoom(t *testing.T) {
	st := open(t)

	const arrivals = 64

	var (
		wg      sync.WaitGroup
		opened  atomic.Int64
		refused atomic.Int64
	)

	for i := 0; i < arrivals; i++ {
		// The first is the only one who may open it; everybody else is somebody
		// the policy would turn away from a name nobody had used.
		mayOpen := i == 0

		wg.Add(1)
		go func() {
			defer wg.Done()

			switch _, err := st.OpenRoom("standup", mayOpen); {
			case err == nil:
				opened.Add(1)
			case errors.Is(err, ErrNotOpen):
				refused.Add(1)
			default:
				t.Errorf("OpenRoom: %v", err)
			}
		}()
	}

	wg.Wait()

	// Everybody who arrived after the name was written down is in, and the
	// count of those turned away is however many got there first. What must not
	// happen is nobody getting in, or the tally losing a join it accepted.
	if opened.Load() < 1 {
		t.Fatal("nobody opened the room")
	}
	if opened.Load()+refused.Load() != arrivals {
		t.Fatalf("%d opened and %d refused, out of %d",
			opened.Load(), refused.Load(), arrivals)
	}

	rooms, err := st.Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}
	if len(rooms) != 1 {
		t.Fatalf("listed %d rooms, want 1", len(rooms))
	}

	// The tally is the other half of the same guarantee: a read-modify-write
	// that is not serialised loses increments long before it lets two people
	// open one name.
	if got := rooms[0].Room.Joins; got != uint64(opened.Load()) {
		t.Errorf("joins = %d, want %d", got, opened.Load())
	}
}

func TestAStoreNobodyHasChosenForLeavesRoomsToAnybody(t *testing.T) {
	if opening := open(t).Opening(); opening != room.ByAnyone {
		t.Errorf("opening = %q, want %q", opening, room.ByAnyone)
	}
}

func TestAChoiceOutlivesTheProcessThatMadeIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meet.db")

	first, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := first.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { second.Close() })

	if opening := second.Opening(); opening != room.ByAdmins {
		t.Errorf("opening = %q, want %q", opening, room.ByAdmins)
	}
}

func TestNothingThatIsNotAPolicyCanBeStored(t *testing.T) {
	st := open(t)

	if err := st.SetOpening("administrators"); err == nil {
		t.Fatal("SetOpening accepted something that is not a way of opening rooms")
	}
	if opening := st.Opening(); opening != room.ByAnyone {
		t.Errorf("a refused value was stored anyway: %q", opening)
	}
}

/*
 * The configuration file is where this starts and not where it lives.
 *
 * A file read on every boot would be able to undo a choice made from the
 * management pages, silently, on the next restart — and the person who made the
 * choice would have no way to tell, since the pages would go on showing what
 * they set until the process happened to stop.
 */
func TestTheConfiguredValueIsTakenOnlyWhereNothingWasChosen(t *testing.T) {
	st := open(t)

	opening, err := st.AdoptOpening(room.ByAdmins)
	if err != nil {
		t.Fatalf("AdoptOpening: %v", err)
	}
	if opening != room.ByAdmins {
		t.Fatalf("adopted %q on a fresh store, want %q", opening, room.ByAdmins)
	}

	if err := st.SetOpening(room.ByAnyone); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	// The restart, with the file still saying what it always said.
	opening, err = st.AdoptOpening(room.ByAdmins)
	if err != nil {
		t.Fatalf("AdoptOpening: %v", err)
	}
	if opening != room.ByAnyone {
		t.Errorf("the file undid a choice made from the management pages: %q", opening)
	}
}

/*
 * Ageing names out, and the two ways it could quietly do harm.
 *
 * A name is written down the first time somebody joins it and nothing ever took
 * one away, so the file grew for as long as anybody asked for names — bounded in
 * how fast by the rate limiter and in how many by nothing. Measured at four
 * hundred bytes apiece, which is the part that makes it worth a sweep rather
 * than a note in a README.
 *
 * The harm is that under a policy where a missing record is a closed door, every
 * one of these deletions is somebody being turned out of a room. So what these
 * check is not that the sweep works but that it is conservative in the two
 * places it could be reckless: a record whose age cannot be read, and a batch
 * that has to end somewhere.
 */

// aged writes a name whose last join was the given while ago.
func aged(t *testing.T, st *Store, name string, ago time.Duration) {
	t.Helper()

	if _, err := st.OpenRoom(name, true); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	err := st.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)

		var tally Room
		if err := json.Unmarshal(bucket.Get([]byte(name)), &tally); err != nil {
			return err
		}

		tally.Seen = time.Now().UTC().Add(-ago)

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})
	if err != nil {
		t.Fatalf("age %q: %v", name, err)
	}
}

func names(t *testing.T, st *Store) []string {
	t.Helper()

	found, err := st.Rooms()
	if err != nil {
		t.Fatalf("Rooms: %v", err)
	}

	var out []string
	for _, one := range found {
		out = append(out, one.Name)
	}
	sort.Strings(out)

	return out
}

func TestOnlyNamesNobodyHasJoinedSinceGoAway(t *testing.T) {
	st := open(t)

	aged(t, st, "ancient", 90*24*time.Hour)
	aged(t, st, "weekly", 3*24*time.Hour)

	gone, err := st.Forget(time.Now().Add(-30*24*time.Hour), 100)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if gone != 1 {
		t.Fatalf("forgot %d, want 1", gone)
	}

	if got := names(t, st); len(got) != 1 || got[0] != "weekly" {
		t.Errorf("left %v, want only weekly", got)
	}
}

// The whole point of the sweep, said as a property rather than a count: a room
// somebody keeps using is never aged out, however long the deployment runs.
func TestARoomInUseIsNeverForgotten(t *testing.T) {
	st := open(t)

	aged(t, st, "standup", 90*24*time.Hour)

	// Somebody joins it again, which is what a room in use looks like.
	if _, err := st.OpenRoom("standup", false); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	gone, err := st.Forget(time.Now().Add(-30*24*time.Hour), 100)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if gone != 0 {
		t.Errorf("forgot %d rooms, want none", gone)
	}
}

/*
 * bbolt admits one writer and a join is a write, so a sweep that cleared a
 * neglected bucket in one transaction would hold that writer for the whole of
 * it and everybody joining a call would wait behind it. The bound is what makes
 * that impossible; the caller comes back for the rest.
 */
func TestASweepStopsWhereItWasToldTo(t *testing.T) {
	st := open(t)

	for i := 0; i < 25; i++ {
		aged(t, st, fmt.Sprintf("old-%02d", i), 90*24*time.Hour)
	}

	since := time.Now().Add(-30 * 24 * time.Hour)

	gone, err := st.Forget(since, 10)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if gone != 10 {
		t.Fatalf("forgot %d in one pass, want the 10 it was allowed", gone)
	}
	if left := len(names(t, st)); left != 15 {
		t.Fatalf("%d names left, want 15", left)
	}

	// And the caller coming back finishes it.
	total := gone
	for {
		gone, err = st.Forget(since, 10)
		if err != nil {
			t.Fatalf("Forget: %v", err)
		}
		total += gone
		if gone < 10 {
			break
		}
	}

	if total != 25 {
		t.Errorf("forgot %d altogether, want 25", total)
	}
	if left := names(t, st); len(left) != 0 {
		t.Errorf("left %v", left)
	}
}

/*
 * A record this build cannot read has an age nobody knows. Under a policy where
 * a missing record is a closed door, deleting on an unknown age is the wrong way
 * to be wrong — so it stays, and stays readable to the one thing that still
 * understands it: the check for whether the name has been used at all.
 */
func TestARecordThatCannotBeReadIsLeftAlone(t *testing.T) {
	st := open(t)

	err := st.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(rooms)
		if err != nil {
			return err
		}

		return bucket.Put([]byte("from-a-later-build"), []byte("{ not a room"))
	})
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	gone, err := st.Forget(time.Now(), 100)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if gone != 0 {
		t.Fatalf("forgot %d, want none", gone)
	}

	// Still a name that has been used, which is what keeps its room open.
	if _, err := st.OpenRoom("from-a-later-build", false); err != nil {
		t.Errorf("a room whose record could not be read was closed: %v", err)
	}
}

/*
 * A sweep finds its names without holding the writer and removes them with it,
 * so a join can land in between. That join is somebody walking into the room,
 * and under the admins policy forgetting the name then would close the door on
 * the meeting they are starting.
 */
func TestANameJoinedDuringASweepIsKept(t *testing.T) {
	st := open(t)
	aged(t, st, "just-in-time", 90*24*time.Hour)

	since := time.Now().Add(-30 * 24 * time.Hour)

	found, err := st.stale(since, 10)
	if err != nil || len(found) != 1 {
		t.Fatalf("stale: found %d, %v; want the one aged name", len(found), err)
	}

	if _, err := st.OpenRoom("just-in-time", false); err != nil {
		t.Fatalf("OpenRoom: %v", err)
	}

	gone, err := st.drop(found, since)
	if err != nil {
		t.Fatalf("drop: %v", err)
	}
	if gone != 0 {
		t.Error("a name somebody had just joined was forgotten")
	}
	if _, err := st.OpenRoom("just-in-time", false); err != nil {
		t.Errorf("the room was closed on the person who had just opened it: %v", err)
	}
}

func TestForgettingNothingIsNotAnError(t *testing.T) {
	st := open(t)

	gone, err := st.Forget(time.Now(), 100)
	if err != nil {
		t.Fatalf("Forget on an untouched store: %v", err)
	}
	if gone != 0 {
		t.Errorf("forgot %d from an untouched store", gone)
	}
}

/*
A note about where a room is has to stop being believed.

It is written after a join so the next person lands where the meeting already
is, which saves them a measurement and is what lets somebody into a relay
reserved for the administrator who invited them. Left to itself it never
expired, and that turns a hint into a permanent binding: every room returns to
whichever relay it first landed on, for good, and choosing a server stops
meaning anything the second time a name is used.

There is no cheap way to ask whether anybody is still in the room — the media
server knows and asking it is a request to every relay on every join — so the
note ages out instead. Being wrong either way is survivable: too eager and
somebody is forwarded by the media server with only a measurement wasted, too
patient and a meeting that ended hours ago sends the next one back to a machine
it need not use. Lasting forever is the only outcome that is not.
*/

func TestWhereARoomIsHeldIsForgottenOnceItGoesQuiet(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	if err := st.HoldRoom("standup", "shanghai"); err != nil {
		t.Fatal(err)
	}

	if got, _ := st.HeldOn("standup"); got != "shanghai" {
		t.Fatalf("a room joined a moment ago is held on %q, wanted shanghai", got)
	}

	// Aged past the window by hand, because waiting two hours is not a test.
	if err := st.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)

		var tally Room
		if err := json.Unmarshal(bucket.Get([]byte("standup")), &tally); err != nil {
			return err
		}

		tally.HeldAt = time.Now().Add(-heldFor - time.Minute)

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte("standup"), encoded)
	}); err != nil {
		t.Fatal(err)
	}

	if got, _ := st.HeldOn("standup"); got != "" {
		t.Errorf("a room nobody has joined for hours is still held on %q; choosing a "+
			"server would never mean anything again", got)
	}
}

/*
 * A placement is not a guess and does not expire.
 *
 * The two records share a field and are not the same thing. A join leaves behind
 * where the meeting happened to be, which is worth believing for as long as the
 * meeting is plausibly still running and no longer — the test above is that. An
 * operator saying where a room goes is an instruction, and an instruction that
 * quietly stopped applying after two hours, or after being obeyed once, would be
 * this server overruling the person who runs it on a timer.
 *
 * It stood for exactly one join once: the join that carried it out cleared it,
 * so the room went to the chosen machine and every meeting of that name
 * afterwards went wherever the policy pointed. From the outside that is a
 * setting that works the first time and is ignored from then on.
 *
 * The cost is that a pin nobody remembers making is invisible, which is a real
 * cost and is paid on the page rather than by a clock: the rooms page marks a
 * placed room and offers to hand it back.
 */
func TestAPlacementOutlivesTheJoinThatObeysIt(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	if err := st.PlaceRoom("standup", "shanghai"); err != nil {
		t.Fatal(err)
	}

	// What a join leaves behind, written over the top. This is the ordinary
	// case: somebody arrives, the room is held where it was placed, and the
	// join records that — and it must not demote the instruction to a guess.
	if err := st.HoldRoom("standup", "shanghai"); err != nil {
		t.Fatal(err)
	}

	relay, placed := st.HeldOn("standup")
	if relay != "shanghai" || !placed {
		t.Fatalf("after one join the placement reads %q placed=%v, want shanghai and placed", relay, placed)
	}

	// And a join that landed somewhere else does not drag the placement with
	// it. This is the case the placement exists for — the join disagreeing —
	// and a record that kept the flag while taking the join's name would read
	// as an operator having chosen a machine they never chose.
	if err := st.HoldRoom("standup", "hongkong"); err != nil {
		t.Fatal(err)
	}

	if relay, placed := st.HeldOn("standup"); relay != "shanghai" || !placed {
		t.Fatalf("a join elsewhere moved the placement to %q placed=%v, want shanghai", relay, placed)
	}

	// Aged well past the window a guess would die in.
	if err := st.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)

		var tally Room
		if err := json.Unmarshal(bucket.Get([]byte("standup")), &tally); err != nil {
			return err
		}

		tally.HeldAt = time.Now().Add(-heldFor * 100)

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte("standup"), encoded)
	}); err != nil {
		t.Fatal(err)
	}

	relay, placed = st.HeldOn("standup")
	if relay != "shanghai" || !placed {
		t.Errorf("a placement aged by a week reads %q placed=%v; an operator's choice "+
			"is not something this server may forget on its own", relay, placed)
	}

	// And the one thing that does undo it, which is somebody saying so.
	if err := st.ReleaseRoom("standup"); err != nil {
		t.Fatal(err)
	}

	if relay, placed := st.HeldOn("standup"); relay != "" || placed {
		t.Errorf("a released room reads %q placed=%v, want nothing — a placement onto "+
			"nowhere is a record no caller can act on", relay, placed)
	}
}

/*
 * A placement does not outlive the room it is about.
 *
 * The test above is that an operator's choice is not aged out on a clock of its
 * own, and that is right: an expiry there would be the server overruling
 * somebody on a timer. But "not aged out" was read as "eternal", and it left a
 * name that had been used once sitting in the list for ever with a pin on it,
 * waiting to decide something about a meeting nobody was going to hold.
 *
 * What bounds it is the record it lives in. A name nobody has joined for
 * `rooms.remember` — three days — is forgotten whole, and the placement is part
 * of what is forgotten. A room in use keeps the machine it was given for as
 * long as it is in use, which is the whole of what the rule was for.
 */
func TestAPlacementIsForgottenWithTheRoom(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	if err := st.PlaceRoom("standup", "shanghai"); err != nil {
		t.Fatal(err)
	}

	if relay, placed := st.HeldOn("standup"); relay != "shanghai" || !placed {
		t.Fatalf("the placement did not take: %q placed=%v", relay, placed)
	}

	// Nobody has joined it for four days, against a retention of three.
	if err := st.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)

		var tally Room
		if err := json.Unmarshal(bucket.Get([]byte("standup")), &tally); err != nil {
			return err
		}

		tally.Seen = time.Now().Add(-4 * 24 * time.Hour)

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte("standup"), encoded)
	}); err != nil {
		t.Fatal(err)
	}

	gone, err := st.Forget(time.Now().Add(-3*24*time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}

	if gone != 1 {
		t.Fatalf("the sweep took %d rooms, want 1: a placed room is still a room nobody "+
			"has joined, and skipping it would keep the name for ever", gone)
	}

	if relay, placed := st.HeldOn("standup"); relay != "" || placed {
		t.Errorf("a room nobody has joined for four days still reads %q placed=%v; the pin "+
			"outlived the meeting it was about and sits in the list deciding nothing",
			relay, placed)
	}
}

/*
 * A history that was cut says how much of it there was.
 *
 * There is a ceiling, because this is drawn on a page and a name somebody has
 * been hammering has as many rows as the rate limiter allowed. A ceiling is
 * fine; a ceiling nobody is told about is not. Five hundred rows of a thousand,
 * with nothing saying so, reads as the whole history — which is the same fault
 * as a history that silently stopped at twelve hours, arrived at from the other
 * end.
 */
func TestAHistoryLongerThanTheCeilingSaysHowLongItWas(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	when := time.Now().UTC().Add(-time.Hour)
	for at := 0; at < 12; at++ {
		if err := st.Arrived("standup", fmt.Sprintf("t%010d-abc", at), Arrival{
			Name: "somebody", At: when.Add(time.Duration(at) * time.Second),
		}); err != nil {
			t.Fatal(err)
		}
	}

	found, total := st.Visits("standup", 5)

	if len(found) != 5 {
		t.Errorf("asked for five and got %d", len(found))
	}

	if total != 12 {
		t.Errorf("a history of twelve cut to five reported %d; a page cannot say what it "+
			"is not showing if it is never told", total)
	}

	// And a history inside the ceiling reports itself, so the page has nothing
	// to mention.
	if _, whole := st.Visits("standup", 50); whole != 12 {
		t.Errorf("a history of twelve reported %d when nothing was cut", whole)
	}
}

/*
 * Forgetting a name takes the history with it.
 *
 * The record holds three things and all three are the same fact from different
 * angles: that the name has been used, where an operator said it goes, and what
 * was seen of the people who were in it. Leaving any of them behind is leaving
 * the name half there — and the addresses are the half that must not outlive
 * the thing that referred to them.
 */
func TestForgettingARoomTakesEverythingWithIt(t *testing.T) {
	st := open(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	if err := st.PlaceRoom("standup", "shanghai"); err != nil {
		t.Fatal(err)
	}

	if err := st.Arrived("standup", "tabcdefghij-1", Arrival{
		Name: "somebody", Address: "198.51.100.4", At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	// A second room, to catch a prefix walk that takes more than it was asked
	// for — the arrivals are keyed by name and a careless scan would.
	if _, err := st.OpenRoom("standup-two", true); err != nil {
		t.Fatal(err)
	}

	if err := st.Arrived("standup-two", "tabcdefghij-1", Arrival{
		Name: "somebody", At: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	found, err := st.ForgetRoom("standup")
	if err != nil {
		t.Fatal(err)
	}

	if !found {
		t.Error("forgetting a room that was there reported nothing to forget")
	}

	if st.Used("standup") {
		t.Error("the name is still used after being forgotten")
	}

	if relay, placed := st.HeldOn("standup"); relay != "" || placed {
		t.Errorf("the placement outlived the name: %q placed=%v — which is the whole reason "+
			"somebody presses this, since a name nobody can remove keeps a machine assigned "+
			"to it until it ages out", relay, placed)
	}

	if visits, _ := st.Visits("standup", 50); len(visits) != 0 {
		t.Errorf("%d visits outlived the room; the addresses in them are kept for the room's "+
			"sake and for nothing else", len(visits))
	}

	// And the room beside it is untouched.
	if !st.Used("standup-two") {
		t.Error("forgetting one name forgot another whose name it is a prefix of")
	}

	if visits, _ := st.Visits("standup-two", 50); len(visits) != 1 {
		t.Errorf("the neighbour has %d visits, want 1", len(visits))
	}

	// Asked again, so a page can tell "done" from "that was already not there".
	if again, err := st.ForgetRoom("standup"); err != nil || again {
		t.Errorf("forgetting it twice reported %v (err %v), want false", again, err)
	}
}
