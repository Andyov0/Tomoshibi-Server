/**
 * Which platform the reader is probably on, for the download page to put that
 * platform's app first.
 *
 * A guess, and the page treats it as one: the other platforms stay on the page,
 * smaller, so a wrong guess costs somebody a scroll rather than the app. That
 * is also why nothing here tries hard. A user agent is whatever the browser
 * chose to say, and "Request desktop website" on a phone makes it say
 * something else on purpose.
 *
 * Asked in two places. User-Agent Client Hints first, where the browser offers
 * them (Chromium, on every platform but iOS), because there the platform is a
 * field rather than a pattern in a sentence. Then the user agent string, which
 * every browser still sends.
 *
 * The one case that needs more than reading is the iPad. iPadOS Safari asks
 * for the desktop site by default, and its user agent is then a Mac's, word for
 * word. What it cannot hide is the touch screen: no Mac has one, so a
 * "Macintosh" reporting more than one touch point is an iPad. More than one
 * rather than any: every iPad clears it, reporting five, and a Mac told it is
 * an iPad would be offered the wrong app first.
 */

export type Platform = "mac" | "ios" | "windows" | "android";

/** What the browser says about itself, as the guess reads it. */
export interface Said {
	userAgent: string;
	/** navigator.userAgentData.platform, where there is one. */
	hint?: string;
	maxTouchPoints?: number;
}

/** The platform a browser is probably on, or nothing for one this cannot place. */
export function guessPlatform({ userAgent, hint, maxTouchPoints = 0 }: Said): Platform | undefined {
	const touch = maxTouchPoints > 1;

	// The hint's own vocabulary: "Android", "Chrome OS", "Chromium OS", "iOS",
	// "Linux", "macOS", "Windows" or "Unknown". A value it names is an answer,
	// "nothing promoted" included for Linux and ChromeOS, which have no app of
	// their own; anything else falls through to the string.
	switch (hint?.trim().toLowerCase()) {
		case "android":
			return "android";
		case "ios":
			return "ios";
		case "windows":
			return "windows";
		case "macos":
			return touch ? "ios" : "mac";
		case "linux":
		case "chrome os":
		case "chromium os":
			return undefined;
	}

	// iPhone and iPod before the Mac, because their agents say "like Mac OS X";
	// Android before anything else, because its agents say "Linux".
	if (/\b(iPhone|iPod|iPad)\b/.test(userAgent)) return "ios";
	if (/\bAndroid\b/.test(userAgent)) return "android";
	if (/\bWindows\b/.test(userAgent)) return "windows";
	if (/\bMacintosh\b|\bMac OS X\b/.test(userAgent)) return touch ? "ios" : "mac";

	return undefined;
}

/**
 * Whether an iOS guess is an iPad rather than an iPhone, for a label that names
 * the device somebody is holding.
 *
 * The same evidence the guess itself reads, and nothing more: an agent that
 * says iPad, or one that says Macintosh with a touch screen behind it. Only
 * ever asked of a browser already guessed to be on iOS.
 */
export function guessIPad({ userAgent, hint, maxTouchPoints = 0 }: Said): boolean {
	if (/\b(iPhone|iPod)\b/.test(userAgent)) return false;
	if (/\biPad\b/.test(userAgent)) return true;

	const mac = hint?.trim().toLowerCase() === "macos" || /\bMacintosh\b/.test(userAgent);

	return mac && maxTouchPoints > 1;
}

/** What this browser says about itself, as the two guesses read it. */
function said(): Said | undefined {
	if (typeof navigator === "undefined") return undefined;

	const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;

	return {
		userAgent: navigator.userAgent ?? "",
		hint: data?.platform,
		maxTouchPoints: navigator.maxTouchPoints ?? 0,
	};
}

/** The guess for the browser this is running in. */
export function platform(): Platform | undefined {
	const here = said();
	return here ? guessPlatform(here) : undefined;
}

/** Whether the browser this is running in is an iPad. */
export function ipad(): boolean {
	const here = said();
	return here ? guessPlatform(here) === "ios" && guessIPad(here) : false;
}
