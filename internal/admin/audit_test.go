package admin

import (
	"context"
	"log/slog"
	"sync"
)

/*
Reading back what was actually written.

These assertions used to read a buffer the process kept beside the log, which
made them a test of the copy rather than of the record. The copy is gone and the
record is the process log, so this captures that and hands it back in the shape
the assertions want. It is a little more machinery than reading a slice, and it
is testing the thing that survives a restart rather than the thing that does
not.
*/

// kept is a slog handler that keeps every record it is given.
type kept struct {
	mu      sync.Mutex
	entries []Entry
	lines   []keptLine
}

// keptLine is a record as written: its level, its message and every attribute
// as text.
type keptLine struct {
	level   slog.Level
	message string
	attrs   map[string]string
}

func (k *kept) Enabled(context.Context, slog.Level) bool { return true }

func (k *kept) WithAttrs([]slog.Attr) slog.Handler { return k }

func (k *kept) WithGroup(string) slog.Handler { return k }

func (k *kept) Handle(_ context.Context, record slog.Record) error {
	entry := Entry{Failed: record.Level >= slog.LevelWarn}
	line := keptLine{level: record.Level, message: record.Message, attrs: map[string]string{}}

	record.Attrs(func(attr slog.Attr) bool {
		line.attrs[attr.Key] = attr.Value.String()

		switch attr.Key {
		case "action":
			entry.Action = attr.Value.String()
		case "trip":
			entry.Trip = attr.Value.String()
		case "name":
			entry.Name = attr.Value.String()
		case "room":
			entry.Room = attr.Value.String()
		case "target":
			entry.Target = attr.Value.String()
		case "reason":
			entry.Reason = attr.Value.String()
		case "change":
			entry.Change = attr.Value.String()
		}

		return true
	})

	k.mu.Lock()
	defer k.mu.Unlock()

	k.entries = append(k.entries, entry)
	k.lines = append(k.lines, line)

	return nil
}

// written is every record kept so far, as written.
func (k *kept) written() []keptLine {
	k.mu.Lock()
	defer k.mu.Unlock()

	return append([]keptLine(nil), k.lines...)
}

// recorded is everything kept so far.
func (k *kept) recorded() []Entry {
	k.mu.Lock()
	defer k.mu.Unlock()

	return append([]Entry(nil), k.entries...)
}

// auditing gives a Log that writes where the test can read it.
func auditing() (*Log, *kept) {
	held := &kept{}

	return &Log{to: slog.New(held)}, held
}
