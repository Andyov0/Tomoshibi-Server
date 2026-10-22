package store

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
Copies of the store, because the store is the only copy.

The comment at the top of this package used to say nothing here needs migrating
and none of it is authoritative, and that was true when it held a tally of which
names had been used. It is not true now. The administrators, the relay
definitions and everything measured about them, the accounts, the invitations
and the policy deciding who may open a room all live here and nowhere else. The
configuration file holds three fields of a relay's nineteen, and it is read once
on a store that has never been written to.

What settled that this was needed rather than merely prudent was measuring what
a damaged file actually does. A store truncated to nothing opens perfectly: no
error, no warning, three missing buckets and a service that starts, adopts the
three-field relays out of the configuration file, and goes on answering. Every
address a browser dials, every pair of machines known not to carry between them,
every account and every administrator gone, and the only evidence is that
somebody eventually says a meeting sounds bad. Half the fleet's routing is
knowledge that was measured by hand and cannot be derived from anything.

So: a copy a day, kept for a week, and a loud line at startup when the store
opens empty on a deployment that had something in it.
*/

// How many days of copies to keep.
//
// A week rather than a month, because the failures this is for are noticed in
// hours: a machine that will not start, or a management page that has forgotten
// its relays. The one it cannot help with is slow corruption nobody sees for a
// fortnight, and keeping thirty copies would not help with that either — it
// would keep thirty copies of the damage.
const kept = 7

// Backup writes a consistent copy of the store beside it, named for the day.
//
// Inside a read transaction, which is what makes it a copy of the store rather
// than of the file: bbolt writes pages in place and a plain file copy taken
// mid-write is a file with two half-written pages in it. A reader sees a
// snapshot, and CopyFile writes exactly what that reader sees.
//
// Named for the day rather than the moment, so a service restarting in a loop
// writes one copy rather than one per restart. The cost is that a second copy
// on the same day replaces the first, which is the right way round: the newest
// copy of today is the one worth having.
func (s *Store) Backup(beside string) (string, error) {
	// A store with nothing in it is not copied.
	//
	// Found by watching this destroy the thing it exists to protect. A copy is
	// named for the day and replaces an earlier one from the same day, so a
	// deployment whose store was truncated in the morning took a copy of the
	// empty store in the afternoon and wrote it over the copy of the full one.
	// The single most valuable file on the machine, overwritten by the routine
	// whose whole purpose is to be holding it.
	//
	// There is no case where copying an empty store is worth anything. A first
	// start has nothing to lose and the copy would hold nothing; every other
	// time, it is the loss being copied over the last record of what was lost.
	empty, err := s.Empty()
	if err != nil {
		return "", err
	}
	if empty {
		return "", errors.New("the store holds nothing, so a copy of it would hold nothing " +
			"and would replace today's copy of a store that did")
	}

	dir := filepath.Dir(beside)
	name := filepath.Base(beside)

	at := filepath.Join(dir, fmt.Sprintf("%s.%s", name, time.Now().UTC().Format("2006-01-02")))

	// Written to a neighbour and renamed. A copy interrupted half way through is
	// a file that looks like a backup and is not, and the day somebody reaches
	// for it is not the day to find that out.
	temporary := at + ".part"

	if err := s.db.View(func(tx *bolt.Tx) error {
		return tx.CopyFile(temporary, 0o600)
	}); err != nil {
		os.Remove(temporary)

		return "", fmt.Errorf("copy the store to %s: %w", temporary, err)
	}

	if err := os.Rename(temporary, at); err != nil {
		os.Remove(temporary)

		return "", fmt.Errorf("put the copy in place at %s: %w", at, err)
	}

	return at, nil
}

// Sweep removes copies older than the newest [kept] of them.
//
// By count rather than by age. A deployment that was switched off for a month
// comes back to seven copies from before it was switched off, which is what
// somebody wants; deleting by age would greet it with none.
func Sweep(beside string) (int, error) {
	dir := filepath.Dir(beside)
	prefix := filepath.Base(beside) + "."

	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", dir, err)
	}

	var copies []string
	for _, entry := range entries {
		name := entry.Name()

		// The date suffix and nothing else, so a half-written copy and anything
		// else somebody put beside the store are both left alone.
		if !strings.HasPrefix(name, prefix) {
			continue
		}

		if _, err := time.Parse("2006-01-02", strings.TrimPrefix(name, prefix)); err != nil {
			continue
		}

		copies = append(copies, name)
	}

	// The names sort as the dates do, which is the whole reason for that format.
	sort.Strings(copies)

	if len(copies) <= kept {
		return 0, nil
	}

	removed := 0
	for _, name := range copies[:len(copies)-kept] {
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			slog.Warn("could not remove an old copy of the store", "file", name, "error", err)
			continue
		}

		removed++
	}

	return removed, nil
}

// Empty reports whether the store holds nothing at all.
//
// Used at startup to tell a first run from a store that has been emptied. The
// two look identical to everything else here — bolt opens a truncated file
// without complaint and reports no buckets — and they call for opposite
// reactions: one is a deployment being set up and the other is a deployment
// that has just lost every relay it knew about.
func (s *Store) Empty() (bool, error) {
	empty := true

	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.ForEach(func([]byte, *bolt.Bucket) error {
			empty = false

			return nil
		})
	})
	if err != nil {
		return false, fmt.Errorf("look at the store: %w", err)
	}

	return empty, nil
}

// Copies lists the copies beside the store, newest first.
func Copies(beside string) ([]string, error) {
	dir := filepath.Dir(beside)
	prefix := filepath.Base(beside) + "."

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", dir, err)
	}

	var found []string
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}

		if _, err := time.Parse("2006-01-02", strings.TrimPrefix(name, prefix)); err != nil {
			continue
		}

		found = append(found, filepath.Join(dir, name))
	}

	sort.Sort(sort.Reverse(sort.StringSlice(found)))

	return found, nil
}
