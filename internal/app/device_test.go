package app

import (
	"net/http"
	"strings"
	"testing"

	"tomoshibi/internal/store"
)

/*
What a join is recorded as having come from.

The faults this guards are quiet ones. A browser built on Chrome says Chrome
too, and Chrome says Safari, so a list asked in the wrong order calls every
Edge a Chrome and every Chrome a Safari, and the page still looks right. And
an app from before the apps named themselves sends no user agent at all; read
as "other" it would look like a script rather than somebody on an old build.
*/

func TestTheAppsAreReadFromTheirOwnAgent(t *testing.T) {
	cases := []struct {
		agent string
		want  store.Client
	}{
		{"Tomoshibi/0.1.0.8 (iPhone; iOS 27.0.1; iPhone17,1)",
			store.Client{Kind: "iphone", App: "0.1.0.8", System: "iOS 27.0.1", Device: "iPhone17,1"}},
		{"Tomoshibi/0.1.0.8 (iPad; iPadOS 27.0; iPad16,3)",
			store.Client{Kind: "ipad", App: "0.1.0.8", System: "iPadOS 27.0", Device: "iPad16,3"}},
		{"Tomoshibi/0.1.0.8 (Mac; macOS 27.0; Mac16,7)",
			store.Client{Kind: "mac", App: "0.1.0.8", System: "macOS 27.0", Device: "Mac16,7"}},
		{"Tomoshibi/0.1.0.1 (Android; Android 16; samsung SM-F956B)",
			store.Client{Kind: "android", App: "0.1.0.1", System: "Android 16", Device: "samsung SM-F956B"}},
		{"Tomoshibi/0.1.0 (Windows)",
			store.Client{Kind: "windows", App: "0.1.0"}},
		// A platform this server has not heard of is still an app.
		{"Tomoshibi/1.0 (Vision; visionOS 3)",
			store.Client{Kind: "app", App: "1.0", System: "visionOS 3"}},
	}

	for _, c := range cases {
		got := clientOf(c.agent)
		got.Agent = ""
		if *got != c.want {
			t.Errorf("%q: got %+v, want %+v", c.agent, *got, c.want)
		}
	}
}

func TestAnAppTooOldToSayIsStillAnApp(t *testing.T) {
	if got := clientOf(""); got.Kind != "app" || got.App != "" {
		t.Errorf("no user agent: got %+v, want an app that did not say which", *got)
	}
}

func TestBrowsersAreNamedAsTheirUsersWouldNameThem(t *testing.T) {
	cases := []struct {
		agent, browser, system string
	}{
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
			"Chrome 155", "Windows"},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
			"Edge 155", "Windows"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0",
			"Firefox 144", "macOS"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
			"Safari 27", "macOS"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1",
			"Safari 27", "iOS 27.2"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1",
			"Chrome 155", "iOS 27.2"},
		{"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36 EdgA/155.0.0.0",
			"Edge 155", "Android 10"},
		{"Mozilla/5.0 (Linux; Android 16; SM-F956B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/140.0.0.0 Mobile Safari/537.36",
			"Samsung Internet 29", "Android 16"},
		{"Mozilla/5.0 (Linux; Android 14; V2307A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.103 Mobile Safari/537.36 XWEB/1300333 MMWEBSDK/20241103 MMWEBID/2217 MicroMessenger/8.0.55.2780(0x28003737) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64",
			"WeChat 8", "Android 14"},
		{"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 OPR/120.0.0.0",
			"Opera 120", "Linux"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36",
			"Headless Chrome 155", "macOS"},
		{"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
			"Chrome 155", "ChromeOS"},
	}

	for _, c := range cases {
		got := clientOf(c.agent)
		if got.Kind != "web" || got.Browser != c.browser || got.System != c.system {
			t.Errorf("%s\n  got %s / %s / %s, want web / %s / %s", c.agent, got.Kind, got.Browser, got.System, c.browser, c.system)
		}
		if want := c.agent[:min(len(c.agent), agentKept)]; got.Agent != want {
			t.Errorf("the agent as sent was not kept: %q", got.Agent)
		}
	}
}

func TestSomethingElseIsOther(t *testing.T) {
	got := clientOf("curl/8.11.0")
	if got.Kind != "other" || got.Browser != "" || got.Agent != "curl/8.11.0" {
		t.Errorf("curl: got %+v", *got)
	}
}

func TestALongAgentIsCutShort(t *testing.T) {
	long := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0 Safari/537.36 " + strings.Repeat("x", 1000)
	got := clientOf(long)
	if len(got.Agent) != agentKept || got.Browser != "Chrome 155" {
		t.Errorf("kept %d bytes as %q", len(got.Agent), got.Browser)
	}
}

// Through the router: a join keeps what it came from, and one with no user
// agent, the apps before they said, is kept as an app rather than nothing.
func TestAJoinKeepsWhatItCameFrom(t *testing.T) {
	app, mux := mount(t, nil)

	cases := []struct {
		agent string
		kind  string
	}{
		{"Tomoshibi/0.1.0.8 (iPhone; iOS 27.0.1; iPhone17,1)", "iphone"},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36", "web"},
		{"", "app"},
	}

	for _, c := range cases {
		request := join("standup", "")
		// httptest gives every request a user agent of its own unless told
		// otherwise; an empty one is the case the old apps make.
		request.Header.Set("User-Agent", c.agent)
		if code := ask(mux, request).Code; code != http.StatusOK {
			t.Fatalf("join answered %d", code)
		}
	}

	visits, _ := app.store.Visits("standup", 0)
	if len(visits) != len(cases) {
		t.Fatalf("%d visits recorded, want %d", len(visits), len(cases))
	}

	// Newest first.
	for i, c := range cases {
		got := visits[len(cases)-1-i].Client
		if got == nil || got.Kind != c.kind {
			t.Errorf("join from %q recorded as %+v, want kind %q", c.agent, got, c.kind)
		}
	}
}
