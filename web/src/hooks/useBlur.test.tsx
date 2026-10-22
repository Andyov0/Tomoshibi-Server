import { act, renderHook, waitFor } from "@testing-library/react";
import { RoomEvent } from "livekit-client";
import { beforeEach, expect, it, vi } from "vitest";
import { blur } from "@/live/blur";
import { useBlur } from "./useBlur";

/*
 * That turning blur on republishes the camera, and installs one processor.
 *
 * Two faults live here, and both were found by measuring a real call rather
 * than by reading the code.
 *
 * The first: installing a processor on a track that is already encoding and
 * being sent produces, when the install is slow, a canvas that never draws. The
 * call carries on, the install reports success, and the person's own picture is
 * black until they rejoin. Installing as a track is published does not — that
 * path was measured cold, over a network, and came up blurred every time. So
 * the switch cycles the camera and lets the effect apply the choice to the new
 * track.
 *
 * The second: the toggle sets the choice first so the switch answers the press,
 * and the choice is a dependency of the effect — so the effect ran while the
 * toggle was still working and installed a second processor over the first.
 *
 * Both are invisible in development, which is why both shipped. The install is
 * instant off localhost and takes seconds over a network, and every one of
 * these failures needs the slow case. The fake below is slow on purpose.
 */

vi.mock("@/live/blur", () => ({
	blur: vi.fn(),
	possible: () => true,
	wanted: () => false,
	remember: vi.fn(),
	warm: vi.fn(async () => {}),
}));

// A track that starts reporting a processor once one has finished installing,
// and not before — which is what a real one does, and is what lets a second
// install through when nothing else stops it.
let installed: unknown;
const track = { getProcessor: () => installed };

const listeners = new Map<string, Set<() => void>>();
const cameras: boolean[] = [];

const room = {
	localParticipant: {
		getTrackPublication: () => ({ videoTrack: track }),
		setCameraEnabled: async (on: boolean) => {
			cameras.push(on);
			// A camera coming back publishes a track, which is the moment the
			// choice is applied.
			if (on) for (const fn of listeners.get(RoomEvent.LocalTrackPublished) ?? []) fn();
		},
	},
	on: (event: string, fn: () => void) => {
		if (!listeners.has(event)) listeners.set(event, new Set());
		listeners.get(event)?.add(fn);
	},
	off: (event: string, fn: () => void) => listeners.get(event)?.delete(fn),
} as never;

beforeEach(() => {
	listeners.clear();
	cameras.length = 0;
	installed = undefined;
	vi.mocked(blur).mockReset();
	vi.mocked(blur).mockImplementation(
		(_track, on) =>
			new Promise((resolve) =>
				setTimeout(() => {
					installed = on ? { fake: true } : undefined;
					resolve(on);
				}, 50),
			),
	);
});

it("republishes the camera and installs one processor", async () => {
	const { result } = renderHook(() => useBlur(room));

	// Started but not awaited, and the effects flushed while it is still in
	// flight. Awaiting it would flush them once the processor had finished
	// installing, which is the one moment nothing can go wrong.
	act(() => {
		void result.current.toggle();
	});

	await waitFor(() => expect(vi.mocked(blur)).toHaveBeenCalled());
	await act(async () => {
		await new Promise((r) => setTimeout(r, 150));
	});

	// Off and on, rather than swapped underneath a live encoder.
	expect(cameras).toEqual([false, true]);

	// Once. Twice is a second processor landing on top of the first.
	expect(vi.mocked(blur).mock.calls.filter(([, on]) => on)).toHaveLength(1);
	expect(result.current.on).toBe(true);
});
