package rtc

import (
	"context"
	"log/slog"
	"testing"

	"github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/protocol/logger"
)

// Starting the media server's logger must not take the standard library's
// default with it. It did, and with it the handler that copies every line
// into the ring the management log page reads, so on a full deployment that
// page went quiet the moment the media server started.
func TestTheMediaServersLoggerLeavesTheProcesssOwn(t *testing.T) {
	before := slog.Default()
	t.Cleanup(func() { slog.SetDefault(before) })

	seen := &counting{}
	ours := slog.New(seen)
	slog.SetDefault(ours)

	startLogging(&config.LoggingConfig{Config: logger.Config{Level: "info"}})

	if slog.Default() != ours {
		t.Fatal("the standard library's default logger was replaced by the media server's")
	}

	slog.Info("a line the management log page should see")
	if seen.lines != 1 {
		t.Errorf("%d lines reached the process's own handler, want 1", seen.lines)
	}
}

// counting is a handler that counts what reaches it.
type counting struct{ lines int }

func (c *counting) Enabled(context.Context, slog.Level) bool { return true }

func (c *counting) Handle(context.Context, slog.Record) error {
	c.lines++
	return nil
}

func (c *counting) WithAttrs([]slog.Attr) slog.Handler { return c }

func (c *counting) WithGroup(string) slog.Handler { return c }
