package admin

import (
	"log/slog"
)

/*
What an administrator did, and where it is written down.

For a long time this held two records of the same thing: five hundred entries in
memory for a page to show, and a line in the process log. The page was removed,
and what it was showing turns out to be the half that mattered less. A buffer in
the process being audited is readable exactly when that process is answering
requests — which is to say, never at the moment somebody most wants it, and the
management pages that displayed it are behind the same door as everything else.
The process log survives a restart, can be read over ssh with the service down,
and can be shipped somewhere the holder of this server cannot reach.

So there is one record now, and it is the durable one.
*/

// An Entry is one thing an administrator did.
type Entry struct {
	// Who did it, by the signature that authorised them. A name can be changed
	// in a configuration file; the signature is what was proved.
	Trip string
	Name string
	// What they did, and to what.
	Action string
	Room   string
	Target string
	// Change is what was changed, where the action alone does not say. Most
	// actions are their own description; giving somebody a scope is not, and a
	// record reading "change account" for it would be one nobody could answer
	// "who gave them that" from.
	Change string
	// Whether it worked. A refusal is worth as much as a success here: a run of
	// them is the only sign anybody has that somebody is trying doors.
	Failed bool
	Reason string
}

// Log writes the administrative record.
type Log struct {
	// Where the record goes, or the default logger when nothing was said.
	//
	// A field rather than a call to slog directly, so a test can read what was
	// actually written instead of reading a copy kept for its benefit. The
	// copy is what used to be tested, and a copy is not the record.
	to *slog.Logger
}

func NewLog() *Log { return &Log{} }

// Record notes something in the process log.
func (l *Log) Record(entry Entry) {
	attrs := []any{"action", entry.Action, "trip", entry.Trip}

	if entry.Name != "" {
		attrs = append(attrs, "name", entry.Name)
	}
	if entry.Room != "" {
		attrs = append(attrs, "room", entry.Room)
	}
	if entry.Target != "" {
		attrs = append(attrs, "target", entry.Target)
	}
	if entry.Change != "" {
		attrs = append(attrs, "change", entry.Change)
	}

	to := l.to
	if to == nil {
		to = slog.Default()
	}

	// Warn rather than Info for a refusal, so that the one query worth having
	// standing — anything above Info from this service — surfaces somebody
	// trying doors without also surfacing every ordinary day.
	if entry.Failed {
		attrs = append(attrs, "reason", entry.Reason)
		to.Warn("an administrative action was refused", attrs...)

		return
	}

	to.Info("an administrative action was taken", attrs...)
}
