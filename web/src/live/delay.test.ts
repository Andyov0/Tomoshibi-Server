import { RoomEvent, Track } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MS, DELAY_KEY, cushion, cushionShares, shareDelay } from "./delay";

/*
What these guard is a cushion that is off when it should be on, on when it
should be off, or on the wrong thing.

It is on for every share since 2026-10-14, because it took most of the freezing
out of the shares measured on bad lines; a default read as nothing would quietly
hand that back, and nobody watching could name what had changed. It costs every
viewer of a share a fifth of a second of lateness, and the voice explaining the
share is not held with it, so the one way to turn it off — a zero in the switch
— has to keep working. And held on a camera or a microphone, it would put the
conversation itself behind by that much, which is the cost the owner did not
accept.
*/

const kept = Object.getOwnPropertyDescriptor(window, "localStorage");

afterEach(() => {
	if (kept) Object.defineProperty(window, "localStorage", kept);
	localStorage.clear();
});

describe("the switch", () => {
	it("is a fifth of a second when nothing has been kept", () => {
		expect(DEFAULT_MS).toBe(200);
		expect(shareDelay()).toBe(200);
	});

	it("is a fifth of a second in a browser that will not remember anything", () => {
		// With site data blocked, naming localStorage throws. That browser holds
		// calls like any other, and is held like any other.
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			get() {
				throw new DOMException("The operation is insecure.", "SecurityError");
			},
		});

		expect(shareDelay()).toBe(200);
	});

	it("is off when the switch says nought, and nothing else turns it off", () => {
		localStorage.setItem(DELAY_KEY, "0");
		expect(shareDelay()).toBe(0);

		// A stray value is not somebody asking for it off: the default stands.
		for (const kept of ["-200", "1.5", "5000", "on", "", " "]) {
			localStorage.setItem(DELAY_KEY, kept);
			expect(shareDelay(), JSON.stringify(kept)).toBe(200);
		}
	});

	it("is what the switch says, in whole milliseconds up to a second", () => {
		for (const [kept, read] of [
			["1", 1],
			["120", 120],
			["1000", 1000],
		] as const) {
			localStorage.setItem(DELAY_KEY, kept);
			expect(shareDelay(), kept).toBe(read);
		}
	});
});

describe("a receiver", () => {
	it("is given the standard target in milliseconds where the browser has it", () => {
		const receiver = { jitterBufferTarget: null as number | null } as unknown as RTCRtpReceiver;

		expect(cushion(receiver, 200)).toBe(true);
		expect(receiver.jitterBufferTarget).toBe(200);
	});

	it("is given Chrome's older hint in seconds where that is all there is", () => {
		const receiver = { playoutDelayHint: 0 } as unknown as RTCRtpReceiver & { playoutDelayHint: number };

		expect(cushion(receiver, 200)).toBe(true);
		expect(receiver.playoutDelayHint).toBe(0.2);
	});

	it("is left alone by a browser with neither", () => {
		expect(cushion({} as RTCRtpReceiver, 200)).toBe(false);
	});
});

/** A room with one of each kind of remote track, every receiver recording what it was given. */
function room() {
	const receiver = () => ({ jitterBufferTarget: null as number | null });
	const of = (source: Track.Source) => {
		const track = { receiver: receiver() };
		return { source, track, trackSid: source };
	};

	const publications = [
		of(Track.Source.ScreenShare),
		of(Track.Source.ScreenShareAudio),
		of(Track.Source.Camera),
		of(Track.Source.Microphone),
	];

	const handlers = new Map<string, (...args: unknown[]) => void>();
	const fake = {
		remoteParticipants: new Map([["P", { trackPublications: new Map(publications.map((one) => [one.trackSid, one])) }]]),
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler)),
		off: vi.fn(),
	};

	const held = (source: Track.Source) =>
		publications.find((one) => one.source === source)?.track.receiver.jitterBufferTarget;

	// biome-ignore lint: the fake is deliberately narrow
	return { room: fake as any, held, handlers };
}

describe("a call", () => {
	it("holds every share by a fifth of a second when nobody has said otherwise", () => {
		// Through the default, not a number handed in: this is how App.tsx
		// calls it.
		const { room: made, held } = room();
		cushionShares(made);

		expect(held(Track.Source.ScreenShare)).toBe(200);
		expect(held(Track.Source.ScreenShareAudio)).toBe(200);
		expect(held(Track.Source.Camera)).toBeNull();
		expect(held(Track.Source.Microphone)).toBeNull();
	});

	it("is not touched at all while the switch is off", () => {
		localStorage.setItem(DELAY_KEY, "0");
		const { room: made, held } = room();
		cushionShares(made);

		expect(made.on).not.toHaveBeenCalled();
		for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
			expect(held(source)).toBeNull();
		}
	});

	it("holds a share's picture and its sound together, and nobody's face or voice", () => {
		const { room: made, held } = room();
		cushionShares(made, 200);

		expect(held(Track.Source.ScreenShare)).toBe(200);
		expect(held(Track.Source.ScreenShareAudio)).toBe(200);
		expect(held(Track.Source.Camera)).toBeNull();
		expect(held(Track.Source.Microphone)).toBeNull();
	});

	it("holds a share that starts after the call did", () => {
		const { room: made, handlers } = room();
		cushionShares(made, 200);

		const later = { receiver: { jitterBufferTarget: null } };
		handlers.get(RoomEvent.TrackSubscribed)?.(later, { source: Track.Source.ScreenShare });

		expect(later.receiver.jitterBufferTarget).toBe(200);
	});
});
