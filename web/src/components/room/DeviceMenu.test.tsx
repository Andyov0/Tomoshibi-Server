import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceMenu } from "./DeviceMenu";

vi.mock("@/hooks/useBlur", () => ({
	useBlur: () => ({ possible: false, on: false, busy: false, toggle: vi.fn() }),
}));
vi.mock("@/live/blur", () => ({ warm: vi.fn(async () => {}) }));
vi.mock("@/live/notices", () => ({ deviceFailed: vi.fn() }));

/*
 * That a device picked in a call is the device the next call starts on, and
 * only once it has actually started.
 *
 * The menu used only to switch, so somebody whose calls want the headset rather
 * than the laptop picked it again at the start of every one. The order matters
 * as much as the remembering: written before the switch had answered, a device
 * that refused to start would be the one the next call asked for first.
 */

function room(switched: boolean): Room {
	return {
		getActiveDevice: () => undefined,
		switchActiveDevice: vi.fn(async () => switched),
	} as unknown as Room;
}

/**
 * Open the menu the way a keyboard does. jsdom defines no PointerEvent, so a
 * synthesised pointerdown reaches nothing and the menu stays shut; Enter goes
 * through the same handler (see ShareButton.test.tsx).
 */
function open(on: Room) {
	render(<DeviceMenu room={on} where="always" onPlace={vi.fn()} />);
	fireEvent.keyDown(screen.getByRole("button", { name: "Devices" }), { key: "Enter" });
}

beforeEach(() => {
	localStorage.clear();
	Object.defineProperty(navigator, "mediaDevices", {
		value: {
			enumerateDevices: async () => [
				{ kind: "audioinput", deviceId: "mic-a", label: "Laptop" },
				{ kind: "audioinput", deviceId: "mic-b", label: "Headset" },
				{ kind: "videoinput", deviceId: "cam-a", label: "Front" },
			],
			addEventListener() {},
			removeEventListener() {},
		},
		configurable: true,
	});
});

afterEach(() => localStorage.clear());

describe("picking a device", () => {
	it("remembers it for the next call once it has started", async () => {
		const live = room(true);
		open(live);

		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Headset" }));

		await waitFor(() =>
			expect(JSON.parse(localStorage.getItem("meet-live.device-choice") ?? "{}")).toEqual({
				audioinput: "mic-b",
			}),
		);
		expect(live.switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-b");
	});

	it("does not remember one that would not start", async () => {
		const live = room(false);
		open(live);

		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Headset" }));

		await waitFor(() => expect(live.switchActiveDevice).toHaveBeenCalled());
		// Given the moment the switch had to answer in, and then asked.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(localStorage.getItem("meet-live.device-choice")).toBeNull();
	});
});
