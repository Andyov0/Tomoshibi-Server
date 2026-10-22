import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Offered } from "@/components/apps/shelves";
import { download, launch } from "@/live/landing";
import { Landing, type LandingProps } from "./Landing";

vi.mock("@/live/landing", async (original) => ({
	...(await original<typeof import("@/live/landing")>()),
	launch: vi.fn(),
	download: vi.fn(),
}));

vi.mock("@/live/notices", () => ({ actionFailed: vi.fn() }));

/*
 * The step in front of the join screen, as somebody holding a link meets it.
 *
 * Each of these fails where nobody is looking. A computer that downloads the
 * app when the app has just opened is fifty megabytes nobody asked for; a phone
 * that downloads by itself is the same on somebody's mobile data; an iPhone
 * that asks for the app by its scheme on arrival is Safari's "address is
 * invalid" alert for everybody without it, and a Windows PC that does is a
 * dialog from Windows about finding an app; an unsigned Windows installer that
 * downloads by itself is a browser warning about a file nobody asked for;
 * WeChat asked to open an app is a button that does nothing. And the browser
 * is one press away throughout, and leaves rather than vanishing.
 */

const OFFERED: Offered = {
	mac: { available: true, version: "1.4.2", size: 84_213_760 },
	android: { available: true, version: "0.1.0.6", size: 31_457_280 },
	windows: { available: true, version: "0.1.0.2", size: 41_943_040 },
	ios: { invites: false, left: 0, link: "https://testflight.apple.com/join/AbCd1234" },
};

const LINK = { kind: "invite", token: "T0k3n" } as const;

function open(props: Partial<LandingProps> = {}) {
	const onBrowser = vi.fn();

	render(
		<Landing
			link={LINK}
			room="standup"
			offered={OFFERED}
			device="mac"
			ipad={false}
			inApp={false}
			onBrowser={onBrowser}
			{...props}
		/>,
	);

	return onBrowser;
}

/** Let the app have its two seconds, and whatever leaves and arrives after them. */
async function waitOut(ms = 2000) {
	await act(async () => {
		vi.advanceTimersByTime(ms);
	});
	await act(async () => {
		vi.advanceTimersByTime(400);
	});
}

const CHROME_ON_A_MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const CHROME_ON_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** The browser the step is open in, as its agent says. */
function browsing(userAgent: string) {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(launch).mockClear();
	vi.mocked(download).mockClear();
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	// Chrome unless a test says otherwise, which is the browser that asks on
	// arrival everywhere the step does.
	browsing(CHROME_ON_A_MAC);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("on a computer", () => {
	it("asks the app to open the link, by the scheme the apps read", () => {
		open();

		expect(launch).toHaveBeenCalledWith(`tomoshibi://${window.location.host}/?invite=T0k3n#/standup`);
		expect(screen.getByText("Opening Tomoshibi…")).toBeDefined();
		expect(download).not.toHaveBeenCalled();
	});

	it("downloads the app when it has not taken over in two seconds, and says so", async () => {
		open();

		await waitOut();

		expect(download).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledWith("/api/apps/mac?invite=T0k3n");
		expect(screen.getByText("Your download has started.")).toBeDefined();

		// And the way back into the app once it is installed.
		expect(screen.getByRole("button", { name: "Open Tomoshibi" })).toBeDefined();
	});

	it("does not download what has just opened", async () => {
		open();

		act(() => {
			window.dispatchEvent(new Event("blur"));
		});
		await waitOut();

		expect(download).not.toHaveBeenCalled();
		expect(screen.getByText("Continue in the Tomoshibi app.")).toBeDefined();
	});

	it("downloads at once for somebody who says they do not have it", async () => {
		open();

		fireEvent.click(screen.getByRole("button", { name: "I don't have the app" }));
		await waitOut(0);

		expect(download).toHaveBeenCalledTimes(1);

		// Not a second time when the two seconds run out.
		await waitOut();
		expect(download).toHaveBeenCalledTimes(1);
	});

	it("in Safari on a Mac asks the app only when pressed, and downloads nothing by itself", async () => {
		// Safari answers a scheme nobody claims with an error, and nobody
		// without the app should be greeted by one.
		browsing("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15");
		open();

		expect(launch).not.toHaveBeenCalled();
		await waitOut();
		expect(download).not.toHaveBeenCalled();

		expect(screen.getByText("Get the Mac app")).toBeDefined();
		expect(screen.getByRole("link", { name: /Download/ }).getAttribute("href")).toBe("/api/apps/mac?invite=T0k3n");

		fireEvent.click(screen.getByRole("button", { name: "Open Tomoshibi" }));
		expect(launch).toHaveBeenCalledWith(`tomoshibi://${window.location.host}/?invite=T0k3n#/standup`);
	});

	it("on Windows offers the installer and both of its warnings, and downloads and asks nothing by itself", async () => {
		browsing(CHROME_ON_WINDOWS);
		open({ device: "windows" });

		expect(launch).not.toHaveBeenCalled();
		await waitOut();
		expect(launch).not.toHaveBeenCalled();
		expect(download).not.toHaveBeenCalled();

		expect(screen.getByRole("heading", { name: "Get the Windows app" })).toBeDefined();

		const take = screen.getByRole("link", { name: "Download for Windows" });
		expect(take.getAttribute("href")).toBe("/api/apps/windows?invite=T0k3n");
		expect(take.hasAttribute("download")).toBe(true);

		const said = document.body.textContent ?? "";
		expect(said).toContain("Version 0.1.0.2");
		expect(said).toContain("One installer for both x64 and ARM PCs.");
		expect(said).toContain("Needs Windows 10 version 2004 or later, or Windows 11.");
		expect(said).toContain("isn't commonly downloaded, choose Keep.");
		expect(said).toContain("if Windows says it protected your PC, choose More info, then Run anyway.");

		// The app is asked only when pressed, by the same link the others are.
		fireEvent.click(screen.getByRole("button", { name: "Open Tomoshibi" }));
		expect(launch).toHaveBeenCalledWith(`tomoshibi://${window.location.host}/?invite=T0k3n#/standup`);
	});

	// The one way back to the offer that runs the Mac's automatic download: the
	// app asked, the window losing focus to whatever answered, and "Get the
	// app" pressed. On Windows that is the button again, and no file.
	it("on Windows, coming back from asking the app, offers the button again rather than a download", async () => {
		browsing(CHROME_ON_WINDOWS);
		open({ device: "windows" });

		fireEvent.click(screen.getByRole("button", { name: "Open Tomoshibi" }));
		act(() => {
			window.dispatchEvent(new Event("blur"));
		});
		await waitOut();

		expect(screen.getByText("Continue in the Tomoshibi app.")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Get the app" }));
		await waitOut(0);

		expect(download).not.toHaveBeenCalled();
		expect(screen.getByRole("link", { name: "Download for Windows" })).toBeDefined();
	});

	it("on Windows without a build says the app is coming, and asks nothing of an app that is not there", () => {
		browsing(CHROME_ON_WINDOWS);
		open({ device: "windows", offered: { ...OFFERED, windows: { available: false } } });

		expect(launch).not.toHaveBeenCalled();
		expect(screen.getByText("The Windows app is coming soon.")).toBeDefined();
		expect(screen.queryByRole("link", { name: "Download for Windows" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Open Tomoshibi" })).toBeNull();
	});
});

describe("on a phone", () => {
	it("on Android asks the app, then offers a button rather than downloading", async () => {
		open({ device: "android" });

		expect(launch).toHaveBeenCalledTimes(1);

		await waitOut();

		expect(download).not.toHaveBeenCalled();

		const take = screen.getByRole("link", { name: "Download for Android" });
		expect(take.getAttribute("href")).toBe("/api/apps/android?invite=T0k3n");
		expect(screen.getByText(/Play Protect/)).toBeDefined();
	});

	it("in an Android app's own WebView asks the app only when pressed", () => {
		// Not on the list of apps that open nothing, so offered the app; but a
		// WebView may load the scheme itself, and asked on arrival that replaced
		// the page before anybody had pressed anything.
		browsing(
			"Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36 Reader/5.2.1",
		);
		open({ device: "android" });

		expect(launch).not.toHaveBeenCalled();
		expect(screen.getByRole("link", { name: "Download for Android" })).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Open Tomoshibi" }));
		expect(launch).toHaveBeenCalledWith(`tomoshibi://${window.location.host}/?invite=T0k3n#/standup`);
	});

	it("on an iPhone asks the app only when pressed, and offers the public link", () => {
		open({ device: "ios" });

		expect(launch).not.toHaveBeenCalled();
		expect(screen.getByRole("link", { name: "Get it on TestFlight" }).getAttribute("href")).toBe(
			"https://testflight.apple.com/join/AbCd1234",
		);

		fireEvent.click(screen.getByRole("button", { name: "Open Tomoshibi" }));
		expect(launch).toHaveBeenCalledTimes(1);
	});

	it("on an iPhone signed in offers the invitation by address, and no public link", () => {
		open({ device: "ios", offered: { ...OFFERED, ios: { invites: true, left: 5 } } });

		expect(screen.getByRole("textbox", { name: "Email address" })).toBeDefined();
		expect(screen.queryByRole("link", { name: "Get it on TestFlight" })).toBeNull();
	});

	it("names the iPad as an iPad", () => {
		open({ device: "ios", ipad: true });

		expect(screen.getByRole("heading", { name: "Get the iPad app" })).toBeDefined();
	});
});

describe("inside an app's own browser", () => {
	it("says to open the page in the browser, and opens and downloads nothing", async () => {
		open({ device: "android", inApp: true });

		expect(screen.getByText("Open this page in your browser")).toBeDefined();

		await waitOut();

		expect(launch).not.toHaveBeenCalled();
		expect(download).not.toHaveBeenCalled();
		expect(screen.queryByRole("link", { name: "Download for Android" })).toBeNull();
	});
});

describe("the browser", () => {
	it("is one press away, and leaves before it goes", async () => {
		const onBrowser = open();

		fireEvent.click(screen.getByRole("button", { name: "Join in the browser" }));

		// Leaving rather than gone.
		expect(onBrowser).not.toHaveBeenCalled();
		expect(document.querySelector(".animate-depart")).not.toBeNull();

		await act(async () => {
			vi.advanceTimersByTime(200);
		});

		expect(onBrowser).toHaveBeenCalledTimes(1);

		// And the app's two seconds, which were running, decide nothing now.
		await waitOut();
		expect(download).not.toHaveBeenCalled();
	});
});
