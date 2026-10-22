import { cleanup, render } from "@testing-library/react";
import type { Room } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The control bar on a narrow screen, and what its steps are counted against.
 *
 * The bar narrows in steps below a phone's width, and how soon each step is
 * taken depends on how many buttons it carries. The steps were measured on a
 * phone's set of buttons, which has no screen share because no phone browser
 * offers one -- and then keyed to the music and watch buttons by name. A
 * browser that does offer the share at a phone's width, a desktop window
 * narrowed or a phone emulated in one, therefore carried a button nothing had
 * counted: at 375 the bar hung ten pixels off each side and the page scrolled
 * sideways under it. Nothing failed and nothing was logged.
 *
 * jsdom lays nothing out, so the width itself is measured by the browser
 * script. What this holds is the two decisions that make the measurement come
 * out right: every extra button is counted, the share among them, and every
 * count the bar can reach has steps of its own.
 */

vi.mock("@/hooks/useLocalState", () => ({
	useLocalState: () => ({ microphone: false, camera: false, screen: false, listening: false }),
}));
vi.mock("@/hooks/useIdle", () => ({ useIdle: () => false }));
vi.mock("@/hooks/useRoomFor", () => ({ useRoomForSide: () => false }));
vi.mock("@/live/room", async (original) => ({
	...(await original<typeof import("@/live/room")>()),
	retune: vi.fn(),
	runningShare: () => undefined,
	share: vi.fn(),
	watchRunning: () => () => {},
}));
vi.mock("@/live/sound", () => ({
	NoSound: class extends Error {},
	losslessUnavailable: () => false,
	rememberLossless: vi.fn(),
	rememberedLossless: () => false,
	sendingLossless: () => false,
	startListening: vi.fn(),
	stopListening: vi.fn(),
}));
vi.mock("./DeviceMenu", () => ({ DeviceMenu: () => <button type="button" className="size-10" aria-label="Devices" /> }));
vi.mock("./Leaving", () => ({ Leaving: () => <button type="button" className="size-11" aria-label="Leave" /> }));

import { ControlBar } from "./ControlBar";

const available = { open: false, available: true, playing: false };

function bar({ share, music, watch }: { share: boolean; music: boolean; watch: boolean }) {
	Object.defineProperty(navigator, "mediaDevices", {
		value: share ? { getDisplayMedia: async () => new MediaStream() } : {},
		configurable: true,
	});

	const { container } = render(
		<ControlBar
			room={{} as Room}
			handUp={false}
			onRaise={() => {}}
			onReact={() => {}}
			chatting={false}
			unread={false}
			listening={false}
			onChat={() => {}}
			onListen={() => {}}
			music={music ? available : undefined}
			onMusic={() => {}}
			watch={watch ? available : undefined}
			onWatchPanel={() => {}}
			onLeave={() => {}}
			host={false}
			where="always"
			onPlace={() => {}}
		/>,
	);

	const footer = container.querySelector("footer");
	if (!footer) throw new Error("no bar");

	return footer;
}

afterEach(() => {
	cleanup();
	Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
});

describe("the buttons the bar is narrowed for", () => {
	it("count the screen share wherever the browser offers one", () => {
		expect(bar({ share: false, music: false, watch: false }).dataset.extra).toBe("0");
		expect(bar({ share: true, music: false, watch: false }).dataset.extra).toBe("1");
	});

	it("count the share beside the music and the watch buttons, not instead of them", () => {
		expect(bar({ share: true, music: true, watch: false }).dataset.extra).toBe("2");
		expect(bar({ share: true, music: false, watch: true }).dataset.extra).toBe("2");
		expect(bar({ share: false, music: true, watch: true }).dataset.extra).toBe("2");
		expect(bar({ share: true, music: true, watch: true }).dataset.extra).toBe("3");
	});

	/*
	 * Every count from one to three needs its own buttons-smaller step, or that
	 * many buttons keep their full size on a phone. Read from the classes,
	 * which is where the steps live: a group that is missing or keyed to the
	 * wrong count compiles to a rule that matches nothing.
	 */
	it("has steps of its own for every count it can reach", () => {
		const classes = bar({ share: true, music: true, watch: true }).className;

		for (const count of [1, 2, 3]) {
			const shrinks = [
				...classes.matchAll(new RegExp(`data-\\[extra=${count}\\]:max-\\[(\\d+)px\\]:\\[&_\\.size-10\\]:size-`, "g")),
			].map((m) => Number(m[1]));

			expect(shrinks.length, `no step brings ${count} extra buttons down`).toBeGreaterThan(0);
			// And the last of them is taken on a 320-pixel phone, the narrowest
			// this has to fit.
			expect(Math.min(...shrinks)).toBeGreaterThan(320);
		}
	});
});
