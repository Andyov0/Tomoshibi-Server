import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Room } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The control bar on a narrow screen: what stays in the row, what goes up a
 * row, and that nothing is made smaller than a finger to fit.
 *
 * The bar used to fit a phone by shrinking: three steps of classes keyed to how
 * many optional buttons it carried, down to twenty-eight pixels a button at
 * 320. Everything stayed on screen, and every target was a little over half
 * the size a finger is given on the platforms' own call screens, on exactly
 * the screens that are used with nothing else. It also had to be kept right by
 * counting: a share nobody had counted once put the bar ten pixels off each
 * side of a 375-pixel screen.
 *
 * Now a narrow window folds what is not needed every minute into a second row
 * behind one button, at the same size. jsdom lays nothing out, so the widths
 * themselves are measured by the browser script; what this holds is the
 * decision: which buttons stay, which move, and that none of them carries a
 * size smaller than the island's forty-four.
 */

vi.mock("@/hooks/useLocalState", () => ({
	useLocalState: () => ({ microphone: false, camera: false, screen: false, listening: false }),
}));
vi.mock("@/hooks/useIdle", () => ({ useIdle: () => false }));
vi.mock("@/hooks/useRoomFor", async (original) => ({
	...(await original<typeof import("@/hooks/useRoomFor")>()),
	useRoomForSide: () => false,
}));
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
vi.mock("./DeviceMenu", () => ({ DeviceMenu: () => <button type="button" className="size-11" aria-label="Devices" /> }));
vi.mock("./Leaving", () => ({ Leaving: () => <button type="button" className="h-11 w-14" aria-label="Leave" /> }));

import { ControlBar } from "./ControlBar";

const available = { open: false, available: true, playing: false };

const was = window.innerWidth;

function bar({
	share,
	music,
	watch,
	width = 375,
	chatting = false,
}: { share: boolean; music: boolean; watch: boolean; width?: number; chatting?: boolean }) {
	Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
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
			chatting={chatting}
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
	Object.defineProperty(window, "innerWidth", { value: was, configurable: true });
});

const labels = (within: Element) => [...within.querySelectorAll("button")].map((one) => one.getAttribute("aria-label"));

/** Every class on a button in the bar that sets its size, which must be the island's. */
const sizes = (within: Element) =>
	[...within.querySelectorAll("button")].flatMap((one) =>
		one.className.split(/\s+/).filter((name) => /^(size|h|w)-/.test(name) && !/^(h|w)-(11|14|8)$/.test(name) && name !== "size-11"),
	);

describe("the bar on a narrow screen", () => {
	it("keeps what a call needs every minute in the row and folds the rest", () => {
		const footer = bar({ share: true, music: true, watch: true });

		expect(footer.dataset.folded).toBe("");
		// The local state is mocked with both devices off.
		expect(labels(footer)).toEqual([
			"Unmute microphone",
			"Turn camera on",
			"Raise your hand",
			"Show messages",
			"More controls",
			"Leave",
		]);
	});

	it("puts every folded button in the second row, and none of them anywhere else", () => {
		bar({ share: true, music: true, watch: true });

		fireEvent.click(screen.getByRole("button", { name: "More controls" }));

		const row = screen.getByRole("button", { name: "Show sound" }).parentElement as HTMLElement;
		expect(row.tagName).not.toBe("FOOTER");
		expect(labels(row)).toEqual([
			"Reactions",
			"Share your screen",
			"Show sound",
			"Show music",
			"Show watch together",
			"Devices",
		]);
	});

	/*
	 * The old steps were classes like size-[34px] and size-7 reached into the
	 * buttons from the bar; any of those coming back is the bar shrinking again.
	 */
	it("draws every button at the island's size, in the row and in the second row", () => {
		const footer = bar({ share: true, music: true, watch: true, width: 320 });
		expect(sizes(footer)).toEqual([]);
		expect(footer.className).not.toMatch(/\[&_\.size-/);

		fireEvent.click(screen.getByRole("button", { name: "More controls" }));
		const row = screen.getByRole("button", { name: "Show sound" }).parentElement as HTMLElement;
		expect(sizes(row)).toEqual([]);
	});

	it("closes the second row on Escape", () => {
		bar({ share: true, music: false, watch: false });

		fireEvent.click(screen.getByRole("button", { name: "More controls" }));
		expect(screen.queryByRole("button", { name: "Show sound" })).not.toBeNull();

		act(() => {
			fireEvent.keyDown(document, { key: "Escape" });
		});
		expect(screen.getByRole("button", { name: "More controls" }).getAttribute("aria-expanded")).toBe("false");
	});
});

describe("the bar on a wide screen", () => {
	it("is one row, with nothing folded", () => {
		const footer = bar({ share: true, music: false, watch: false, width: 1280 });

		expect(footer.dataset.folded).toBeUndefined();
		expect(labels(footer)).toContain("Show sound");
		expect(labels(footer)).toContain("Share your screen");
		expect(labels(footer)).toContain("Devices");
		expect(labels(footer)).not.toContain("More controls");
	});
});

/*
 * The owner's rule for the amber (2026-10-29): it is for what is happening in
 * the call — a share going out, a hand up, something unread, somebody talking —
 * and a panel somebody has opened is not that. The open panel's button is drawn
 * pressed instead. The messages' button was amber while open, and a change that
 * puts it back would look like a small consistency fix to whoever made it.
 */
describe("an open panel's button", () => {
	it("is drawn pressed, not in the amber", () => {
		bar({ share: false, music: false, watch: false, width: 1280, chatting: true });

		const button = screen.getByRole("button", { name: "Hide messages" });
		expect(button.className).toMatch(/\bbg-surface-hi-press\b/);
		expect(button.className).not.toMatch(/(^|\s)bg-tally(\s|$)/);
	});
});
