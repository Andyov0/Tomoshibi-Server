package app

import (
	"log/slog"
	"time"

	"tomoshibi/internal/store"
)

/*
Keeping copies of the one file everything is remembered in.

The store used to be a tally of which names had been used, and losing it cost a
count. It now holds the administrators, the relay definitions and everything
measured about them, the accounts, the invitations, and the policy deciding who
may open a room. The configuration file holds three fields of a relay's
nineteen and is read once, on a store that has never been written to, so it is
not a copy of any of this and cannot be made into one.

What makes losing it quiet rather than loud is what bolt does with a damaged
file. Measured, on the version this builds against: a store truncated to nothing
opens without an error, reports no buckets, and the service starts. The relay
list comes back with three fields per machine out of the configuration file, the
administrators come back if the file names any, and everything else — every
address a browser dials, every pair of machines known not to carry between them,
every measurement made by hand from a laptop in another country — is gone with
no line in any log to say so.

A copy a day, kept for a week, and a sentence at startup when the store opens
empty on a deployment whose configuration says it should not be.
*/

// How often a copy is taken.
//
// Daily, which is the granularity of the names. A shorter interval would write
// over the same file repeatedly and buy nothing; a longer one would mean a
// restore costs more than a day of enrolments and hand-measured routing.
const copyingEvery = 24 * time.Hour

// copying keeps a week of copies of the store, starting with one now.
//
// Now as well as on the tick, because the interval is a day: a machine
// restarted each night would otherwise never reach a tick and would have no
// copies at all, which is the deployment most in need of one.
func (a *App) copying() {
	ticker := time.NewTicker(copyingEvery)
	defer ticker.Stop()

	for {
		a.copy()

		select {
		case <-a.stop:
			return
		case <-ticker.C:
		}
	}
}

func (a *App) copy() {
	if a.store == nil || a.conf.Meet.Database == "" {
		return
	}

	at, err := a.store.Backup(a.conf.Meet.Database)
	if err != nil {
		// Loud, and not fatal. A deployment that cannot write a copy is a
		// deployment carrying calls, and stopping it to complain about a backup
		// would trade the thing being protected for the protection.
		slog.Error("could not copy the store, so there is nothing to restore from if it is lost",
			"store", a.conf.Meet.Database, "error", err)

		return
	}

	removed, err := store.Sweep(a.conf.Meet.Database)
	if err != nil {
		slog.Warn("could not tidy old copies of the store", "error", err)
	}

	slog.Info("copied the store", "to", at, "removed", removed)
}
