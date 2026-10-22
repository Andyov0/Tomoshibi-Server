import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join as requestJoin } from "@/live/api";
import { deviceFailed, joinFailed } from "@/live/notices";
import { App } from "./App";

/*
 * That a device failing does not take the call down with it.
 *
 * Turning on the microphone and camera used to sit in the same try as the
 * connection, so a device that failed failed the join: a refused microphone, or
 * a camera held by a call in another tab, disconnected somebody who was already
 * in and told them the room would not open. Nothing on screen looked wrong about
 * that -- a join that fails is an ordinary thing to be told -- which is why it
 * is asserted here rather than trusted.
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

const refused = new DOMException("Permission denied", "NotAllowedError");
const microphone = vi.fn(() => Promise.reject(refused));
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

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
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
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

it("stays in the call when the microphone is refused, and still asks for the camera", async () => {
	render(<App />);

	const name = await screen.findByLabelText("Your name");
	fireEvent.change(name, { target: { value: "Bo" } });
	fireEvent.click(screen.getByRole("button", { name: "Join" }));

	await waitFor(() => expect(screen.getByText("in the call")).toBeTruthy());

	expect(microphone).toHaveBeenCalled();
	expect(vi.mocked(deviceFailed)).toHaveBeenCalledWith("microphone", refused);
	expect(cameraOn).toHaveBeenCalled();
	expect(vi.mocked(joinFailed)).not.toHaveBeenCalled();
});
