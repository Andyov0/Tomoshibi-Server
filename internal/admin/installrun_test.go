package admin

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

/*
The install script, run whole, on a machine that is a temporary directory.

Everything the script reaches for outside itself is stood in for: curl answers
as the control node would and writes down how it was called, systemctl and its
neighbours say yes, and every path under /etc and /usr/local/bin is moved into
the directory. What is left is the script's own behaviour, which is the part
that decides where the enrolment token goes and what is left lying around:

  - the token is read from standard input and travels to curl the same way, so
    it is in no command line a process listing would show and in no history;
  - a refusal prints the control node's reason and never its answer, which on
    the wrong day is the deployment's credentials;
  - a binary that is not the one the control node said it serves is refused
    and removed before it is made executable.

Reading the template for the right strings would pass for a script that holds
them in the wrong order; this runs it.
*/

type installRun struct {
	dir, fake, script string
	token             string
}

// newInstallRun writes the stand-ins and the script, and an answer from the
// control node built the way claim builds one.
func newInstallRun(t *testing.T, binary string, sum string, code string) installRun {
	t.Helper()

	shell, err := exec.LookPath("sh")
	if err != nil || shell == "" {
		t.Skip("no sh to run the script with")
	}

	api, _, _, _ := enrolling(t)

	recorder := httptest.NewRecorder()
	api.PublicInstall(recorder, httptest.NewRequest(http.MethodGet, "/install", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("the install script answered %d", recorder.Code)
	}

	dir := t.TempDir()
	fake := filepath.Join(dir, "fake")
	bin := filepath.Join(dir, "fakebin")

	for _, d := range []string{fake, bin, filepath.Join(dir, "etc", "systemd", "system"), filepath.Join(dir, "usrbin")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	certs := filepath.Join(dir, "pair")
	pairAt(t, certs)
	cert, _ := os.ReadFile(filepath.Join(certs, "relay.fullchain.pem"))
	key, _ := os.ReadFile(filepath.Join(certs, "relay.key"))

	pkg, _ := json.Marshal(enrolPackage{
		Name: "tokyo", Host: "tokyo.relay.example.invalid", URL: "wss://tokyo.relay.example.invalid:13377",
		APIKey: "APIkey", APISecret: "the-api-secret-nobody-should-see",
		RedisAddr: "redis.invalid:6379", RedisPassword: "the-redis-password",
		BinarySHA256: sum,
		Cert:         string(cert), Key: string(key),
		ListenPort: 13377, UDPPort: 13378, TCPPort: 13379, Named: true,
	})

	write := func(path, body string, mode os.FileMode) {
		if err := os.WriteFile(path, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
	}

	write(filepath.Join(fake, "package"), string(pkg), 0o600)
	write(filepath.Join(fake, "code"), code, 0o600)
	write(filepath.Join(fake, "binary"), binary, 0o600)

	write(filepath.Join(bin, "curl"), `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE/argv"
out= ; url= ; data=
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift ;;
        -w|-X|-H|--max-time) shift ;;
        --data-binary) data=1; shift ;;
        http*) url="$1" ;;
    esac
    shift
done
[ -n "$data" ] && { cat >> "$FAKE/bodies"; printf '\n' >> "$FAKE/bodies"; }
case "$url" in
    */api/enrol/taken) printf '%s' '{"prefix":"tokyo","taken":false,"replace":false}' > "$out"; printf 200 ;;
    */api/enrol) cat "$FAKE/package" > "$out"; cat "$FAKE/code" ;;
    */download/tomoshibi) cat "$FAKE/binary" > "$out" ;;
esac
`, 0o755)

	for _, yes := range []string{"systemctl", "journalctl", "sleep", "groupadd", "chgrp", "ip"} {
		write(filepath.Join(bin, yes), "#!/bin/sh\nexit 0\n", 0o755)
	}
	write(filepath.Join(bin, "id"), "#!/bin/sh\necho 0\n", 0o755)

	script := recorder.Body.String()
	script = strings.ReplaceAll(script, "/etc/", dir+"/etc/")
	script = strings.ReplaceAll(script, "/usr/local/bin/", dir+"/usrbin/")

	path := filepath.Join(dir, "install.sh")
	write(path, script, 0o700)

	token := minted(t, api, "tokyo", false)
	write(filepath.Join(dir, "token"), token+"\n", 0o600)

	return installRun{dir: dir, fake: fake, script: path, token: token}
}

func (r installRun) run(t *testing.T, args ...string) (string, error) {
	t.Helper()

	command := exec.Command("sh", append([]string{r.script}, args...)...)
	command.Env = append(os.Environ(),
		"PATH="+filepath.Join(r.dir, "fakebin")+":"+os.Getenv("PATH"),
		"FAKE="+r.fake, "ADDRESS=198.51.100.9", "ENROL=")

	stdin, err := os.Open(filepath.Join(r.dir, "token"))
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	command.Stdin = stdin

	out, err := command.CombinedOutput()

	return string(out), err
}

func (r installRun) read(name string) string {
	body, _ := os.ReadFile(filepath.Join(r.fake, name))
	return string(body)
}

func sumOf(binary string) string {
	sum := sha256.Sum256([]byte(binary))
	return hex.EncodeToString(sum[:])
}

func TestTheTokenTravelsOnStandardInputAndNeverOnACommandLine(t *testing.T) {
	const binary = "#!/bin/sh\necho relay\n"
	r := newInstallRun(t, binary, sumOf(binary), "200")

	out, err := r.run(t, "tokyo")
	if err != nil {
		t.Fatalf("the install did not finish: %v\n%s", err, out)
	}

	if strings.Contains(r.read("argv"), r.token) {
		t.Errorf("the token was on curl's command line, where any user on the machine can read it:\n%s", r.read("argv"))
	}

	if !strings.Contains(r.read("bodies"), r.token) {
		t.Errorf("the token never reached the control node; this test proves nothing:\n%s", r.read("bodies"))
	}

	for _, secret := range []string{"the-api-secret-nobody-should-see", "PRIVATE KEY", "the-redis-password"} {
		if strings.Contains(out, secret) {
			t.Errorf("the install printed %q to the terminal", secret)
		}
	}

	for name, want := range map[string]os.FileMode{
		"etc/tomoshibi/relay.yaml":      0o640,
		"etc/tomoshibi/certs/relay.key": 0o640,
		"usrbin/tomoshibi":              0o755,
	} {
		info, err := os.Stat(filepath.Join(r.dir, name))
		if err != nil {
			t.Errorf("%s was not written: %v", name, err)
			continue
		}

		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s is %o, want %o", name, got, want)
		}
	}

	// The directories the service has to walk to reach its own certificate,
	// which the mask at the top would otherwise have closed to it.
	for _, name := range []string{"etc/tomoshibi", "etc/tomoshibi/certs"} {
		if info, err := os.Stat(filepath.Join(r.dir, name)); err != nil || info.Mode().Perm() != 0o755 {
			t.Errorf("%s is not 755, so the relay could not read its certificate", name)
		}
	}
}

func TestATokenTypedAsAnArgumentIsRefusedBeforeItIsUsed(t *testing.T) {
	const binary = "#!/bin/sh\n"
	r := newInstallRun(t, binary, sumOf(binary), "200")

	out, err := r.run(t, "tokyo", r.token)
	if err == nil {
		t.Fatalf("an install given the token as an argument went ahead:\n%s", out)
	}

	if r.read("argv") != "" {
		t.Errorf("the control node was asked before the argument was refused")
	}
}

func TestARefusalSaysWhyAndNotWhatTheControlNodeSent(t *testing.T) {
	const binary = "#!/bin/sh\n"
	r := newInstallRun(t, binary, sumOf(binary), "500")

	out, err := r.run(t, "tokyo")
	if err == nil {
		t.Fatalf("the install went ahead after a 500:\n%s", out)
	}

	if strings.Contains(out, "PRIVATE KEY") || strings.Contains(out, "the-api-secret-nobody-should-see") {
		t.Errorf("a refusal printed the control node's whole answer, credentials and all:\n%s", out)
	}
}

func TestABinaryThatIsNotTheOneServedIsNotInstalled(t *testing.T) {
	r := newInstallRun(t, "#!/bin/sh\necho tampered\n", sumOf("#!/bin/sh\necho genuine\n"), "200")

	out, err := r.run(t, "tokyo")
	if err == nil {
		t.Fatalf("a binary whose hash does not match was installed:\n%s", out)
	}

	for _, name := range []string{"usrbin/tomoshibi", "usrbin/tomoshibi.new"} {
		if _, err := os.Stat(filepath.Join(r.dir, name)); err == nil {
			t.Errorf("%s was left on the machine after the hash did not match", name)
		}
	}
}

// The public script names the control node and nothing about the relays: the
// zone they are named in, beside /api/relays, was the whole fleet by name.
func TestThePublicScriptDoesNotNameTheRelayDomain(t *testing.T) {
	api, _, _, _ := enrolling(t)

	recorder := httptest.NewRecorder()
	api.PublicInstall(recorder, httptest.NewRequest(http.MethodGet, "/install", nil))

	if strings.Contains(recorder.Body.String(), "relay.example.invalid") {
		t.Error("the script served to anybody names the zone every relay is named in")
	}
}
