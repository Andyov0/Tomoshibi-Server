import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join as requestJoin } from "@/live/api";
import { App } from "./App";

/*
 * That the call is told which region it came in through.
 *
 * The join answers with the region of the relay this browser was sent to, and
 * that is what decides whether a YouTube video goes straight to the relay
 * (WatchScreen; live/relays.ts, mainland). Dropped anywhere between the answer
 * and the room, nothing fails: every viewer in the mainland simply goes back to
 * waiting six seconds for a YouTube that is not coming, on every video.
 */

vi.mock("@/live/api", async (original) => ({
	...(await original<typeof import("@/live/api")>()),
	join: vi.fn(),
	deployment: async () => ({ openedBy: "anyone", joinedBy: "anyone", source: "" }),
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
	Room: ({ entry }: { entry?: string }) => <p>in the call through {entry ?? "nowhere said"}</p>,
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

it("hands the room the region the join came in through", async () => {
	render(<App />);

	const name = await screen.findByLabelText("Your name");
	fireEvent.change(name, { target: { value: "Bo" } });
	fireEvent.click(screen.getByRole("button", { name: "Join" }));

	await waitFor(() => expect(screen.getByText("in the call through CN-East")).toBeTruthy());
});
