import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join as requestJoin } from "@/live/api";
import { joinFailed } from "@/live/notices";
import { App } from "./App";

/*
 * A browser that will not keep anything.
 *
 * With site data blocked, and in some private windows, local and session
 * storage throw on first touch -- the getter itself refuses. This client read
 * them while drawing and wrote them at the top of the join, so in such a
 * browser the first screen did not draw, and where it did, the Join button
 * threw before doing anything. Everything kept is a convenience; the call is
 * not.
 */

const camera = { stop: vi.fn(), attach: vi.fn(), detach: vi.fn() };

vi.mock("livekit-client", async (original) => ({
	...(await original<typeof import("livekit-client")>()),
	createLocalVideoTrack: () => Promise.resolve(camera),
}));

vi.mock("@/live/api", async (original) => ({
	...(await original<typeof import("@/live/api")>()),
	join: vi.fn(),
	deployment: async () => ({ openedBy: "anyone", joinedBy: "anyone", source: "" }),
}));

const microphone = vi.fn(() => Promise.resolve());
const cameraOn = vi.fn(() => Promise.resolve());

vi.mock("@/live/room", () => ({
	create: () => ({
		disconnect: async () => {},
		once: () => {},
		on: () => {},
		off: () => {},
		localParticipant: { setMicrophoneEnabled: microphone, setCameraEnabled: cameraOn },
	}),
	connect: async () => {},
	tokenFor: () => "",
}));

vi.mock("@/live/freeze", () => ({ watchShareFreezes: () => () => {} }));
vi.mock("@/live/lens", () => ({ magnifyShares: () => () => {} }));
vi.mock("@/live/delay", () => ({ cushionShares: () => () => {} }));

// The call itself is not what is under test, and a real one wants a real room.
vi.mock("@/routes/Room", () => ({ Room: () => <p>in the call</p> }));

vi.mock("@/live/notices", () => ({ newerVersion: vi.fn(), joinFailed: vi.fn(), deviceFailed: vi.fn(), watch: () => () => {} }));

const kept = {
	local: Object.getOwnPropertyDescriptor(window, "localStorage"),
	session: Object.getOwnPropertyDescriptor(window, "sessionStorage"),
};

function refuse(name: "localStorage" | "sessionStorage") {
	Object.defineProperty(window, name, {
		configurable: true,
		get() {
			throw new DOMException("The operation is insecure.", "SecurityError");
		},
	});
}

beforeEach(() => {
	window.location.hash = "#/standup";

	vi.mocked(requestJoin).mockResolvedValue({
		token: "t",
		url: "wss://relay.example.invalid",
		relay: "",
		holding: "",
	} as unknown as Awaited<ReturnType<typeof requestJoin>>);

	Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
	Object.defineProperty(navigator, "mediaDevices", {
		value: { enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} },
		configurable: true,
	});

	refuse("localStorage");
	refuse("sessionStorage");
});

afterEach(() => {
	cleanup();
	if (kept.local) Object.defineProperty(window, "localStorage", kept.local);
	if (kept.session) Object.defineProperty(window, "sessionStorage", kept.session);
});

it("draws the first screen and joins with storage that refuses every touch", async () => {
	render(<App />);

	const name = await screen.findByLabelText("Your name");
	fireEvent.change(name, { target: { value: "Bo" } });
	fireEvent.click(screen.getByRole("button", { name: "Join" }));

	await waitFor(() => expect(screen.getByText("in the call")).toBeTruthy());
	expect(vi.mocked(joinFailed)).not.toHaveBeenCalled();
});
