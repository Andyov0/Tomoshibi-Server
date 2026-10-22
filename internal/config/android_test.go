package config

import (
	"strings"
	"testing"
)

/*
The Android app's claim in the apps section, read the way a deployment's file is
read.

A claim that cannot be verified starts the server cleanly and is served as a
statement Android fetches, fails to match, and says nothing about: every phone
opens this deployment's invitations in the browser, and the only trace is a
line in a log on somebody else's phone. So each kind of mistake is refused at
startup, by a sentence that names the key and says how to claim no app instead.

And what is accepted has to come out as the statement needs it. The meet section
is decoded, encoded again and decoded once more (see split), and a fingerprint
written without quotes goes through all of that; one copied in lower case is
the same fingerprint and is served the way Android's tools write it.
*/

const (
	upperFingerprint = "6A:7B:8C:9D:AE:BF:C0:D1:E2:F3:04:15:26:37:48:59:6A:7B:8C:9D:AE:BF:C0:D1:E2:F3:04:15:26:37:48:59"
	lowerFingerprint = "a0:b1:c2:d3:e4:f5:06:17:28:39:4a:5b:6c:7d:8e:9f:a0:b1:c2:d3:e4:f5:06:17:28:39:4a:5b:6c:7d:8e:9f"
)

// androidDocument is a configuration whose apps section holds the lines given,
// indented beneath it.
func androidDocument(role, lines string) string {
	return `
keys:
  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
meet:
  role: ` + role + `
  relays:
    - {name: one, url: "wss://one.example.invalid"}
  apps:
` + lines
}

func TestAnAndroidClaimIsReadAndItsFingerprintsWrittenInUpperCase(t *testing.T) {
	conf, err := Load(write(t, androidDocument("control", `
    android_package: app.example.android
    android_certificates:
      - `+upperFingerprint+`
      - "`+lowerFingerprint+`"
`)))
	if err != nil {
		t.Fatalf("a whole Android claim was refused: %v", err)
	}

	apps := conf.Meet.Apps
	if apps.AndroidPackage != "app.example.android" {
		t.Errorf("the package was read as %q", apps.AndroidPackage)
	}

	want := []string{upperFingerprint, strings.ToUpper(lowerFingerprint)}
	if len(apps.AndroidCertificates) != len(want) {
		t.Fatalf("the fingerprints were read as %q, want %q", apps.AndroidCertificates, want)
	}

	for i := range want {
		if apps.AndroidCertificates[i] != want[i] {
			t.Errorf("fingerprint %d was read as %q, want %q", i, apps.AndroidCertificates[i], want[i])
		}
	}

	if !apps.AndroidLinked() {
		t.Error("a package with its fingerprints does not count as claiming the app")
	}
}

func TestNoAndroidClaimIsNotRefused(t *testing.T) {
	conf, err := Load(write(t, androidDocument("full", "    mac_dir: /nonexistent/apps\n")))
	if err != nil {
		t.Fatalf("an apps section without the Android keys was refused: %v", err)
	}

	if conf.Meet.Apps.AndroidLinked() {
		t.Error("a section naming no Android app counts as claiming one")
	}
}

func TestAnAndroidClaimThatCannotBeVerifiedIsRefusedByName(t *testing.T) {
	certificates := func(fingerprints ...string) string {
		lines := "    android_certificates:\n"
		for _, one := range fingerprints {
			lines += `      - "` + one + "\"\n"
		}
		return lines
	}

	withPackage := func(name string) string {
		return "    android_package: \"" + name + "\"\n" + certificates(upperFingerprint)
	}

	withFingerprint := func(fingerprint string) string {
		return "    android_package: app.example.android\n" + certificates(upperFingerprint, fingerprint)
	}

	for _, tc := range []struct {
		name, lines string
		// key is the setting the sentence must name, and said what else of
		// the mistake it must quote.
		key, said string
	}{
		{"a package of one part", withPackage("tomoshibi"),
			"meet.apps.android_package", `"tomoshibi"`},
		{"a part beginning with a digit", withPackage("app.1example"),
			"meet.apps.android_package", `"app.1example"`},
		{"a part beginning with an underscore", withPackage("app._example"),
			"meet.apps.android_package", `"app._example"`},
		{"a hyphen", withPackage("app.example-android"),
			"meet.apps.android_package", `"app.example-android"`},
		{"an empty part", withPackage("app..android"),
			"meet.apps.android_package", `"app..android"`},
		{"a trailing dot", withPackage("app.example."),
			"meet.apps.android_package", `"app.example."`},
		{"a space", withPackage("app.example android"),
			"meet.apps.android_package", `"app.example android"`},

		{"a fingerprint a byte short", withFingerprint(upperFingerprint[:len(upperFingerprint)-3]),
			"meet.apps.android_certificates[1]", upperFingerprint[:len(upperFingerprint)-3]},
		{"a fingerprint a byte long", withFingerprint(upperFingerprint + ":00"),
			"meet.apps.android_certificates[1]", upperFingerprint + ":00"},
		{"a SHA-1 fingerprint", withFingerprint(upperFingerprint[:59]),
			"meet.apps.android_certificates[1]", upperFingerprint[:59]},
		{"a fingerprint without colons, as apksigner prints it",
			withFingerprint(strings.ReplaceAll(lowerFingerprint, ":", "")),
			"meet.apps.android_certificates[1]", strings.ReplaceAll(lowerFingerprint, ":", "")},
		{"a fingerprint with dashes", withFingerprint(strings.ReplaceAll(upperFingerprint, ":", "-")),
			"meet.apps.android_certificates[1]", strings.ReplaceAll(upperFingerprint, ":", "-")},
		{"a digit that is not hexadecimal", withFingerprint("G" + upperFingerprint[1:]),
			"meet.apps.android_certificates[1]", "G" + upperFingerprint[1:]},
		{"a trailing colon", withFingerprint(upperFingerprint + ":"),
			"meet.apps.android_certificates[1]", upperFingerprint + ":"},
		{"an empty fingerprint", withFingerprint(""),
			"meet.apps.android_certificates[1]", `""`},

		{"a package with no fingerprints", "    android_package: app.example.android\n",
			"meet.apps.android_certificates", "meet.apps.android_package is set"},
		{"a package with an empty list", "    android_package: app.example.android\n    android_certificates: []\n",
			"meet.apps.android_certificates", "meet.apps.android_package is set"},
		{"fingerprints with no package", certificates(upperFingerprint),
			"meet.apps.android_package", "meet.apps.android_certificates is set"},
	} {
		_, err := Load(write(t, androidDocument("control", tc.lines)))
		if err == nil {
			t.Errorf("%s was accepted, and would be served as a claim Android cannot verify", tc.name)
			continue
		}

		said := err.Error()
		if !strings.Contains(said, tc.key) || !strings.Contains(said, tc.said) {
			t.Errorf("%s was refused without naming %s and quoting %s: %v", tc.name, tc.key, tc.said, err)
		}

		if !strings.Contains(said, "claim no Android app") {
			t.Errorf("%s was refused without saying how to claim no app instead: %v", tc.name, err)
		}
	}
}

// A relay serves no pages, so the claim is not read there, and one that would
// be refused anywhere else does not stop it carrying media.
func TestARelayIgnoresTheAndroidClaim(t *testing.T) {
	document := strings.Replace(androidDocument("relay", "    android_package: tomoshibi\n"),
		"  relays:\n    - {name: one, url: \"wss://one.example.invalid\"}\n", "", 1)

	if _, err := Load(write(t, document)); err != nil {
		t.Fatalf("a relay refused to start over an Android claim it never serves: %v", err)
	}
}
