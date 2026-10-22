import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/live/i18n";
import { GetTheApp } from "./GetTheApp";

/*
 * The way to the apps, named for the device somebody is holding.
 *
 * A label for the wrong device is worse than a generic one: an iPhone told to
 * "get the Mac app" reads as the card being for somebody else. So every agent
 * the download page tells apart is walked here, and Windows and an unknown
 * agent must get the generic label, since neither has an app of its own.
 */

const AGENTS = {
	iPhone:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
	mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
	windows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	android:
		"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
	linux: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
};

// jsdom has no touch points, so they are given to the navigator itself for the
// length of a test.
function on(userAgent: string, maxTouchPoints = 0) {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
	Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => maxTouchPoints });
}

afterEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, "maxTouchPoints");
	act(() => setLocale("en"));
});

describe("the way to the apps", () => {
	it.each([
		["an iPhone", AGENTS.iPhone, 5, "Get the iPhone app"],
		["an iPad that calls itself a Mac", AGENTS.mac, 5, "Get the iPad app"],
		["a Mac", AGENTS.mac, 0, "Get the Mac app"],
		["Windows", AGENTS.windows, 0, "Get the apps"],
		["an Android phone", AGENTS.android, 5, "Get the Android app"],
		["an agent it cannot place", AGENTS.linux, 0, "Get the apps"],
	] as const)("is named for %s", (_, userAgent, touch, label) => {
		on(userAgent, touch);
		render(<GetTheApp />);

		const link = screen.getByRole("link");
		expect(link.getAttribute("href")).toBe("/apps");
		expect(link.textContent).toContain(label);
	});

	it("says it in the reader's language", () => {
		on(AGENTS.iPhone, 5);
		render(<GetTheApp />);

		act(() => setLocale("zh-Hans"));

		expect(screen.getByRole("link").textContent).toContain("下载 iPhone 版");
	});

	it("names Android in the reader's language, with what it needs", () => {
		on(AGENTS.android, 5);
		render(<GetTheApp />);

		act(() => setLocale("zh-Hans"));

		const link = screen.getByRole("link");
		expect(link.textContent).toContain("下载 Android 版");
		expect(link.textContent).toContain("Android 10");
	});
});
