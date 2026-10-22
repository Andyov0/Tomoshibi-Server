import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/live/i18n";
import { Apps } from "./Apps";

const { actionFailed } = vi.hoisted(() => ({ actionFailed: vi.fn() }));

vi.mock("@/live/notices", () => ({ actionFailed, actionDone: vi.fn() }));

/*
 * What the download page says, for each thing the server can answer.
 *
 * The server sends codes and the page owns every sentence, so a code the page
 * does not know is a sentence nobody wrote: it would fall to "something went
 * wrong" and send somebody to try again at something that will refuse them the
 * same way. Each answer the invitation can come back with is walked here, and
 * what the reader is shown for it is pinned.
 *
 * Two of them are not sentences at all but the card changing: an account that
 * has used its invitations, and a server with no key. A notice for either would
 * fade and leave a form that refuses every press.
 *
 * And Windows, until it has a build, must be nothing anybody can press. A
 * reserved card that turned out to be a link would be a link to nowhere. Once
 * it has one, it is offered as the others are, with the two warnings an
 * unsigned installer meets said before it meets them: without those, a full
 * screen of SmartScreen blue is the page having handed somebody malware.
 */

const OFFERED = {
	mac: { available: true, version: "1.4.2", size: 84_213_760 },
	android: { available: true, version: "0.1.0.6", size: 31_457_280 },
	windows: { available: true, version: "0.1.0.2", size: 41_943_040 },
	ios: { invites: true, left: 5 },
};

/** What the server says where no Windows build has been put up. */
const NO_WINDOWS = { ...OFFERED, windows: { available: false } };

type Answer = { status: number; body: unknown };

/** A server that answers the page's question, and then each invitation in turn. */
function serve(offered: unknown, ...invitations: Answer[]) {
	const queue = [...invitations];
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/apps" && !init?.method) {
			if (offered === 401) return new Response(JSON.stringify({ error: "signed_out" }), { status: 401 });
			return new Response(JSON.stringify(offered));
		}

		if (url === "/api/apps/ios/invite") {
			const next = queue.shift() ?? { status: 500, body: {} };
			return new Response(JSON.stringify(next.body), { status: next.status });
		}

		return new Response("{}", { status: 404 });
	});

	vi.stubGlobal("fetch", fetch);

	return fetch;
}

async function open(offered: unknown, ...invitations: Answer[]) {
	const fetch = serve(offered, ...invitations);
	render(<Apps />);
	await screen.findByRole("heading", { name: "Get the apps" });
	return fetch;
}

async function send(email: string) {
	fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), { target: { value: email } });
	fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
}

afterEach(() => {
	vi.unstubAllGlobals();
	actionFailed.mockReset();
	act(() => setLocale("en"));
});

describe("somebody signed out", () => {
	it("is asked to sign in, and told what for", async () => {
		await open(401);

		expect(screen.getByText("Sign in to download Tomoshibi for Mac, Windows, iPhone, iPad and Android.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
		expect(document.querySelector('a[href^="/api/apps/"]')).toBeNull();
	});
});

describe("the Mac app", () => {
	it("is offered with its version and size, and how to install it", async () => {
		await open(OFFERED);

		const mac = screen.getByRole("region", { name: "macOS" });
		const link = within(mac).getByRole("link", { name: "Download for Mac" });

		expect(link.getAttribute("href")).toBe("/api/apps/mac");
		expect(link.hasAttribute("download")).toBe(true);
		expect(mac.textContent).toContain("Version 1.4.2");
		expect(mac.textContent).toContain("84.2");
		expect(mac.textContent).toContain("drag Tomoshibi into Applications");
	});

	it("says it is not available rather than offering a link that fails", async () => {
		await open({ ...OFFERED, mac: { available: false } });

		const mac = screen.getByRole("region", { name: "macOS" });
		expect(mac.textContent).toContain("The Mac app is not available yet.");
		expect(within(mac).queryByRole("link")).toBeNull();
	});
});

describe("the Android app", () => {
	it("is offered with its version and size, and what Android will ask", async () => {
		await open(OFFERED);

		const android = screen.getByRole("region", { name: "Android" });
		const link = within(android).getByRole("link", { name: "Download for Android" });

		expect(link.getAttribute("href")).toBe("/api/apps/android");
		expect(link.hasAttribute("download")).toBe(true);
		expect(android.textContent).toContain("Version 0.1.0.6");
		expect(android.textContent).toContain("31.5");
		expect(android.textContent).toContain("allow installing apps from your browser");
		expect(android.textContent).toContain("Android 10 or later");
		// Play Protect's warning, said before it is shown, in its own words.
		expect(android.textContent).toContain("hasn't seen an app from this developer before, tap Install anyway");
	});

	it("says it is not available rather than offering a link that fails", async () => {
		await open({ ...OFFERED, android: { available: false } });

		const android = screen.getByRole("region", { name: "Android" });
		expect(android.textContent).toContain("The Android app is not available yet.");
		expect(within(android).queryByRole("link")).toBeNull();

		// The Mac's build is its own, and stays.
		expect(within(screen.getByRole("region", { name: "macOS" })).getByRole("link")).toBeTruthy();
	});

	it("says what Android will ask in the reader's language", async () => {
		await open(OFFERED);

		act(() => setLocale("zh-Hans"));

		const android = screen.getByRole("region", { name: "Android" });
		expect(within(android).getByRole("link", { name: "下载 Android 版" })).toBeTruthy();
		expect(android.textContent).toContain("允许浏览器安装应用");
	});
});

describe("the Windows app", () => {
	it("is offered with its version and size, one installer for either PC, and both warnings said first", async () => {
		await open(OFFERED);

		const windows = screen.getByRole("region", { name: "Windows" });
		const link = within(windows).getByRole("link", { name: "Download for Windows" });

		expect(link.getAttribute("href")).toBe("/api/apps/windows");
		expect(link.hasAttribute("download")).toBe(true);
		expect(windows.textContent).toContain("Version 0.1.0.2");
		expect(windows.textContent).toContain("41.9");
		expect(windows.textContent).toContain("One installer for both x64 and ARM PCs.");
		expect(windows.textContent).toContain("Needs Windows 10 version 2004 or later, or Windows 11.");
		expect(windows.textContent).toContain("isn't commonly downloaded, choose Keep.");
		expect(windows.textContent).toContain("if Windows says it protected your PC, choose More info, then Run anyway.");
		expect(windows.textContent).not.toContain("Coming soon");
	});

	it("names the warnings as Windows does in the reader's language", async () => {
		await open(OFFERED);

		act(() => setLocale("zh-Hans"));

		const windows = screen.getByRole("region", { name: "Windows" });
		expect(within(windows).getByRole("link", { name: "下载 Windows 版" })).toBeTruthy();
		expect(windows.textContent).toContain("「Windows 已保护你的电脑」");
		expect(windows.textContent).toContain("「更多信息」");
		expect(windows.textContent).toContain("「仍要运行」");
		expect(windows.textContent).toContain("「保留」");
	});
});

describe("Windows without a build", () => {
	it("is kept a place, and nothing in it can be pressed", async () => {
		await open(NO_WINDOWS);

		const card = screen.getByRole("region", { name: "Windows" });
		expect(card.textContent).toContain("Coming soon");
		expect(card.querySelector("a, button, input, [tabindex]")).toBeNull();
	});

	it("says so in the reader's language", async () => {
		await open(NO_WINDOWS);

		act(() => setLocale("zh-Hans"));

		expect(within(screen.getByRole("region", { name: "Windows" })).getByText("敬请期待")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "下载应用" })).toBeTruthy();
	});
});

describe("a TestFlight invitation", () => {
	it("sent: says where to look and what to install first, and counts down", async () => {
		const fetch = await open(OFFERED, { status: 200, body: { result: "sent", left: 4 } });

		await send(" ada@example.com ");

		const said = await screen.findByRole("status");
		expect(said.textContent).toContain("Sent to ada@example.com.");
		expect(said.textContent).toContain("Install TestFlight first");
		expect(screen.getByText("You can invite 4 more addresses.")).toBeTruthy();

		// An email field drops the spaces round what was typed before anything
		// reads it, which is the browser's rule and not this page's; the server
		// trims as well, for whatever else posts here.
		const [, init] = fetch.mock.calls.find(([url]) => url === "/api/apps/ios/invite") ?? [];
		expect(JSON.parse(String(init?.body))).toEqual({ email: "ada@example.com" });
	});

	it("already invited: says so, and is not an error", async () => {
		await open(OFFERED, { status: 200, body: { result: "already_invited", left: 4 } });

		await send("ada@example.com");

		expect((await screen.findByRole("status")).textContent).toContain("ada@example.com was already invited.");
		expect(actionFailed).not.toHaveBeenCalled();
	});

	it.each([
		["invalid_email", 400, "That is not an email address."],
		["rate_limited", 429, "Too many attempts. Try again in a moment."],
		["testflight_refused", 502, "App Store Connect did not accept the invitation. Try again later."],
	])("%s: is a notice in the reader's words", async (code, status, sentence) => {
		await open(OFFERED, { status, body: { error: code } });

		await send("ada@example.com");

		await waitFor(() => expect(actionFailed).toHaveBeenCalledWith(sentence));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("not configured: the card says invitations are not set up, and the form goes", async () => {
		await open(OFFERED, { status: 503, body: { error: "not_configured" } });

		await send("ada@example.com");

		await screen.findByText("TestFlight invitations are not set up on this server yet.");
		expect(screen.queryByRole("textbox", { name: "Email address" })).toBeNull();
	});

	it("the account's allowance used: the card says so, and the form goes", async () => {
		await open(OFFERED, { status: 403, body: { error: "too_many_addresses" } });

		await send("ada@example.com");

		await screen.findByText("This account has invited as many addresses as one account may.");
		expect(screen.queryByRole("textbox", { name: "Email address" })).toBeNull();
	});

	it("signed out meanwhile: asks them to sign in again", async () => {
		await open(OFFERED, { status: 401, body: { error: "signed_out" } });

		await send("ada@example.com");

		expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
	});

	it("is not offered where the server has no key", async () => {
		await open({ ...OFFERED, ios: { invites: false, left: 0 } });

		expect(screen.getByText("TestFlight invitations are not set up on this server yet.")).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "Email address" })).toBeNull();
	});

	// A deployment that cannot invite by address but has the beta's public
	// link offers the link rather than a card saying nothing is offered; and
	// one that can invite never shows the link, which is for people with no
	// account to invite.
	it("gives way to the public link where the server has no key but has the link", async () => {
		const link = "https://testflight.apple.com/join/AbCd1234";

		await open({ ...OFFERED, ios: { invites: false, left: 0, link } });

		const ios = screen.getByRole("region", { name: "iOS" });
		expect(within(ios).getByRole("link", { name: "Get it on TestFlight" }).getAttribute("href")).toBe(link);
		expect(ios.textContent).not.toContain("not set up");

		cleanup();
		await open({ ...OFFERED, ios: { invites: true, left: 5, link } });

		expect(document.querySelector(`a[href="${link}"]`)).toBeNull();
		expect(screen.getByRole("textbox", { name: "Email address" })).toBeTruthy();
	});
});

/*
 * The reader's own platform first, and every other one still reachable.
 *
 * The failure this guards is quiet: a guess that put the right card first and
 * dropped an action from the rows under it. Somebody on a Mac choosing the app
 * for their phone, or an iPad taken for a Mac, would find the thing they wanted
 * gone rather than smaller, and nothing would look broken.
 */
describe("the reader's platform", () => {
	const AGENTS = {
		iPhone:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
		mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
		windows:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
		// A browser on an ARM PC that names the processor, which most do not.
		windowsOnArm:
			"Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
		android:
			"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
	};

	/** The names of the rows under "Other platforms", in the order drawn. */
	const rows = () =>
		within(screen.getByRole("heading", { name: "Other platforms" }).parentElement as HTMLElement)
			.getAllByRole("group")
			.map((row) => row.getAttribute("aria-label"));

	// jsdom has no touch points at all, so they are given to the navigator
	// itself for the length of a test rather than spied on.
	function on(userAgent: string, maxTouchPoints = 0) {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
		Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => maxTouchPoints });
	}

	afterEach(() => {
		vi.restoreAllMocks();
		Reflect.deleteProperty(navigator, "maxTouchPoints");
	});

	/** Whether a comes before b in the document. */
	const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

	it("puts iOS first on an iPhone, and keeps the Mac download in a row under it", async () => {
		on(AGENTS.iPhone, 5);
		await open(OFFERED);

		const card = screen.getByRole("region", { name: "iOS" });
		const others = screen.getByRole("heading", { name: "Other platforms" });
		expect(before(card, others)).toBe(true);
		expect(within(card).getByRole("textbox", { name: "Email address" })).toBeTruthy();

		expect(screen.queryByRole("region", { name: "macOS" })).toBeNull();
		const mac = screen.getByRole("group", { name: "macOS" });
		expect(within(mac).getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/api/apps/mac");
		expect(mac.textContent).toContain("Version 1.4.2");

		const android = screen.getByRole("group", { name: "Android" });
		expect(within(android).getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/api/apps/android");
		expect(android.textContent).toContain("Version 0.1.0.6");

		const windows = screen.getByRole("group", { name: "Windows" });
		expect(within(windows).getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/api/apps/windows");
		expect(windows.textContent).toContain("Version 0.1.0.2");

		expect(rows()).toEqual(["macOS", "Android", "Windows"]);
	});

	it("keeps Windows' row as a place kept, with nothing to press, until it has a build", async () => {
		on(AGENTS.iPhone, 5);
		await open(NO_WINDOWS);

		const windows = screen.getByRole("group", { name: "Windows" });
		expect(windows.textContent).toContain("Coming soon");
		expect(windows.querySelector("a, button, input, [tabindex]")).toBeNull();
	});

	it("puts Android first on an Android phone, with every other app still offered under it", async () => {
		on(AGENTS.android, 5);
		await open(OFFERED);

		const card = screen.getByRole("region", { name: "Android" });
		const others = screen.getByRole("heading", { name: "Other platforms" });
		expect(before(card, others)).toBe(true);
		expect(within(card).getByRole("link", { name: "Download for Android" }).getAttribute("href")).toBe(
			"/api/apps/android",
		);
		expect(card.textContent).toContain("allow installing apps from your browser");

		// The rest are rows, in the usual order with Android taken out of it.
		expect(screen.queryByRole("region", { name: "macOS" })).toBeNull();
		expect(rows()).toEqual(["macOS", "iOS", "Windows"]);
		expect(within(screen.getByRole("group", { name: "macOS" })).getByRole("link", { name: "Download" })).toBeTruthy();
		expect(within(screen.getByRole("group", { name: "iOS" })).getByRole("button", { name: "Invite by email" })).toBeTruthy();
		expect(within(screen.getByRole("group", { name: "Windows" })).getByRole("link", { name: "Download" })).toBeTruthy();
	});

	it("says so on an Android phone when there is no package yet, and still offers the others", async () => {
		on(AGENTS.android, 5);
		await open({ ...OFFERED, android: { available: false } });

		const card = screen.getByRole("region", { name: "Android" });
		expect(card.textContent).toContain("The Android app is not available yet.");
		expect(card.textContent).toContain("For Android 10 or later.");
		expect(within(card).queryByRole("link")).toBeNull();

		expect(within(screen.getByRole("group", { name: "macOS" })).getByRole("link", { name: "Download" })).toBeTruthy();
	});

	it("takes an iPad that calls itself a Mac for the iPad it is", async () => {
		on(AGENTS.mac, 5);
		await open(OFFERED);

		expect(within(screen.getByRole("region", { name: "iOS" })).getByRole("button", { name: "Send invitation" })).toBeTruthy();
		expect(screen.getByRole("group", { name: "macOS" })).toBeTruthy();
	});

	it("puts the Mac first on a Mac, and the invitation still works from its row", async () => {
		on(AGENTS.mac);
		await open(OFFERED, { status: 200, body: { result: "sent", left: 4 } });

		const card = screen.getByRole("region", { name: "macOS" });
		expect(within(card).getByRole("link", { name: "Download for Mac" })).toBeTruthy();

		const row = screen.getByRole("group", { name: "iOS" });
		expect(within(row).queryByRole("textbox")).toBeNull();

		const opener = within(row).getByRole("button", { name: "Invite by email" });
		fireEvent.click(opener);
		expect(opener.getAttribute("aria-expanded")).toBe("true");

		await send("ada@example.com");
		expect((await within(row).findByRole("status")).textContent).toContain("Sent to ada@example.com.");

		expect(rows()).toEqual(["iOS", "Android", "Windows"]);
		expect(within(screen.getByRole("group", { name: "Android" })).getByRole("link", { name: "Download" })).toBeTruthy();
	});

	it("puts Windows first on Windows, with its installer and warnings, and every other app under it", async () => {
		for (const agent of [AGENTS.windows, AGENTS.windowsOnArm]) {
			cleanup();
			on(agent);
			await open(OFFERED);

			const card = screen.getByRole("region", { name: "Windows" });
			const others = screen.getByRole("heading", { name: "Other platforms" });
			expect(before(card, others)).toBe(true);
			expect(within(card).getByRole("link", { name: "Download for Windows" }).getAttribute("href")).toBe(
				"/api/apps/windows",
			);
			expect(card.textContent).toContain("x64 and ARM PCs");
			expect(card.textContent).toContain("choose More info, then Run anyway");

			expect(rows()).toEqual(["macOS", "iOS", "Android"]);
			vi.restoreAllMocks();
		}
	});

	it("puts Windows first on Windows without a build, saying it is coming, with every app still offered under it", async () => {
		on(AGENTS.windows);
		await open(NO_WINDOWS);

		const card = screen.getByRole("region", { name: "Windows" });
		expect(card.textContent).toContain("Coming soon");
		expect(card.textContent).toContain("Until then, meetings work in this browser.");
		expect(card.querySelector("a, button, input")).toBeNull();

		expect(within(screen.getByRole("group", { name: "macOS" })).getByRole("link", { name: "Download" })).toBeTruthy();
		expect(within(screen.getByRole("group", { name: "iOS" })).getByRole("button", { name: "Invite by email" })).toBeTruthy();
		expect(within(screen.getByRole("group", { name: "Android" })).getByRole("link", { name: "Download" })).toBeTruthy();
	});

	it("promotes nothing where it cannot tell", async () => {
		on("curl/8.7.1");
		await open(OFFERED);

		expect(screen.queryByRole("heading", { name: "Other platforms" })).toBeNull();

		const cards = screen.getAllByRole("region").map((card) => card.getAttribute("aria-label"));
		expect(cards).toEqual(["macOS", "iOS", "Android", "Windows"]);
	});
});
