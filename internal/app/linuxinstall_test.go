package app

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
	"regexp"
	"strings"
	"testing"

	"tomoshibi/internal/config"
)

/*
The Linux installer is a script somebody pipes into their shell, so the faults
that matter are the ones that would run something other than what was meant:
an address written into it that a request chose, an HTML page handed to sh
where the script was not served, a script sh cannot read, and a script whose
requests for the build the update endpoint refuses, which would leave every
paste failing with "could not reach" while the pages offered it.
*/

// linuxApp is a control node with shelves holding both Linux builds.
func linuxApp(t *testing.T, trust bool) http.Handler {
	t.Helper()

	dir := appsDirectory(t, map[string][]build{
		"linux-x86_64":  {{version: "0.1.7", file: "Tomoshibi-0.1.7-x86_64.AppImage", contents: []byte("x86-64 image")}},
		"linux-aarch64": {{version: "0.1.7", file: "Tomoshibi-0.1.7-aarch64.AppImage", contents: []byte("arm image")}},
	})
	_, _, app := controlWithStore(t, config.PickProbe)
	app.apps = desk(t, nil, dir)
	app.conf.Meet.TrustProxy = trust

	return app.Handler()
}

var installBaseLine = regexp.MustCompile(`(?m)^BASE='([^']*)'$`)

// installed asks for the script as a request with this host and these headers,
// and says the address written into it, or the status where there was none.
func installed(t *testing.T, mux http.Handler, host string, header ...string) (string, *httptest.ResponseRecorder) {
	t.Helper()

	request := httptest.NewRequest(http.MethodGet, "/linux.sh", nil)
	request.Host = host
	for i := 0; i+1 < len(header); i += 2 {
		request.Header.Set(header[i], header[i+1])
	}
	recorder := ask(mux, request)

	found := installBaseLine.FindStringSubmatch(recorder.Body.String())
	if found == nil {
		return "", recorder
	}

	return found[1], recorder
}

func TestTheInstallerIsServedToAnybodyWithThisDeploymentsAddressInIt(t *testing.T) {
	mux := linuxApp(t, false)

	base, got := installed(t, mux, "meet.example.com", "User-Agent", "curl/8.5.0")
	if got.Code != http.StatusOK {
		t.Fatalf("the installer answered %d %s, want 200 with no session", got.Code, got.Body.String())
	}
	if kind := got.Header().Get("Content-Type"); !strings.HasPrefix(kind, "text/x-shellscript") {
		t.Errorf("the installer is served as %q", kind)
	}
	if base != "http://meet.example.com" {
		t.Errorf("the installer fetches from %q, want the address it was asked at", base)
	}
	if strings.Contains(got.Body.String(), "@BASE@") {
		t.Error("an address was left unfilled in the installer")
	}

	// Browsers too: somebody opening the address to read it first.
	if _, got := installed(t, mux, "meet.example.com", "User-Agent", browserAgent); got.Code != http.StatusOK {
		t.Errorf("a browser asking for the installer answered %d", got.Code)
	}
}

func TestTheInstallerTakesTheProxysAddressOnlyWhereTheProxyIsTrusted(t *testing.T) {
	trusted := linuxApp(t, true)

	if base, _ := installed(t, trusted, "127.0.0.1:8080",
		"X-Forwarded-Proto", "https", "X-Forwarded-Host", "meet.example.com"); base != "https://meet.example.com" {
		t.Errorf("behind a trusted proxy the installer fetches from %q, want https://meet.example.com", base)
	}

	// The proxy nearest this server writes the last one.
	if base, _ := installed(t, trusted, "127.0.0.1:8080",
		"X-Forwarded-Proto", "https", "X-Forwarded-Host", "elsewhere.example.net, meet.example.com"); base != "https://meet.example.com" {
		t.Errorf("with a host the caller added before the proxy's, the installer fetches from %q", base)
	}

	untrusted := linuxApp(t, false)
	if base, _ := installed(t, untrusted, "meet.example.com",
		"X-Forwarded-Proto", "https", "X-Forwarded-Host", "elsewhere.example.net"); base != "http://meet.example.com" {
		t.Errorf("with no proxy trusted, a caller's forwarded headers made the installer fetch from %q", base)
	}
}

// A host is pasted into a shell script, between single quotes, and run.
func TestAHostThatIsNotOneIsNeverWrittenIntoTheInstaller(t *testing.T) {
	trusted := linuxApp(t, true)

	for _, host := range []string{
		"meet.example.com'; rm -rf ~; '",
		"meet.example.com\nrm -rf ~",
		"meet.example.com $(id)",
		"meet.example.com`id`",
		"meet.example.com/evil",
		"-meet.example.com",
		"",
	} {
		base, got := installed(t, trusted, "127.0.0.1:8080", "X-Forwarded-Host", host)
		if host == "" {
			// An empty forwarded host is no forwarded host: the request's own.
			if base != "http://127.0.0.1:8080" {
				t.Errorf("with an empty forwarded host the installer fetches from %q", base)
			}
			continue
		}
		if got.Code != http.StatusBadRequest || base != "" {
			t.Errorf("forwarded host %q: answered %d, base %q, want 400 and no script", host, got.Code, base)
		}
	}

	for _, host := range []string{"[2001:db8::1]:8443", "meet.example.com:8443", "192.0.2.10"} {
		if base, _ := installed(t, trusted, host); base != "http://"+host {
			t.Errorf("host %q is written as %q", host, base)
		}
	}
}

// Without shelves the path is answered, not left to the client's fallback,
// which would hand sh the page's HTML document.
func TestTheInstallerIsNotThePageWhereThereIsNothingToInstall(t *testing.T) {
	_, _, app := controlWithStore(t, config.PickProbe)
	app.apps = nil

	// The refusal's own code, not merely a 404: the client's fallback answers
	// 404 too where the tests have no built client, and 200 where they do.
	_, got := installed(t, app.Handler(), "meet.example.com")
	if got.Code != http.StatusNotFound || refusalOf(t, got) != reasonNoBuild {
		t.Errorf("with no shelves the installer answered %d %.60q, want 404 %s", got.Code, got.Body.String(), reasonNoBuild)
	}
}

// The script asks for the build as the app would, and the update endpoint
// must take that for the app.
func TestTheInstallersRequestsAreTheAppsToTheUpdateEndpoint(t *testing.T) {
	mux := linuxApp(t, false)

	if !strings.Contains(linuxInstaller, `agent="Tomoshibi/installer-$VERSION (Linux; installer; $arch)"`) {
		t.Fatal("the installer no longer says the user agent this test checks; update both")
	}

	for _, arch := range []string{"x86_64", "aarch64"} {
		agent := "Tomoshibi/installer-1 (Linux; installer; " + arch + ")"
		got := appsGet(mux, "/api/apps/latest/linux-"+arch, nil, "User-Agent", agent)
		if got.Code != http.StatusOK {
			t.Fatalf("the installer asking for linux-%s answered %d %s", arch, got.Code, got.Body.String())
		}

		// The four fields it reads with sed, each on the one line it reads.
		line := got.Body.String()
		if strings.Count(strings.TrimSpace(line), "\n") != 0 {
			t.Errorf("the line for linux-%s is more than one line, which the installer's sed cannot read", arch)
		}
		for _, field := range []string{`"version":"0.1.7"`, `"sha256":"`, `"size":`, `"file":"Tomoshibi-0.1.7-` + arch + `.AppImage"`} {
			if !strings.Contains(line, field) {
				t.Errorf("the line for linux-%s has no %s: %s", arch, field, line)
			}
		}

		if file := appsGet(mux, "/api/apps/latest/linux-"+arch+"/file", nil, "User-Agent", agent); file.Code != http.StatusOK {
			t.Errorf("the installer downloading linux-%s answered %d", arch, file.Code)
		}
	}
}

// sh -n reads the whole script without running it: a quote left open or a case
// without its esac is a script that fails at the first paste. Dash too where it
// is installed, which is what sh is on Debian and Ubuntu.
func TestTheInstallerIsAScriptShCanRead(t *testing.T) {
	_, got := installed(t, linuxApp(t, false), "meet.example.com")

	for _, shell := range []string{"sh", "dash", "bash"} {
		path, err := exec.LookPath(shell)
		if err != nil {
			continue
		}
		check := exec.Command(path, "-n")
		check.Stdin = strings.NewReader(got.Body.String())
		if out, err := check.CombinedOutput(); err != nil {
			t.Errorf("%s -n refuses the installer: %v %s", shell, err, out)
		}
	}
}

// Everything the script says is in the terminal's language, its help and its
// refusal of an option it does not know included: the help was English alone
// at first, and the owner, reading it, asked why it was still in English. Run
// for real, since both are said before anything about the machine is asked.
func TestTheInstallerSpeaksTheTerminalsLanguage(t *testing.T) {
	_, got := installed(t, linuxApp(t, false), "meet.example.com")
	script := got.Body.String()

	run := func(lang string, args ...string) (string, int) {
		t.Helper()
		shell := exec.Command("sh", append([]string{"-s", "--"}, args...)...)
		shell.Stdin = strings.NewReader(script)
		shell.Env = []string{"LANG=" + lang, "HOME=" + t.TempDir(), "PATH=/usr/bin:/bin"}
		out, err := shell.CombinedOutput()
		code := 0
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		}
		return string(out), code
	}

	for lang, want := range map[string]string{
		"zh_CN.UTF-8": "从 http://meet.example.com 安装 Linux 版 Tomoshibi",
		"zh_TW.UTF-8": "從 http://meet.example.com 安裝 Linux 版 Tomoshibi",
		"ja_JP.UTF-8": "Linux 版 Tomoshibi を",
		"C":           "Installs the Tomoshibi app for Linux from http://meet.example.com",
	} {
		said, code := run(lang, "--help")
		if code != 0 || !strings.Contains(said, want) {
			t.Errorf("--help in %s said (exit %d):\n%s\nwant it to contain %q", lang, code, said, want)
		}
	}

	said, code := run("zh_CN.UTF-8", "--nonsense")
	if code == 0 || !strings.Contains(said, "不认识的选项：--nonsense") {
		t.Errorf("an unknown option in Chinese said (exit %d): %s", code, said)
	}
}
