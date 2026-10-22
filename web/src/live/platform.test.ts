import { describe, expect, it } from "vitest";
import { guessIPad, guessPlatform } from "./platform";

/*
 * Which app the download page puts first.
 *
 * Wrong in the quiet direction, a guess costs a scroll; wrong in the loud one,
 * somebody on an iPhone is handed a disk image as the page's main offer. The
 * strings here are the ones those browsers actually send. The case that
 * deserves the most care is the iPad, whose Safari sends a Mac's agent word for
 * word and is told apart only by its touch screen — and the same agent with no
 * touch screen must stay a Mac, or every Mac is offered TestFlight.
 */

const AGENTS = {
	iPhone:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
	iPod: "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1",
	iPadAsItself:
		"Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.7 Mobile/15E148 Safari/604.1",
	// iPadOS Safari by default, and a Mac's Safari: the same string.
	macintosh:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
	chromeOnMac:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	windows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
	android:
		"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
	linux: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
	chromeOS:
		"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	nonsense: "curl/8.7.1",
};

describe("from the user agent alone", () => {
	it.each([
		["iPhone", AGENTS.iPhone, 5, "ios"],
		["iPod", AGENTS.iPod, 5, "ios"],
		["an iPad that says so", AGENTS.iPadAsItself, 5, "ios"],
		["a Mac", AGENTS.macintosh, 0, "mac"],
		["Chrome on a Mac", AGENTS.chromeOnMac, 0, "mac"],
		["Windows", AGENTS.windows, 0, "windows"],
		["Android", AGENTS.android, 5, "android"],
	] as const)("%s", (_, userAgent, maxTouchPoints, want) => {
		expect(guessPlatform({ userAgent, maxTouchPoints })).toBe(want);
	});

	it("takes a Macintosh with a touch screen for the iPad it is", () => {
		expect(guessPlatform({ userAgent: AGENTS.macintosh, maxTouchPoints: 5 })).toBe("ios");
	});

	it("keeps a Macintosh reporting one touch point a Mac", () => {
		expect(guessPlatform({ userAgent: AGENTS.macintosh, maxTouchPoints: 1 })).toBe("mac");
	});

	it.each([
		["Linux", AGENTS.linux],
		["ChromeOS", AGENTS.chromeOS],
		["something that is not a browser", AGENTS.nonsense],
		["nothing at all", ""],
	])("promotes nothing for %s", (_, userAgent) => {
		expect(guessPlatform({ userAgent })).toBeUndefined();
	});
});

describe("from the client hint, where there is one", () => {
	it("is believed over the string", () => {
		// A field rather than a pattern in a sentence, so where the two
		// disagree the field wins.
		expect(guessPlatform({ userAgent: AGENTS.linux, hint: "Android" })).toBe("android");
		expect(guessPlatform({ userAgent: AGENTS.chromeOnMac, hint: "Windows" })).toBe("windows");
		expect(guessPlatform({ userAgent: AGENTS.windows, hint: "macOS" })).toBe("mac");
	});

	it("still reads the touch screen for macOS", () => {
		expect(guessPlatform({ userAgent: AGENTS.macintosh, hint: "macOS", maxTouchPoints: 5 })).toBe("ios");
	});

	it("is an answer when it names a platform with no app", () => {
		expect(guessPlatform({ userAgent: AGENTS.windows, hint: "Linux" })).toBeUndefined();
		expect(guessPlatform({ userAgent: AGENTS.windows, hint: "Chrome OS" })).toBeUndefined();
	});

	it("is passed over when empty or unknown", () => {
		expect(guessPlatform({ userAgent: AGENTS.windows, hint: "" })).toBe("windows");
		expect(guessPlatform({ userAgent: AGENTS.android, hint: "Unknown" })).toBe("android");
	});
});

describe("an iPad, for the label that names it", () => {
	it("is an iPad when it says so, or is a Macintosh with a touch screen", () => {
		expect(guessIPad({ userAgent: AGENTS.iPadAsItself, maxTouchPoints: 5 })).toBe(true);
		expect(guessIPad({ userAgent: AGENTS.macintosh, maxTouchPoints: 5 })).toBe(true);
		expect(guessIPad({ userAgent: AGENTS.chromeOnMac, hint: "macOS", maxTouchPoints: 5 })).toBe(true);
	});

	it("is not an iPhone, an iPod, or a Mac", () => {
		expect(guessIPad({ userAgent: AGENTS.iPhone, maxTouchPoints: 5 })).toBe(false);
		expect(guessIPad({ userAgent: AGENTS.iPod, maxTouchPoints: 5 })).toBe(false);
		expect(guessIPad({ userAgent: AGENTS.macintosh, maxTouchPoints: 0 })).toBe(false);
	});
});
