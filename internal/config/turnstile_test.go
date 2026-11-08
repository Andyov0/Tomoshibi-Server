package config

import (
	"strings"
	"testing"
)

/*
The human check's section, read the way a deployment's file is read.

What would go wrong silently is half of it. A site key with no secret, or the
other way round, is somebody who meant the sign-in to ask for a check and a
deployment that would either ask for none or refuse every token for a reason
nobody connects to the file — so both are refused at startup, by a sentence
naming the key that is missing. And the two switches that spare callers the
check have to be on when they are not written: the apps, which the owner
decided are never asked, and the tools on a control node that sign in over
loopback with no browser, each of which a default of off would sign out on
the day the keys went in.

The keys are Cloudflare's published testing keys.
*/

func turnstileDocument(role, section string) string {
	return `
keys:
  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
meet:
  role: ` + role + `
` + section
}

func TestAWholeTurnstileSectionIsReadUnderItsOwnNames(t *testing.T) {
	conf, err := Load(write(t, turnstileDocument("full", `
  turnstile:
    site_key: "1x00000000000000000000AA"
    secret_key: "1x0000000000000000000000000000000AA"
    hostnames: ["Meet.Example.COM.", "  meet.example.org  "]
`)))
	if err != nil {
		t.Fatalf("a whole turnstile section was refused: %v", err)
	}

	got := conf.Meet.Turnstile
	if !got.Configured() || got.SiteKey != "1x00000000000000000000AA" {
		t.Fatalf("the section was not read as written: configured %v, site key %q", got.Configured(), got.SiteKey)
	}

	// Written the way a hostname Cloudflare reports is compared.
	if strings.Join(got.Hostnames, ",") != "meet.example.com,meet.example.org" {
		t.Errorf("hostnames = %v, want them in lower case without the trailing dot", got.Hostnames)
	}

	if !got.ExemptsNativeApps() {
		t.Error("the apps' exemption is off when the file does not mention it")
	}
}

func TestTheAppsExemptionCanBeClosed(t *testing.T) {
	conf, err := Load(write(t, turnstileDocument("full", `
  turnstile:
    site_key: "1x00000000000000000000AA"
    secret_key: "1x0000000000000000000000000000000AA"
    exempt_native_apps: false
`)))
	if err != nil {
		t.Fatalf("closing the apps' exemption was refused: %v", err)
	}

	if conf.Meet.Turnstile.ExemptsNativeApps() {
		t.Error("exempt_native_apps: false left the apps exempt")
	}
}

func TestNoTurnstileSectionAsksForNothing(t *testing.T) {
	conf, err := Load(write(t, turnstileDocument("full", "")))
	if err != nil {
		t.Fatal(err)
	}

	if conf.Meet.Turnstile.Configured() {
		t.Error("a file with no turnstile section asks for a human check")
	}
}

func TestHalfATurnstileSectionIsRefusedByName(t *testing.T) {
	for name, c := range map[string]struct{ section, names string }{
		"a site key alone": {`
  turnstile:
    site_key: "1x00000000000000000000AA"
`, "meet.turnstile.secret_key"},
		"a secret alone": {`
  turnstile:
    secret_key: "1x0000000000000000000000000000000AA"
`, "meet.turnstile.site_key"},
		"one key in both places": {`
  turnstile:
    site_key: "1x00000000000000000000AA"
    secret_key: "1x00000000000000000000AA"
`, "are the same"},
		"a hostname with a scheme": {`
  turnstile:
    site_key: "1x00000000000000000000AA"
    secret_key: "1x0000000000000000000000000000000AA"
    hostnames: ["https://meet.example.com"]
`, "meet.turnstile.hostnames[0]"},
		"a hostname with a port": {`
  turnstile:
    site_key: "1x00000000000000000000AA"
    secret_key: "1x0000000000000000000000000000000AA"
    hostnames: ["meet.example.com", "meet.example.com:8443"]
`, "meet.turnstile.hostnames[1]"},
	} {
		_, err := Load(write(t, turnstileDocument("full", c.section)))
		if err == nil {
			t.Errorf("%s was accepted", name)
			continue
		}

		if !strings.Contains(err.Error(), c.names) {
			t.Errorf("%s was refused without saying %q: %v", name, c.names, err)
		}

		// The refusal names the setting and never repeats a secret back.
		if strings.Contains(err.Error(), "0000000000000000000000AA") {
			t.Errorf("%s was refused with the key in the sentence: %v", name, err)
		}
	}
}

// A relay has no sign-in, so the section is not read there, even half written.
func TestARelayIgnoresTheTurnstileSection(t *testing.T) {
	if _, err := Load(write(t, turnstileDocument("relay", `
  turnstile:
    site_key: "1x00000000000000000000AA"
`))); err != nil {
		t.Fatalf("a relay refused to start over a section it never reads: %v", err)
	}
}

func TestATypoInTheTurnstileSectionIsRefused(t *testing.T) {
	if _, err := Load(write(t, turnstileDocument("full", `
  turnstile:
    sitekey: "1x00000000000000000000AA"
`))); err == nil {
		t.Fatal("a misspelled key under meet.turnstile was accepted and would have done nothing")
	}
}

func TestAHostnameIsWrittenAsItIsCompared(t *testing.T) {
	for in, want := range map[string]string{
		"meet.example.com":  "meet.example.com",
		"MEET.example.com.": "meet.example.com",
		"127.0.0.1":         "127.0.0.1",
		"::1":               "::1",
		"[::1]":             "::1",
	} {
		if got, ok := Hostname(in); !ok || got != want {
			t.Errorf("Hostname(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}

	for _, refused := range []string{"", "  ", "meet.example.com:443", "https://meet.example.com", "meet.example.com/admin", "a b"} {
		if got, ok := Hostname(refused); ok {
			t.Errorf("Hostname(%q) = %q, accepted", refused, got)
		}
	}
}

// What a start says about a check that is there and checks less than it looks.
//
// Two warnings, and both are the only place the thing is said. A testing secret
// passes every token, so a deployment started with one has a check that checks
// nothing and a sign-in page that looks exactly like one that does; and the
// always-pass one reports every token as solved on example.com, which is the
// first thing anybody trying the keys runs into. Empty hostnames hold a token
// to a host the caller writes, which matters wherever the widget is shared.
// A real secret and named hostnames are said nothing about, or these would
// pass for a start that warned about everything.
func TestAStartSaysWhatTheCheckDoesNotCheck(t *testing.T) {
	cases := []struct {
		name, section string
		said, unsaid  []string
	}{
		{"a testing secret and no hostnames", `
  turnstile:
    site_key: "1x00000000000000000000AA"
    secret_key: "1x0000000000000000000000000000000AA"
`, []string{"Cloudflare publishes for testing", "example.com", "meet.turnstile.hostnames is empty"}, nil},
		{"a real secret and named hostnames", `
  turnstile:
    site_key: "a-placeholder-site-key"
    secret_key: "a-placeholder-secret-and-no-testing-key"
    hostnames: ["meet.example.com"]
`, nil, []string{"Cloudflare publishes for testing", "meet.turnstile.hostnames is empty"}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			said := logged(t)

			if _, err := Load(write(t, turnstileDocument("full", c.section))); err != nil {
				t.Fatalf("Load: %v", err)
			}

			for _, want := range c.said {
				if !strings.Contains(said.String(), want) {
					t.Errorf("the start did not say %q:\n%s", want, said.String())
				}
			}

			for _, never := range c.unsaid {
				if strings.Contains(said.String(), never) {
					t.Errorf("the start said %q of a section that deserves no warning:\n%s", never, said.String())
				}
			}

			if strings.Contains(said.String(), "0000000000000000000000000000000AA") ||
				strings.Contains(said.String(), "placeholder-secret") {
				t.Errorf("the start wrote the secret key:\n%s", said.String())
			}
		})
	}
}

func TestTheLocalExemptionIsOnUnlessClosed(t *testing.T) {
	for _, c := range []struct {
		name, line string
		want       bool
	}{
		{"unwritten", "", true},
		{"written true", "    exempt_local: true\n", true},
		{"written false", "    exempt_local: false\n", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			conf, err := Load(write(t, turnstileDocument("full", `
  turnstile:
    site_key: "1x00000000000000000000AA"
    secret_key: "1x0000000000000000000000000000000AA"
`+c.line)))
			if err != nil {
				t.Fatalf("Load: %v", err)
			}

			if got := conf.Meet.Turnstile.ExemptsLocal(); got != c.want {
				t.Errorf("ExemptsLocal() = %v, want %v", got, c.want)
			}
		})
	}
}

// Behind a proxy, a server that also listens beyond loopback is told at start
// whom the local exemption spares and what the proxy must do for that to stay
// true. Not where it listens on loopback alone, not without a proxy, and not
// with the exemption closed, or the line would be said of every start and
// read by nobody.
func TestAStartSaysWhomTheLocalExemptionSpares(t *testing.T) {
	const warning = "meet.turnstile.exempt_local spares the human check"

	cases := []struct {
		name, meet string
		said       bool
	}{
		{"every address behind a proxy", "  trust_proxy: true\n  proxies: 2\n  listen: \":8080\"\n", true},
		{"the unspecified address behind a proxy", "  trust_proxy: true\n  listen: \"0.0.0.0:8080\"\n", true},
		{"one outside address behind a proxy", "  trust_proxy: true\n  listen: \"203.0.113.5:8080\"\n", true},
		{"loopback alone behind a proxy", "  trust_proxy: true\n  proxies: 2\n  listen: \"127.0.0.1:8080\"\n", false},
		{"IPv6 loopback behind a proxy", "  trust_proxy: true\n  listen: \"[::1]:8080\"\n", false},
		{"localhost behind a proxy", "  trust_proxy: true\n  listen: \"localhost:8080\"\n", false},
		{"every address with no proxy", "  listen: \":8080\"\n", false},
		{"every address behind a proxy, exemption closed",
			"  trust_proxy: true\n  listen: \":8080\"\n", false},
	}

	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			section := `
  turnstile:
    site_key: "1x00000000000000000000AA"
    secret_key: "1x0000000000000000000000000000000AA"
    hostnames: ["meet.example.com"]
`
			if i == len(cases)-1 {
				section += "    exempt_local: false\n"
			}

			said := logged(t)

			if _, err := Load(write(t, turnstileDocument("full", c.meet+section))); err != nil {
				t.Fatalf("Load: %v", err)
			}

			if got := strings.Contains(said.String(), warning); got != c.said {
				t.Errorf("warned %v, want %v:\n%s", got, c.said, said.String())
			}

			if c.said && !strings.Contains(said.String(), "must always set X-Forwarded-For or X-Real-IP") {
				t.Errorf("the warning did not say what the proxy must do:\n%s", said.String())
			}
		})
	}
}
