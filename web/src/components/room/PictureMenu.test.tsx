import { AS_SENT, setBlocked, setVolume, settingFor } from "@/live/hearing";
import type { Surface } from "@/live/surface";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Track } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PictureMenu } from "./PictureMenu";

// These are about which menu opens, not about who may join. The item's own gate
// has its own test in RoomMenu.test.tsx; here the door is open so the item is
// there to be found.
vi.mock("@/hooks/useJoining", () => ({ useLinkWorks: () => true, useJoining: () => "anyone" }));
import { RoomMenu } from "./RoomMenu";

/*
 * The gesture that says the names of the other gestures out loud.
 *
 * A click puts a picture on the stage and a double click fills the screen with
 * it. The first is stumbled into; the second is known only to whoever wrote it.
 * That is what this menu is for, so what these guard is not that the items work
 * — they call the same handlers the tiles already call — but the two things that
 * would quietly go wrong: a menu that opens twice, and a menu that offers to
 * turn somebody's sound down when the somebody is oneself.
 */

const PROVEN = "taaaaaaaaaa-0123456789abcdef0123456789abcdef";
const GUEST = "gbbbbbbbbbb-0123456789abcdef0123456789abcdef";

function surfaceOf(identity: string, { local = false, kind = "camera" as const } = {}): Surface {
	const participant = { identity, name: "Alex" } as never;

	return {
		id: `${identity}/${kind}`,
		kind,
		local,
		track: { participant, source: Track.Source.Camera, publication: undefined },
	};
}

function menu(surface: Surface, extra: Partial<Parameters<typeof PictureMenu>[0]> = {}) {
	return (
		<PictureMenu
			surface={surface}
			onStage={false}
			fullscreen={false}
			fullscreenSupported
			onToggleStage={vi.fn()}
			onFullscreen={vi.fn()}
			onOpenSound={vi.fn()}
			{...extra}
		>
			<div>picture</div>
		</PictureMenu>
	);
}

/** Radix opens on the context-menu event, which is what a right-click raises. */
function rightClick(element: Element) {
	fireEvent.contextMenu(element);
}

function forget() {
	localStorage.clear();
	for (const identity of [PROVEN, GUEST]) {
		setVolume(identity, "voice", AS_SENT.volume);
		setBlocked(identity, "voice", AS_SENT.blocked);
	}
}

beforeEach(forget);
afterEach(() => act(forget));

describe("PictureMenu", () => {
	it("names the picture it caught", () => {
		render(menu(surfaceOf(PROVEN)));
		rightClick(screen.getByText("picture"));

		// Said in the item rather than in a heading above it, so a menu opened
		// on a small tile in a busy grid says which one it was.
		expect(screen.getByText("Show Alex larger")).toBeDefined();
	});

	it("turns somebody's sound off from the picture they are in", () => {
		render(menu(surfaceOf(PROVEN)));
		rightClick(screen.getByText("picture"));

		fireEvent.click(screen.getByText("Mute Alex"));

		// The same record the panel writes to, so the panel, the mark on the
		// picture, and this all say one thing.
		expect(settingFor(PROVEN, "voice").blocked).toBe(true);
	});

	// Nobody hears themselves, so there is nothing to offer.
	it("offers nothing about the sound of one's own picture", () => {
		render(menu(surfaceOf(PROVEN, { local: true })));
		rightClick(screen.getByText("picture"));

		expect(screen.queryByText(/^Mute /)).toBeNull();
		expect(screen.queryByText("Sound settings")).toBeNull();
	});

	/*
	 * A signature drawn from nothing is fresh every visit, so a copy of one is
	 * true for the length of this call and misleading afterwards — and the
	 * reason anybody puts one in the clipboard is to paste it into a
	 * configuration file, where it would then admit whoever inherits it.
	 */
	it("offers only a signature somebody earned", () => {
		const { unmount } = render(menu(surfaceOf(PROVEN)));
		rightClick(screen.getByText("picture"));
		expect(screen.getByText("Copy signature")).toBeDefined();
		unmount();

		render(menu(surfaceOf(GUEST)));
		rightClick(screen.getByText("picture"));
		expect(screen.queryByText("Copy signature")).toBeNull();
	});

	// The stage is the element that goes full screen, so anywhere else the item
	// would have to put the picture there first and do two things under one name.
	it("offers the screen only to the picture already on the stage", () => {
		const { unmount } = render(menu(surfaceOf(PROVEN)));
		rightClick(screen.getByText("picture"));
		expect(screen.queryByText("Fill the screen")).toBeNull();
		unmount();

		render(menu(surfaceOf(PROVEN), { onStage: true }));
		rightClick(screen.getByText("picture"));
		expect(screen.getByText("Fill the screen")).toBeDefined();
	});
});

/*
 * The nesting, and the half of it that does not take care of itself.
 *
 * Every picture's menu sits inside the room's, so every press on a picture
 * reaches both triggers. A right click is safe without anybody doing anything:
 * the library calls `preventDefault` and declines to open on an event that has
 * already been defaulted, so the outer trigger lets it past. A long press is
 * not. It opens from a timer that fires long after the event has finished, and
 * both triggers start one — which on a phone is the whole of how this menu is
 * reached.
 */
describe("a picture inside the room", () => {
	function inside() {
		render(
			<RoomMenu>{menu(surfaceOf(PROVEN))}</RoomMenu>,
		);
	}

	it("opens one menu on a right click and not both", () => {
		inside();
		rightClick(screen.getByText("picture"));

		expect(screen.getByText("Show Alex larger")).toBeDefined();
		// Counted rather than looked for. Both menus carry the link now, so its
		// presence says nothing and a second copy of it says everything.
		expect(screen.queryAllByText("Copy link")).toHaveLength(1);
	});

	it("opens one menu on a long press and not both", () => {
		vi.useFakeTimers();

		try {
			inside();

			// The library's own gesture: a touch held down, and a menu seven
			// hundred milliseconds later.
			fireEvent.pointerDown(screen.getByText("picture"), { pointerType: "touch", button: 0 });
			act(() => {
				vi.advanceTimersByTime(800);
			});

			expect(screen.getByText("Show Alex larger")).toBeDefined();
			expect(screen.queryAllByText("Copy link")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("opens the room's own where there is no picture", () => {
		render(
			<RoomMenu>
				<div>the space between</div>
			</RoomMenu>,
		);

		rightClick(screen.getByText("the space between"));

		expect(screen.getByText("Copy link")).toBeDefined();
	});

	/*
	 * The item that is in both, and has to be.
	 *
	 * Two people are drawn as one picture filling the frame with the other in a
	 * corner of it, which leaves no space around the pictures at all — so a link
	 * reachable only from that space is a link unreachable in the commonest call
	 * anybody holds.
	 */
	it("carries the link whichever of the two was pressed", () => {
		inside();

		rightClick(screen.getByText("picture"));
		expect(screen.getByText("Copy link")).toBeDefined();
	});
});
