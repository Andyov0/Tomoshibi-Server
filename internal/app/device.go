package app

import (
	"regexp"
	"strings"

	"tomoshibi/internal/store"
)

/*
What somebody joined from, for the management pages.

An operator helping somebody whose call will not connect asks first what they
are using, and until this was kept the answer was in nobody's records: the
media server learns only the SDK and whatever the SDK volunteers, and the
history kept the address and the name. So the join reads its own request once,
at the door, and the arrival keeps what it found.

The apps say who they are in their own words. Their requests carry a user agent
of the form

	Tomoshibi/0.1.0.8 (iPhone; iOS 27.0.1; iPhone17,1)

set in the core they share (core/protocol/src/api/mod.rs in the native
repository), so that one change names every platform the core runs on. An app
from before that change sent no user agent at all, which no browser does, and
is recorded as an app that did not say which.

A browser is read from its user agent the way the people reading the page
would name it: the browser and its major version, and the system. Browsers
have frozen most of what they used to say about the system (every Mac is
10_15_7, every Windows is NT 10.0), so the system's version is kept only where
it is still true, on a phone. Client hints would say more, but only to a page
that asks for them first, and the join is the first request that matters.

None of this is evidence: a user agent is whatever the caller sends. It is the
answer to "what were they using", which is the question it is kept for.
*/

// agentKept is how much of a user agent is kept as sent, past which it is
// somebody's extension list rather than anything an operator reads.
const agentKept = 256

var (
	appAgent = regexp.MustCompile(`^Tomoshibi/(.+?) \(([^()]*)\)\s*$`)

	// The browsers, in the order they have to be asked: each that is built on
	// Chrome says Chrome as well, and Chrome says Safari.
	browsers = []struct {
		name  string
		token *regexp.Regexp
	}{
		{"WeChat", regexp.MustCompile(`MicroMessenger/(\d+)`)},
		{"QQ", regexp.MustCompile(`\bQQ/(\d+)`)},
		{"QQ Browser", regexp.MustCompile(`M?QQBrowser/(\d+)`)},
		{"UC Browser", regexp.MustCompile(`UCBrowser/(\d+)`)},
		{"Samsung Internet", regexp.MustCompile(`SamsungBrowser/(\d+)`)},
		{"Edge", regexp.MustCompile(`Edg(?:e|A|iOS)?/(\d+)`)},
		{"Opera", regexp.MustCompile(`OPR/(\d+)`)},
		{"Firefox", regexp.MustCompile(`(?:Firefox|FxiOS)/(\d+)`)},
		{"Chrome", regexp.MustCompile(`(?:Chrome|CriOS)/(\d+)`)},
		{"Safari", regexp.MustCompile(`Version/(\d+)(?:\.\d+)*.*Safari/`)},
	}

	iosVersion     = regexp.MustCompile(`OS (\d+(?:_\d+)*) like Mac OS X`)
	androidVersion = regexp.MustCompile(`Android (\d+(?:\.\d+)*)`)
)

// clientOf is what a join's request says it came from.
func clientOf(agent string) *store.Client {
	agent = strings.TrimSpace(agent)
	kept := agent
	if len(kept) > agentKept {
		// Cut at a byte count, then rid of any character the cut split.
		kept = strings.ToValidUTF8(kept[:agentKept], "")
	}

	if agent == "" {
		return &store.Client{Kind: "app"}
	}

	if found := appAgent.FindStringSubmatch(agent); found != nil {
		return appClient(found[1], found[2], kept)
	}

	client := &store.Client{Kind: "other", Agent: kept}

	for _, one := range browsers {
		if found := one.token.FindStringSubmatch(agent); found != nil {
			client.Kind = "web"
			client.Browser = one.name + " " + found[1]
			if strings.Contains(agent, "HeadlessChrome") {
				client.Browser = "Headless Chrome " + found[1]
			}
			break
		}
	}

	client.System = systemOf(agent)

	return client
}

// appClient reads one of the apps' own user agents: a version, then the
// platform, the system and the model, any of the last two possibly missing.
func appClient(version, detail, kept string) *store.Client {
	parts := strings.Split(detail, ";")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}

	client := &store.Client{Kind: "app", App: strings.TrimSpace(version), Agent: kept}

	switch strings.ToLower(parts[0]) {
	case "iphone":
		client.Kind = "iphone"
	case "ipad":
		client.Kind = "ipad"
	case "mac":
		client.Kind = "mac"
	case "android":
		client.Kind = "android"
	case "windows":
		client.Kind = "windows"
	}

	if len(parts) > 1 {
		client.System = parts[1]
	}
	if len(parts) > 2 {
		client.Device = parts[2]
	}

	return client
}

// systemOf names the system under a browser. A phone's version is kept,
// since a phone's browser still says it; a computer's is not, since it is
// frozen and would be wrong for most of the people it was shown for.
func systemOf(agent string) string {
	switch {
	case strings.Contains(agent, "iPhone"):
		if found := iosVersion.FindStringSubmatch(agent); found != nil {
			return "iOS " + strings.ReplaceAll(found[1], "_", ".")
		}
		return "iOS"
	case strings.Contains(agent, "iPad"):
		if found := iosVersion.FindStringSubmatch(agent); found != nil {
			return "iPadOS " + strings.ReplaceAll(found[1], "_", ".")
		}
		return "iPadOS"
	case strings.Contains(agent, "Android"):
		if found := androidVersion.FindStringSubmatch(agent); found != nil {
			return "Android " + found[1]
		}
		return "Android"
	case strings.Contains(agent, "Windows"):
		return "Windows"
	case strings.Contains(agent, "CrOS"):
		return "ChromeOS"
	// An iPad asks for the desktop page by default and says Macintosh; it
	// cannot be told from a Mac here, and is not guessed at.
	case strings.Contains(agent, "Macintosh"), strings.Contains(agent, "Mac OS X"):
		return "macOS"
	case strings.Contains(agent, "Linux"):
		return "Linux"
	}
	return ""
}
