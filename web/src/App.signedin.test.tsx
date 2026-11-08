import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join as requestJoin } from "@/live/api";
import { App } from "./App";

/*
 * Music and watching together are for somebody signed in, and the call asked
 * the server about both for everybody: a guest's every call printed the two
 * refusals in red in the console, where they hid the errors that mattered (the
 * health check of 2026-10-29). The page already asks on arrival whether
 * anybody is signed in, so the call is told, and does not ask what it knows
 * the answer to. Unknown is still asked.
 */

vi.mock("@/live/api", async (original) => ({
	...(await original<typeof import("@/live/api")>()),
	join: vi.fn(),
	deployment: async () => ({ openedBy: "anyone", joinedBy: "anyone", source: "" }),
}));

vi.mock("@/live/account", async (original) => ({
	...(await original<typeof import("@/live/account")>()),
	me: async () => undefined,
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

vi.mock("@/routes/Room", () => ({
	Room: ({ signedIn }: { signedIn?: boolean }) => <p>in the call, signed in: {String(signedIn)}</p>,
}));

vi.mock("@/live/notices", () => ({ newerVersion: vi.fn(), joinFailed: vi.fn(), deviceFailed: vi.fn(), watch: () => () => {} }));

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.location.hash = "#/standup";

	vi.mocked(requestJoin).mockResolvedValue({
		token: "t",
		url: "wss://relay.example.invalid",
		relay: "Shanghai",
		region: "CN-East",
		holding: "",
	} as unknown as Awaited<ReturnType<typeof requestJoin>>);

	Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
	Object.defineProperty(navigator, "mediaDevices", {
		value: { enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} },
		configurable: true,
	});
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

it("tells the call that nobody is signed in, where the page was told so", async () => {
	render(<App />);

	const name = await screen.findByLabelText("Your name");
	fireEvent.change(name, { target: { value: "Bo" } });
	fireEvent.click(screen.getByRole("button", { name: "Join" }));

	await waitFor(() => expect(screen.getByText("in the call, signed in: false")).toBeTruthy());
});

it("and the call asks neither question of somebody it knows is not signed in", () => {
	const room = readFileSync(join(import.meta.dirname, "routes/Room.tsx"), "utf8");
	const guarded = (asked: string) =>
		new RegExp(`if \\(signedIn === false\\) return;[\\s\\S]{0,200}${asked}\\(\\)`).test(room);

	expect(guarded("askLibraries"), "the music library is asked for regardless").toBe(true);
	expect(guarded("watchReady"), "watching together is asked about regardless").toBe(true);
});
