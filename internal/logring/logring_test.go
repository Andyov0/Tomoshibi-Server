package logring

import (
	"bytes"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

/*
The log the management pages show, and the ways it could quietly mislead.

A ring that drops the newest line rather than the oldest shows a log that
stopped at the moment something went wrong. One that copies records the
deployment's level would not write shows a louder log than the one on disk,
so the two disagree about what happened. A page asking for what came after the
last line it had must be told when lines it never saw were pushed out in
between, or it shows a gap as an hour in which nothing happened. And a value
logged under a key that names a secret must not reach a web page, whatever
logged it.
*/

func logger(ring *Ring, level slog.Level) (*slog.Logger, *bytes.Buffer) {
	var out bytes.Buffer
	inner := slog.NewTextHandler(&out, &slog.HandlerOptions{Level: level})

	return slog.New(ring.Handler(inner)), &out
}

func TestTheRingKeepsTheNewestLinesInOrder(t *testing.T) {
	ring := New(3)
	log, out := logger(ring, slog.LevelInfo)

	for i := 1; i <= 5; i++ {
		log.Info(fmt.Sprintf("line %d", i))
	}

	lines, missed := ring.After(0, 0)
	if len(lines) != 3 || lines[0].Message != "line 3" || lines[2].Message != "line 5" {
		t.Fatalf("kept %+v, want lines 3 to 5", lines)
	}
	if !missed {
		t.Error("lines 1 and 2 were pushed out, and the reader was not told")
	}

	// The process log itself is untouched by the copy.
	if !strings.Contains(out.String(), "line 1") {
		t.Errorf("the inner handler did not write: %q", out.String())
	}

	// After the last line seen, nothing missed and nothing new.
	if lines, missed := ring.After(5, 0); len(lines) != 0 || missed {
		t.Errorf("after the newest: %+v, missed %v", lines, missed)
	}

	// After line 3, lines 4 and 5 and nothing missed.
	if lines, missed := ring.After(3, 0); len(lines) != 2 || missed || lines[0].Seq != 4 {
		t.Errorf("after 3: %+v, missed %v", lines, missed)
	}

	// After line 1, line 2 has gone.
	if _, missed := ring.After(1, 0); !missed {
		t.Error("line 2 was pushed out before it was read, and the reader was not told")
	}
}

func TestTheRingKeepsOnlyWhatTheLogWrites(t *testing.T) {
	ring := New(10)
	log, _ := logger(ring, slog.LevelWarn)

	log.Info("ordinary")
	log.Warn("worth reading")

	lines, _ := ring.After(0, 0)
	if len(lines) != 1 || lines[0].Message != "worth reading" || lines[0].Level != "warn" {
		t.Fatalf("kept %+v, want the warning alone", lines)
	}
}

func TestTheRingSaysWhoAndWhatAndHidesSecrets(t *testing.T) {
	ring := New(10)
	log, _ := logger(ring, slog.LevelInfo)

	log.With("relay", "hk").WithGroup("join").Info("joined",
		"room", "standup",
		"enrolment secret", "s3cr3t",
		slog.Group("client", "kind", "iphone"),
		"passphrase", "hunter2",
	)

	lines, _ := ring.After(0, 0)
	if len(lines) != 1 {
		t.Fatalf("kept %d lines", len(lines))
	}

	got := map[string]string{}
	for _, attr := range lines[0].Attrs {
		got[attr.Key] = attr.Value
	}

	want := map[string]string{
		"relay":                 "hk",
		"join.room":             "standup",
		"join.enrolment secret": "[hidden]",
		"join.client.kind":      "iphone",
		"join.passphrase":       "[hidden]",
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("%s = %q, want %q (all: %v)", key, got[key], value, got)
		}
	}
}

func TestALimitKeepsTheNewest(t *testing.T) {
	ring := New(10)
	log, _ := logger(ring, slog.LevelInfo)

	for i := 1; i <= 6; i++ {
		log.Info(fmt.Sprintf("line %d", i))
	}

	lines, missed := ring.After(0, 2)
	if len(lines) != 2 || lines[1].Message != "line 6" || !missed {
		t.Fatalf("limited to %+v, missed %v; want lines 5 and 6, and the rest said to be missing", lines, missed)
	}
}
