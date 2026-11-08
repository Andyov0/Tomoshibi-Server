package config

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

/*
What a start says about who may open and join a room, and where it says it.

Two lines from the health check of 2026-10-29, both of them words rather than
behaviour, and both of the kind that teaches an operator to stop reading the
log. Every relay warned on every start that rooms.opened_by let anybody start a
meeting, when a relay reads no room settings at all: its configuration has no
rooms section, so it carried the defaults, and the default is "anyone". And a
mistyped rooms.opened_by was answered with the three settings there were before
"accounts", which is the one the management pages and the example configuration
use, so somebody who misspelt it was told it does not exist.
*/

// logged captures what Load says through slog while it runs.
func logged(t *testing.T) *bytes.Buffer {
	t.Helper()

	var said bytes.Buffer
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&said, nil)))
	t.Cleanup(func() { slog.SetDefault(was) })

	return &said
}

const relayKeys = "keys:\n  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nredis:\n  address: 127.0.0.1:6379\n"

func TestARelaySaysNothingAboutRoomsItNeverReads(t *testing.T) {
	said := logged(t)

	if _, err := Load(write(t, relayKeys+"meet:\n  role: relay\n  listen: 127.0.0.1:13377\n")); err != nil {
		t.Fatalf("Load: %v", err)
	}

	for _, setting := range []string{"rooms.opened_by", "rooms.joined_by"} {
		if strings.Contains(said.String(), setting) {
			t.Errorf("a relay warned about %s, which it never reads:\n%s", setting, said.String())
		}
	}
}

// And the warnings themselves still stand where the settings mean something,
// or the test above would pass for a deployment that had stopped warning
// anybody at all.
func TestAFullDeploymentStillSaysSo(t *testing.T) {
	said := logged(t)

	if _, err := Load(write(t, relayKeys+"meet:\n  rooms:\n    opened_by: anyone\n    joined_by: anyone\n")); err != nil {
		t.Fatalf("Load: %v", err)
	}

	for _, setting := range []string{"rooms.opened_by", "rooms.joined_by"} {
		if !strings.Contains(said.String(), setting) {
			t.Errorf("a full deployment open to anybody no longer warns about %s:\n%s", setting, said.String())
		}
	}
}

func TestAMistypedOpeningNamesEverySettingThereIs(t *testing.T) {
	_, err := Load(write(t, relayKeys+"meet:\n  rooms:\n    opened_by: acounts\n"))
	if err == nil {
		t.Fatal("a misspelt rooms.opened_by was accepted")
	}

	for _, setting := range []string{`"anyone"`, `"signed"`, `"accounts"`, `"admins"`} {
		if !strings.Contains(err.Error(), setting) {
			t.Errorf("the refusal does not name %s: %v", setting, err)
		}
	}
}
