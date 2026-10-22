package config

import (
	"strings"
	"testing"
)

/*
The Apple apps' identifiers and the TestFlight public link, read the way a
deployment's file is read.

An identifier written wrongly starts the server cleanly and is served as a
statement Apple's devices fetch, find no app in, and say nothing about: every
invitation opens in Safari. A public link written wrongly is a button that
sends somebody who was given nothing but an invitation to whatever was pasted.
Both are refused at startup by a sentence naming the key and the way out, and
what is accepted comes through the meet section's round trip (see split) as it
was written.
*/

func TestTheAppleIdentifiersAndThePublicLinkAreRead(t *testing.T) {
	conf, err := Load(write(t, androidDocument("control", `
    apple_app_ids:
      - SM86NB3CPZ.app.tomoshibi.ios
      - "SM86NB3CPZ.app.tomoshibi.mac"
    testflight:
      public_link: https://testflight.apple.com/join/1DFSjfsK
`)))
	if err != nil {
		t.Fatalf("an Apple claim and a public link were refused: %v", err)
	}

	apps := conf.Meet.Apps

	if got := strings.Join(apps.AppleAppIDs, ","); got != "SM86NB3CPZ.app.tomoshibi.ios,SM86NB3CPZ.app.tomoshibi.mac" {
		t.Errorf("the identifiers were read as %q", got)
	}

	if !apps.AppleLinked() {
		t.Error("identifiers given do not count as claiming the Apple apps")
	}

	if apps.TestFlight.PublicLink != "https://testflight.apple.com/join/1DFSjfsK" {
		t.Errorf("the public link was read as %q", apps.TestFlight.PublicLink)
	}

	// A public link is not an App Store Connect key, and having one must not
	// make invitations by address look offered.
	if apps.TestFlight.Configured() {
		t.Error("a public link alone counts as an App Store Connect key")
	}
}

func TestNoAppleClaimAndNoPublicLinkAreNotRefused(t *testing.T) {
	conf, err := Load(write(t, androidDocument("full", "    mac_dir: /nonexistent/apps\n")))
	if err != nil {
		t.Fatalf("an apps section without either was refused: %v", err)
	}

	if conf.Meet.Apps.AppleLinked() || conf.Meet.Apps.TestFlight.PublicLink != "" {
		t.Errorf("a section naming neither claims something: %+v", conf.Meet.Apps)
	}
}

func TestAnAppleIdentifierThatIsNotOneIsRefusedByName(t *testing.T) {
	for _, tc := range []struct{ name, id string }{
		{"the bundle id alone", "app.tomoshibi.ios"},
		{"a team id in lower case", "sm86nb3cpz.app.tomoshibi.ios"},
		{"a team id a character short", "SM86NB3CP.app.tomoshibi.ios"},
		{"a team id a character long", "SM86NB3CPZX.app.tomoshibi.ios"},
		{"a team id and nothing after it", "SM86NB3CPZ."},
		{"the team id alone", "SM86NB3CPZ"},
		{"a space", "SM86NB3CPZ.app.tomoshibi ios"},
		{"an underscore", "SM86NB3CPZ.app.tomoshibi_ios"},
		{"an empty part", "SM86NB3CPZ.app..ios"},
		{"a trailing dot", "SM86NB3CPZ.app.tomoshibi."},
		{"a wildcard", "SM86NB3CPZ.app.tomoshibi.*"},
		{"nothing", ""},
	} {
		_, err := Load(write(t, androidDocument("control", "    apple_app_ids:\n      - \""+tc.id+"\"\n")))
		if err == nil {
			t.Errorf("%s (%q) was accepted, and would be served as a claim Apple cannot verify", tc.name, tc.id)
			continue
		}

		said := err.Error()
		if !strings.Contains(said, "meet.apps.apple_app_ids[0]") || !strings.Contains(said, `"`+tc.id+`"`) {
			t.Errorf("%s was refused without naming the setting and quoting it: %v", tc.name, err)
		}

		if !strings.Contains(said, "claim no Apple app") {
			t.Errorf("%s was refused without saying how to claim no app instead: %v", tc.name, err)
		}
	}

	// The second of two, named by its own place in the list.
	_, err := Load(write(t, androidDocument("control",
		"    apple_app_ids:\n      - SM86NB3CPZ.app.tomoshibi.ios\n      - app.tomoshibi.mac\n")))
	if err == nil || !strings.Contains(err.Error(), "meet.apps.apple_app_ids[1]") {
		t.Errorf("a wrong second identifier was not refused by its place: %v", err)
	}
}

func TestAPublicLinkThatIsNotTestFlightsIsRefusedByName(t *testing.T) {
	for _, tc := range []struct{ name, link string }{
		{"the App Store", "https://apps.apple.com/app/testflight/id899247664"},
		{"plain http", "http://testflight.apple.com/join/1DFSjfsK"},
		{"another host", "https://testflight.example.com/join/1DFSjfsK"},
		{"a host ending in Apple's", "https://evil.testflight.apple.com.example/join/1DFSjfsK"},
		{"no code", "https://testflight.apple.com/join/"},
		{"a query pasted after it", "https://testflight.apple.com/join/1DFSjfsK?ref=chat"},
		{"a trailing slash", "https://testflight.apple.com/join/1DFSjfsK/"},
		{"a path beyond the code", "https://testflight.apple.com/join/1DFSjfsK/more"},
		{"the code alone", "1DFSjfsK"},
		{"a space", "https://testflight.apple.com/join/1DFS jfsK"},
	} {
		_, err := Load(write(t, androidDocument("control", "    testflight:\n      public_link: \""+tc.link+"\"\n")))
		if err == nil {
			t.Errorf("%s (%q) was accepted as a TestFlight public link", tc.name, tc.link)
			continue
		}

		said := err.Error()
		if !strings.Contains(said, "meet.apps.testflight.public_link") || !strings.Contains(said, `"`+tc.link+`"`) {
			t.Errorf("%s was refused without naming the setting and quoting it: %v", tc.name, err)
		}

		if !strings.Contains(said, "remove public_link") {
			t.Errorf("%s was refused without saying how to offer none: %v", tc.name, err)
		}
	}
}

// A relay serves no pages, so neither is read there.
func TestARelayIgnoresTheAppleClaimAndThePublicLink(t *testing.T) {
	document := strings.Replace(androidDocument("relay",
		"    apple_app_ids: [\"app.tomoshibi.ios\"]\n    testflight:\n      public_link: \"nonsense\"\n"),
		"  relays:\n    - {name: one, url: \"wss://one.example.invalid\"}\n", "", 1)

	if _, err := Load(write(t, document)); err != nil {
		t.Fatalf("a relay refused to start over settings it never serves: %v", err)
	}
}
