package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func write(t *testing.T, body string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "meet.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write the configuration: %v", err)
	}

	return path
}

func TestDefaultsApplyToAnEmptySection(t *testing.T) {
	conf, err := Load(write(t, "keys:\n  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if conf.Meet.Listen != defaults.Listen {
		t.Errorf("listen = %q, want %q", conf.Meet.Listen, defaults.Listen)
	}
	if conf.Meet.TokenTTL != defaults.TokenTTL {
		t.Errorf("token_ttl = %v, want %v", conf.Meet.TokenTTL, defaults.TokenTTL)
	}
	if conf.Meet.TrustProxy {
		t.Error("forwarded headers are believed without being asked to")
	}
}

// The two halves live in one document, so the split has to leave each side with
// exactly what it expects.
func TestBothHalvesAreRead(t *testing.T) {
	conf, err := Load(write(t, `
port: 7999
keys:
  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
meet:
  listen: ":9000"
  token_ttl: 90s
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if conf.Meet.Listen != ":9000" {
		t.Errorf("listen = %q, want :9000", conf.Meet.Listen)
	}
	if conf.Meet.TokenTTL != 90*time.Second {
		t.Errorf("token_ttl = %v, want 90s", conf.Meet.TokenTTL)
	}
	if conf.LiveKit.Port != 7999 {
		t.Errorf("port = %d, want 7999", conf.LiveKit.Port)
	}
}

// The credentials are read back out of the media server's own configuration, so
// there is no second place for them to drift.
func TestCredentialsComeFromTheMediaServer(t *testing.T) {
	conf, err := Load(write(t, "keys:\n  APIchosen: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if conf.Key != "APIchosen" {
		t.Errorf("key = %q, want APIchosen", conf.Key)
	}
	if conf.Secret != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
		t.Errorf("secret was not read back")
	}
}

func TestWithoutAKeyThereIsNothingToSignWith(t *testing.T) {
	_, err := Load(write(t, "port: 7880\n"))
	if err == nil {
		t.Fatal("a configuration with no API key was accepted")
	}
}

// Signing needs one key. Several would mean choosing, and a choice nobody made
// is one that will surprise somebody.
func TestSeveralKeysAreRefused(t *testing.T) {
	_, err := Load(write(t, `
keys:
  APIone: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  APItwo: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
`))
	if err == nil {
		t.Fatal("two API keys were accepted")
	}
}

// A typo in our half deserves the same error as a typo in theirs.
func TestATypoInOurSectionIsRefused(t *testing.T) {
	_, err := Load(write(t, `
keys:
  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
meet:
  listten: ":9000"
`))
	if err == nil {
		t.Fatal("an unknown key in the meet section was ignored")
	}
}

// The section has to be gone before the media server sees the document, since it
// is asked to reject anything it does not recognise.
func TestOurSectionIsHiddenFromTheMediaServer(t *testing.T) {
	if _, err := Load(write(t, `
keys:
  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
meet:
  listen: ":9000"
`)); err != nil {
		t.Fatalf("Load: %v", err)
	}
}

// A count of proxies is only used to read X-Forwarded-For, which trust_proxy
// false says is not read, so the two together cannot mean anything.
func TestProxiesWithoutTrustProxyIsRefused(t *testing.T) {
	meet := defaults
	meet.Proxies = 2

	if err := checkRole(&meet); err == nil {
		t.Error("proxies without trust_proxy was accepted")
	}
}

func TestHopsCountsOnlyWhatIsTrusted(t *testing.T) {
	for _, c := range []struct {
		trust   bool
		proxies int
		want    int
	}{{false, 0, 0}, {true, 0, 1}, {true, 1, 1}, {true, 2, 2}} {
		meet := Meet{TrustProxy: c.trust, Proxies: c.proxies}
		if got := meet.Hops(); got != c.want {
			t.Errorf("trust_proxy %v, proxies %d: %d hops, want %d", c.trust, c.proxies, got, c.want)
		}
	}
}
