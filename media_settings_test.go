package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/livekit/protocol/logger"

	"tomoshibi/internal/config"
)

// The line a relay says at start about how each viewer's media is chosen is
// read by something other than a person: the release script for the relays
// already running (relay-smooth.sh, kept beside the deployment's private notes)
// and step 4 of RELAY.md's "On a relay that is already running" both find it
// and match two settings on it. Nothing else holds those words still. A key
// renamed in main.go would leave every test green and turn release day into a
// fleet of relays reported as not having read their settings, which an operator
// would answer by rolling back relays that had been changed correctly.
//
// So the line is rendered here through the media server's own logger — which is
// what writes it on a relay, having replaced the default handler by the time it
// is said — in both formats a relay may be configured for, and matched with the
// same patterns the script and the document use. They are copied here on
// purpose: change one, change all three.
var (
	// grep -F 'how each viewer'
	saidFound = regexp.MustCompile(regexp.QuoteMeta("how each viewer"))
	// grep -qE '"send side bwe": ?true'
	saidSendSide = regexp.MustCompile(`"send side bwe": ?true`)
	// grep -qE '"video nack window": ?4000'
	saidWindow = regexp.MustCompile(`"video nack window": ?4000`)
)

func TestMediaSettingsLine(t *testing.T) {
	// The relay file every relay is installed from in development, which
	// carries both settings as the release puts them.
	conf, err := config.Load("dev/relay.yaml")
	if err != nil {
		t.Fatalf("dev/relay.yaml did not load: %v", err)
	}

	for _, format := range []struct {
		name string
		json bool
	}{{"console", false}, {"json", true}} {
		t.Run(format.name, func(t *testing.T) {
			line := said(t, conf, format.json)
			for _, pattern := range []*regexp.Regexp{saidFound, saidSendSide, saidWindow} {
				if !pattern.MatchString(line) {
					t.Errorf("the settings line does not match %q, which the release script reads it by:\n%s", pattern, line)
				}
			}
		})
	}
}

// And the patterns are not so loose that a relay without the settings passes.
func TestMediaSettingsLineSaysWhenTheyAreMissing(t *testing.T) {
	conf, err := config.Load("dev/relay.yaml")
	if err != nil {
		t.Fatal(err)
	}

	conf.LiveKit.RTC.CongestionControl.UseSendSideBWE = false
	conf.LiveKit.RTC.PacketBufferSizeVideo = 500

	line := said(t, conf, false)
	if !saidFound.MatchString(line) {
		t.Fatalf("the line was not written at all:\n%s", line)
	}
	if saidSendSide.MatchString(line) || saidWindow.MatchString(line) {
		t.Errorf("a relay on the old settings reads as one on the new:\n%s", line)
	}
}

// said is the line as a relay's journal would hold it: written by the media
// server's logger to standard error, in its console or its JSON format.
//
// Standard error itself, swapped for a file while the logger is made, because
// that is where the logger writes and it takes the stream when it is made. Its
// tap is not a substitute: the tap writes JSON whatever the format, and the
// console format is the one the relays run.
func said(t *testing.T, conf *config.Config, json bool) string {
	t.Helper()

	out, err := os.Create(filepath.Join(t.TempDir(), "stderr"))
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()

	was := os.Stderr
	os.Stderr = out
	zapped, err := logger.NewZapLogger(&logger.Config{JSON: json, Level: "info"})
	os.Stderr = was
	if err != nil {
		t.Fatal(err)
	}

	slog.New(logger.ToSlogHandler(zapped)).Info(mediaSettingsSaid, mediaSettings(conf)...)

	written, err := os.ReadFile(out.Name())
	if err != nil {
		t.Fatal(err)
	}
	return string(written)
}
