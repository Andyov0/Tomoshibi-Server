// Package logring keeps the process's most recent log lines in memory, so the
// management pages can show what the server has been saying.
//
// The owner asked (2026-08-20) for the audit and runtime pages to become one
// log, more readable, because "when things go wrong the admin panel won't even
// open". The audit page had been removed on the argument that a buffer inside
// the process is readable exactly when the process is answering — which is
// true, and is not the whole of it. What fails is rarely the whole process:
// it is the store, a relay, the media server, a gateway. The page that most
// needs to open while one of those is failing is the one that says which, and
// it can only open if it asks nothing of any of them. So this asks nothing of
// anything: it is a slice in memory behind a lock, filled by the same handler
// that writes the process log, and the process log stays the durable record —
// it survives a restart and can be read with the service down, which this
// cannot and does not try to.
//
// Only this server's own lines are here. The embedded media server logs
// through its own logger to the same output, and is not copied; its lines are
// many, mostly about packets, and are read where they always were.
package logring

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Line is one record, as the page shows it.
type Line struct {
	// Seq numbers every line this process has kept, so a page can ask for what
	// came after the last one it has, and tell when lines it never saw were
	// pushed out before it asked.
	Seq     uint64    `json:"seq"`
	At      time.Time `json:"at"`
	Level   string    `json:"level"`
	Message string    `json:"message"`
	Attrs   []Attr    `json:"attrs,omitempty"`
}

// Attr is one key and its value, flattened to text.
type Attr struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Ring holds the most recent lines, the oldest giving way to the newest.
type Ring struct {
	mu    sync.Mutex
	lines []Line
	next  int
	full  bool
	seq   uint64
}

// New makes a ring holding at most size lines.
func New(size int) *Ring {
	if size <= 0 {
		size = 1
	}

	return &Ring{lines: make([]Line, size)}
}

// Recent is the ring the process log is copied into, and the one the
// management pages read. A package variable for the reason admin.Started is
// one: the handler is installed in main before anything that could be handed
// a ring has been built.
var Recent = New(2000)

func (r *Ring) add(line Line) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.seq++
	line.Seq = r.seq

	r.lines[r.next] = line
	r.next = (r.next + 1) % len(r.lines)
	if r.next == 0 {
		r.full = true
	}
}

// After returns the lines numbered above after, oldest first, at most limit of
// them — the newest limit, where there are more — and whether any line after
// it has already been pushed out, which a page should say rather than show a
// gap as though nothing happened in it.
func (r *Ring) After(after uint64, limit int) (lines []Line, missed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	held := r.ordered()
	if len(held) > 0 && held[0].Seq > after+1 && after < r.seq {
		missed = true
	}

	for _, line := range held {
		if line.Seq > after {
			lines = append(lines, line)
		}
	}

	if limit > 0 && len(lines) > limit {
		lines = lines[len(lines)-limit:]
		missed = true
	}

	return lines, missed
}

func (r *Ring) ordered() []Line {
	if !r.full {
		return append([]Line(nil), r.lines[:r.next]...)
	}

	return append(append([]Line(nil), r.lines[r.next:]...), r.lines[:r.next]...)
}

// Handler wraps inner so that every record it writes is also kept here. What
// inner would not write — below its level — is not kept either, so the page
// shows the log the deployment chose to have and not a louder one.
func (r *Ring) Handler(inner slog.Handler) slog.Handler {
	return &handler{inner: inner, ring: r}
}

type handler struct {
	inner slog.Handler
	ring  *Ring
	attrs []Attr
	group string
}

func (h *handler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *handler) Handle(ctx context.Context, record slog.Record) error {
	line := Line{
		At:      record.Time.UTC(),
		Level:   strings.ToLower(record.Level.String()),
		Message: record.Message,
		Attrs:   append([]Attr(nil), h.attrs...),
	}

	record.Attrs(func(attr slog.Attr) bool {
		line.Attrs = flatten(line.Attrs, h.group, attr)
		return true
	})

	h.ring.add(line)

	return h.inner.Handle(ctx, record)
}

func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	kept := append([]Attr(nil), h.attrs...)
	for _, attr := range attrs {
		kept = flatten(kept, h.group, attr)
	}

	return &handler{inner: h.inner.WithAttrs(attrs), ring: h.ring, attrs: kept, group: h.group}
}

func (h *handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}

	return &handler{inner: h.inner.WithGroup(name), ring: h.ring, attrs: h.attrs, group: h.group + name + "."}
}

// A value is cut at this many bytes. A line is for reading on a page, and an
// error that quotes a whole response body is the one that pushes forty other
// lines out of the ring.
const longest = 600

// hidden are keys whose values the page is never shown, whatever logged them.
// Nothing here logs a secret on purpose; this is what keeps one logged by
// mistake from becoming a secret on a web page, where the process log on a
// machine somebody has to log in to read was a smaller audience.
var hidden = regexp.MustCompile(`(?i)secret|passphrase|password|token|credential|private`)

func flatten(into []Attr, prefix string, attr slog.Attr) []Attr {
	attr.Value = attr.Value.Resolve()
	key := prefix + attr.Key

	if attr.Value.Kind() == slog.KindGroup {
		inner := key + "."
		if attr.Key == "" {
			inner = prefix
		}

		for _, one := range attr.Value.Group() {
			into = flatten(into, inner, one)
		}

		return into
	}

	if attr.Key == "" {
		return into
	}

	value := attr.Value.String()
	if hidden.MatchString(key) {
		value = "[hidden]"
	}
	if len(value) > longest {
		value = strings.ToValidUTF8(value[:longest], "") + "…"
	}

	return append(into, Attr{Key: key, Value: value})
}
