package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/room"
)

/*
 * A backup that cannot be restored from is a file, not a backup.
 *
 * So the test that matters here is not that a file appeared. It is that the
 * file opens as a store and holds what the original held — which is the only
 * claim anybody will ever rely on, and the one a test asserting on os.Stat
 * would not make.
 *
 * The rest guard the counting. Copies are removed by count rather than by age,
 * because a deployment switched off for a month should come back to the seven
 * copies it had rather than to none, and a sweep written against the clock
 * would greet it with none.
 */

func filled(t *testing.T) (*Store, string) {
	t.Helper()

	path := filepath.Join(t.TempDir(), "meet.db")

	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	if err := st.AddRelay(Relay{
		Name: "hong-kong", URL: "wss://hk.example", Region: "hk",
		Turn: "hk.example:3478", Apart: []string{"shanghai"},
	}); err != nil {
		t.Fatalf("AddRelay: %v", err)
	}

	if err := st.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	return st, path
}

func TestACopyOpensAndHoldsWhatTheStoreHeld(t *testing.T) {
	st, path := filled(t)

	at, err := st.Backup(path)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}

	// Opened as a store rather than stat'd. Every fault this exists to survive
	// produces a file: a truncated one, a half-written one, a copy taken with
	// os.Copy while a page was being written. All of them pass a size check.
	restored, err := Open(at)
	if err != nil {
		t.Fatalf("the copy would not open: %v", err)
	}
	defer restored.Close()

	relays, err := restored.Relays()
	if err != nil {
		t.Fatalf("Relays: %v", err)
	}
	if len(relays) != 1 {
		t.Fatalf("the copy holds %d relays, want 1", len(relays))
	}

	// The fields the configuration file does not carry, which are the reason
	// any of this exists. A copy holding only the name, URL and region would be
	// a copy of what could be rebuilt anyway.
	if relays[0].Turn != "hk.example:3478" {
		t.Errorf("the copy lost the TURN address: %q", relays[0].Turn)
	}
	if len(relays[0].Apart) != 1 || relays[0].Apart[0] != "shanghai" {
		t.Errorf("the copy lost which relays cannot carry to which: %v", relays[0].Apart)
	}

	if opening := restored.Opening(); opening != room.ByAdmins {
		t.Errorf("the copy holds opening %q, want %q", opening, room.ByAdmins)
	}
}

func TestTheStoreGoesOnWorkingWhileItIsCopied(t *testing.T) {
	st, path := filled(t)

	if _, err := st.Backup(path); err != nil {
		t.Fatalf("Backup: %v", err)
	}

	// Written to afterwards, because a copy taken inside a read transaction
	// that forgot to end would leave the store locked and this would hang.
	if err := st.AddRelay(Relay{Name: "tokyo", URL: "wss://jp.example"}); err != nil {
		t.Fatalf("the store would not take a write after being copied: %v", err)
	}
}

func TestAnInterruptedCopyLeavesNothingBehind(t *testing.T) {
	st, path := filled(t)

	// A copy the store cannot write, because the directory it names does not
	// exist. What must not survive is the neighbour file: a half-written copy
	// under the name of a real one is worse than no copy, because it is found
	// on the day nothing else is left.
	if _, err := st.Backup(filepath.Join(path, "not-a-directory", "meet.db")); err == nil {
		t.Fatal("copying into a path that cannot exist was reported as working")
	}

	found, err := Copies(path)
	if err != nil {
		t.Fatalf("Copies: %v", err)
	}
	if len(found) != 0 {
		t.Errorf("a failed copy left %v behind", found)
	}
}

func TestOnlyTheOldestCopiesGo(t *testing.T) {
	_, path := filled(t)

	// Dated by hand, because the real ones are named for the day and a test
	// that waited for eight days would not be run.
	dir := filepath.Dir(path)
	day := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	for i := 0; i < kept+3; i++ {
		name := filepath.Join(dir, "meet.db."+day.AddDate(0, 0, i).Format("2006-01-02"))
		if err := os.WriteFile(name, []byte("a copy"), 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}

	// And two things that are not copies, which must be left where they are.
	for _, name := range []string{"meet.db.part", "meet.db.rotate-bak"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("not a copy"), 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}

	removed, err := Sweep(path)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if removed != 3 {
		t.Errorf("swept %d copies, want 3", removed)
	}

	found, err := Copies(path)
	if err != nil {
		t.Fatalf("Copies: %v", err)
	}
	if len(found) != kept {
		t.Fatalf("kept %d copies, want %d", len(found), kept)
	}

	// Newest first, and the oldest three are the ones that went.
	if !strings.HasSuffix(found[0], "2026-01-10") {
		t.Errorf("the newest copy is %q, want the tenth", found[0])
	}
	if !strings.HasSuffix(found[len(found)-1], "2026-01-04") {
		t.Errorf("the oldest kept copy is %q, want the fourth", found[len(found)-1])
	}

	for _, name := range []string{"meet.db.part", "meet.db.rotate-bak"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("the sweep removed %s, which is not a copy: %v", name, err)
		}
	}

	// The store itself, most of all.
	if _, err := os.Stat(path); err != nil {
		t.Errorf("the sweep removed the store: %v", err)
	}
}

func TestSweepingFewerThanAWeekRemovesNothing(t *testing.T) {
	st, path := filled(t)

	if _, err := st.Backup(path); err != nil {
		t.Fatalf("Backup: %v", err)
	}

	removed, err := Sweep(path)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if removed != 0 {
		t.Errorf("swept %d copies on a deployment with one, want 0", removed)
	}
}

// The signal that tells a store which has been emptied from one which was never
// filled, and the reason it is needed: bolt reports neither as an error.
func TestAnEmptiedStoreIsRecognisable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "meet.db")

	st, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	empty, err := st.Empty()
	if err != nil {
		t.Fatalf("Empty: %v", err)
	}
	if !empty {
		t.Error("a store nothing has been written to did not report itself empty")
	}

	if err := st.AddRelay(Relay{Name: "hong-kong", URL: "wss://hk.example"}); err != nil {
		t.Fatalf("AddRelay: %v", err)
	}

	empty, err = st.Empty()
	if err != nil {
		t.Fatalf("Empty: %v", err)
	}
	if empty {
		t.Error("a store with a relay in it reported itself empty")
	}

	st.Close()

	// And the case this is really about, measured rather than assumed: a store
	// truncated to nothing opens without an error and reports no buckets, which
	// is why nothing else in this deployment can tell it from a first run.
	if err := os.Truncate(path, 0); err != nil {
		t.Fatalf("Truncate: %v", err)
	}

	damaged, err := Open(path)
	if err != nil {
		t.Skipf("a truncated store no longer opens, which is a better world: %v", err)
	}
	defer damaged.Close()

	empty, err = damaged.Empty()
	if err != nil {
		t.Fatalf("Empty: %v", err)
	}
	if !empty {
		t.Error("a truncated store did not report itself empty")
	}
}

// The copy that ate the thing it was keeping.
//
// Found by running this against a real deployment rather than by reasoning
// about it: the store was truncated, the service restarted, and the daily copy
// wrote an empty file over the copy of the full store taken that morning. A
// copy is named for the day, so it replaces the day's earlier one, and the
// routine whose entire purpose is to be holding the last good state overwrote
// it with the loss.
func TestAnEmptyStoreIsNotCopiedOverAGoodOne(t *testing.T) {
	st, path := filled(t)

	at, err := st.Backup(path)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}

	before, err := os.ReadFile(at)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	st.Close()

	if err := os.Truncate(path, 0); err != nil {
		t.Fatalf("Truncate: %v", err)
	}

	damaged, err := Open(path)
	if err != nil {
		t.Skipf("a truncated store no longer opens, which is a better world: %v", err)
	}
	defer damaged.Close()

	if _, err := damaged.Backup(path); err == nil {
		t.Error("copying a store with nothing in it was reported as working")
	}

	after, err := os.ReadFile(at)
	if err != nil {
		t.Fatalf("the copy is gone: %v", err)
	}

	if len(after) != len(before) {
		t.Errorf("the copy was replaced: %d bytes, was %d", len(after), len(before))
	}
}
