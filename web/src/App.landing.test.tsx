import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join as requestJoin } from "@/live/api";
import { launch } from "@/live/landing";
import { App } from "./App";

/*
 * Where the step that offers the app stands, in the page as a whole.
 *
 * In front of a first arrival on a link and nowhere else. The ways it could go
 * wrong are all somebody being shown an offer they should not be, or not
 * reaching the join screen: in front of a rejoin, which is somebody who was in
 * a call a second ago asked whether they have the app; again on every reload
 * after choosing the browser, with the invitation still in the address; in
 * front of a host who opened their own meeting from the lobby; in front of a
 * link the server refused; or the browser leading anywhere but the join screen
 * the link was for.
 */

vi.mock("@/live/platform", () => ({ platform: () => "mac", ipad: () => false }));

vi.mock("@/live/landing", async (original) => ({
	...(await original<typeof import("@/live/landing")>()),
	launch: vi.fn(),
	download: vi.fn(),
}));

vi.mock("@/live/api", async (original) => ({
	...(await original<typeof import("@/live/api")>()),
	join: vi.fn(),
	deployment: async () => ({ openedBy: "accounts", joinedBy: "invited", source: "" }),
}));

vi.mock("livekit-client", async (original) => ({
	...(await original<typeof import("livekit-client")>()),
	createLocalVideoTrack: () => Promise.resolve({ stop() {}, attach() {}, detach() {}, on() {}, off() {} }),
}));

vi.mock("@/live/room", () => ({
	create: () => ({
		disconnect: async () => {},
		once: () => {},
		on: () => {},
		off: () => {},
		localParticipant: { setMicrophoneEnabled: async () => {}, setCameraEnabled: async () => {} },
	}),
	connect: async () => {},
	tokenFor: () => "",
}));

vi.mock("@/live/freeze", () => ({ watchShareFreezes: () => () => {} }));
vi.mock("@/live/lens", () => ({ magnifyShares: () => () => {} }));
vi.mock("@/live/delay", () => ({ cushionShares: () => () => {} }));
vi.mock("@/routes/Room", () => ({ Room: () => <p>in the call</p> }));
vi.mock("@/live/notices", () => ({
	newerVersion: vi.fn(),
	joinFailed: vi.fn(),
	deviceFailed: vi.fn(),
	actionFailed: vi.fn(),
	watch: () => () => {},
}));

const OFFERED = {
	mac: { available: true, version: "1.4.2", size: 84_213_760 },
	android: { available: false },
	windows: { available: false },
	ios: { invites: false, left: 0, link: "https://testflight.apple.com/join/AbCd1234" },
};

/** What the server answers, by path; the apps' answer replaceable per test. */
let apps: { status: number; body: unknown };
let asked: string[];

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, "", "/?invite=T0k3n#/standup");
	Object.defineProperty(document, "referrer", { value: "", configurable: true });

	apps = { status: 200, body: OFFERED };
	asked = [];

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			asked.push(input);

			if (input === "/api/invites/T0k3n") return new Response(JSON.stringify({ room: "standup" }));
			if (input === "/api/apps?invite=T0k3n" || input === "/api/apps?meeting=M33t") {
				return new Response(JSON.stringify(apps.body), { status: apps.status });
			}
			if (input === "/api/relays") return new Response(JSON.stringify({ relays: [], measure: false }));

			return new Response(JSON.stringify({ error: "not_signed_in" }), { status: 401 });
		}),
	);

	vi.mocked(requestJoin).mockResolvedValue({
		token: "t",
		url: "wss://relay.example.invalid",
		identity: "g1",
		room: "standup",
	} as Awaited<ReturnType<typeof requestJoin>>);

	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	// Chrome, which is where a Mac is asked for the app on arrival; Safari
	// is not (live/landing.ts).
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	);

	Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
	Object.defineProperty(navigator, "mediaDevices", {
		value: { enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} },
		configurable: true,
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.mocked(requestJoin).mockReset();
	vi.mocked(launch).mockClear();
	window.history.replaceState(null, "", "/");
});

describe("a link opened in a browser", () => {
	it("is met by the app, and the browser leads to the join screen for the room it names", async () => {
		render(<App />);

		expect(await screen.findByText("Opening Tomoshibi…")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Join in the browser" }));

		expect(await screen.findByLabelText("Your name")).toBeDefined();
		expect(screen.queryByText("Opening Tomoshibi…")).toBeNull();

		// Remembered for the tab, so a reload of this screen is not met again.
		expect(sessionStorage.getItem("meet-live.landed")).toBe("T0k3n");
	});

	it("is not met again in a tab that has already chosen the browser for it", async () => {
		sessionStorage.setItem("meet-live.landed", "T0k3n");

		render(<App />);

		expect(await screen.findByLabelText("Your name")).toBeDefined();
		expect(screen.queryByText("Opening Tomoshibi…")).toBeNull();
		expect(asked).not.toContain("/api/apps?invite=T0k3n");
	});

	// A meeting link in the address of a tab that was in that meeting, which is
	// the one way a link arrives as a rejoin (live/doorway.ts): straight back
	// in, with the app offered to nobody, though the link is fresh and this
	// device has an app on offer.
	it("is not met on the way back into a call", async () => {
		window.history.replaceState(null, "", "/?meeting=M33t#/standup");
		sessionStorage.setItem("meet-live.was-in", "standup");
		apps = { status: 200, body: OFFERED };

		render(<App />);

		await waitFor(() => expect(requestJoin).toHaveBeenCalled());
		expect(await screen.findByText("in the call")).toBeDefined();

		// Never drawn, not even for the moment before the call came back: a
		// step that was drawn asks the app at once.
		expect(launch).not.toHaveBeenCalled();
	});

	it("is not met by somebody who came from this deployment's own pages", async () => {
		Object.defineProperty(document, "referrer", { value: `${window.location.origin}/`, configurable: true });

		render(<App />);

		expect(await screen.findByLabelText("Your name")).toBeDefined();
		expect(screen.queryByText("Opening Tomoshibi…")).toBeNull();
	});

	it("is not met where the server will not offer the app on the link", async () => {
		apps = { status: 403, body: { error: "no_such_invite" } };

		render(<App />);

		expect(await screen.findByLabelText("Your name")).toBeDefined();
		expect(screen.queryByText("Opening Tomoshibi…")).toBeNull();
	});

	it("is not met where there is nothing for this device", async () => {
		apps = { status: 200, body: { ...OFFERED, mac: { available: false } } };

		render(<App />);

		expect(await screen.findByLabelText("Your name")).toBeDefined();
		expect(screen.queryByText("Opening Tomoshibi…")).toBeNull();
	});
});
