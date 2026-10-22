import { act, renderHook } from "@testing-library/react";
/**
 * What these guard is a light that says the wrong thing.
 *
 * A connection light is only useful if it can be trusted at a glance, and the
 * way it stops being trustworthy is by being kind. Three green bars on a call
 * that is breaking up does more harm than no light at all: it sends somebody
 * looking at their microphone, their browser, and their colleague before they
 * think to doubt the indicator.
 *
 * So the bands are asserted at their edges, and so is the rule that the server's
 * own verdict can only ever make the reading worse. The server sees this
 * participant from the far side; where it is unhappy and the local numbers are
 * not, the numbers are the ones missing something.
 */

import { ConnectionQuality, type Room, Track } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { grade, useConnectionQuality } from "./connection";

const fine = ConnectionQuality.Excellent;

describe("the connection light", () => {
	it("is green on a near, clean connection", () => {
		expect(grade(fine, 30, 0)).toBe("good");
		expect(grade(fine, 149, 1.9)).toBe("good");
	});

	// Distance alone. Nothing is being lost, and the call is still hard work.
	it("turns amber on distance before anything is lost", () => {
		expect(grade(fine, 151, 0)).toBe("fair");
		expect(grade(fine, 399, 0)).toBe("fair");
	});

	it("turns red when a conversation would stop working", () => {
		expect(grade(fine, 401, 0)).toBe("poor");
		expect(grade(fine, 20, 8.1)).toBe("poor");
	});

	// Loss matters at lower numbers than people expect: two per cent is audible.
	it("turns amber on loss a long way below what sounds like a lot", () => {
		expect(grade(fine, 20, 2.1)).toBe("fair");
	});

	// The worst of the two, not the average. A call with a perfect round trip
	// that is losing a tenth of everything is not a fair connection.
	it("takes the worse of distance and loss", () => {
		expect(grade(fine, 30, 9)).toBe("poor");
		expect(grade(fine, 500, 0)).toBe("poor");
		expect(grade(fine, 200, 3)).toBe("fair");
	});

	it("says nothing bad before anything has been measured", () => {
		expect(grade(fine, undefined, undefined)).toBe("good");
	});

	// The direction that matters. The server can pull the reading down and must
	// never push it up, or a broken call gets a clean bill of health.
	it("lets the server make it worse and never better", () => {
		expect(grade(ConnectionQuality.Poor, 20, 0)).toBe("fair");
		expect(grade(ConnectionQuality.Lost, 20, 0)).toBe("lost");

		// Already worse than the server thinks: the local numbers stand.
		expect(grade(ConnectionQuality.Excellent, 900, 20)).toBe("poor");
	});
});

/*
 * What the share row says about why it is held back, sample after sample.
 *
 * The browser reports a reason on every outbound-rtp entry: "cpu",
 * "bandwidth", "other", or "none". The row carried the last reason forward
 * whenever a sample had no reason to give, which was meant for a sample taken
 * while the encoder was reconfiguring — and it treated "none" as no reason to
 * give. So a share held back by the CPU for ten seconds went on saying so for
 * the rest of the call, and the person reading it moved to a nearer machine
 * or closed their browser tabs for a fault that had already gone.
 *
 * Tested through the hook with a fake room handing out reports in sequence,
 * because the fault was in the merge and not in the function that reads the
 * string.
 */
describe("the reason a share is held back", () => {
	function reportOf(entry: Record<string, unknown> | null) {
		const entries = entry ? [{ type: "outbound-rtp", id: "o1", bytesSent: 0, packetsSent: 0, ...entry }] : [];
		return { forEach: (fn: (e: unknown) => void) => entries.forEach(fn) } as unknown as RTCStatsReport;
	}

	function roomWith(sequence: Array<Record<string, unknown> | null>) {
		let n = 0;
		const publication = {
			source: Track.Source.ScreenShare,
			track: { getRTCStatsReport: async () => reportOf(sequence[Math.min(n++, sequence.length - 1)] ?? null) },
		};

		return {
			localParticipant: { trackPublications: new Map([["s", publication]]) },
			remoteParticipants: new Map(),
			on: () => {},
			off: () => {},
		} as unknown as Room;
	}

	// The hook looks once on mount and then every two seconds. `settle` takes
	// the mount sample; each `sample` after it takes the next report.
	async function settle() {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
	}

	async function sample() {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
	}

	beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
	afterEach(() => vi.useRealTimers());

	it("clears the warning when the browser says the limitation is gone", async () => {
		const room = roomWith([
			{ ssrc: 1, qualityLimitationReason: "cpu" },
			{ ssrc: 1, qualityLimitationReason: "none" },
		]);
		const { result } = renderHook(() => useConnectionQuality(room));

		await settle();
		expect(result.current.share?.limited).toBe("cpu");

		await sample();
		expect(result.current.share?.limited).toBeUndefined();
	});

	it("switches from one reason to another", async () => {
		const room = roomWith([
			{ ssrc: 1, qualityLimitationReason: "bandwidth" },
			{ ssrc: 1, qualityLimitationReason: "cpu" },
			{ ssrc: 1, qualityLimitationReason: "none" },
		]);
		const { result } = renderHook(() => useConnectionQuality(room));

		await settle();
		expect(result.current.share?.limited).toBe("bandwidth");
		await sample();
		expect(result.current.share?.limited).toBe("cpu");
		await sample();
		expect(result.current.share?.limited).toBeUndefined();
	});

	it("keeps a reason across one sample that did not say, and not for ever", async () => {
		const room = roomWith([
			{ ssrc: 1, qualityLimitationReason: "cpu" },
			{ ssrc: 1 },
			{ ssrc: 1 },
			{ ssrc: 1 },
			{ ssrc: 1 },
		]);
		const { result } = renderHook(() => useConnectionQuality(room));

		await settle();
		expect(result.current.share?.limited).toBe("cpu");

		// A gap in the measurement, not a recovery.
		await sample();
		expect(result.current.share?.limited).toBe("cpu");

		// But a browser that has stopped saying is not still saying "cpu".
		await sample();
		await sample();
		await sample();
		expect(result.current.share?.limited).toBeUndefined();
	});

	it("does not hand one share's reason to the next one", async () => {
		const room = roomWith([
			{ ssrc: 1, qualityLimitationReason: "cpu" },
			// A different track, which happens to have no reason on its first
			// report. It starts clean.
			{ ssrc: 2 },
		]);
		const { result } = renderHook(() => useConnectionQuality(room));

		await settle();
		expect(result.current.share?.limited).toBe("cpu");
		await sample();
		expect(result.current.share?.limited).toBeUndefined();
	});

	it("starts clean in a new room", async () => {
		const first = roomWith([{ ssrc: 1, qualityLimitationReason: "cpu" }]);
		const second = roomWith([{ ssrc: 1 }]);
		const { result, rerender } = renderHook(({ room }) => useConnectionQuality(room), {
			initialProps: { room: first },
		});

		await settle();
		expect(result.current.share?.limited).toBe("cpu");

		rerender({ room: second });
		await settle();
		expect(result.current.share?.limited).toBeUndefined();
	});
});

/*
The reading when a share is a ladder.

A share is published as three encodings now, so a sender's report holds three
`outbound-rtp` rows. The code that reads the share's size assigned its result on
every match, so whichever row the report yielded last became the answer — and
`RTCStatsReport` promises no order. Somebody sharing at 1440p was shown "360p",
which is the worst kind of wrong for a status line: it is precise, it is
confident, and it sends the reader looking for a fault in the wrong place.

The rows here are deliberately in the order that used to produce the wrong
answer.
*/
describe("what the share row says when there is a ladder", () => {
	function ladder(entries: Array<Record<string, unknown>>) {
		const rows = entries.map((e, i) => ({
			type: "outbound-rtp",
			id: `o${i}`,
			bytesSent: 0,
			packetsSent: 0,
			...e,
		}));

		const publication = {
			source: Track.Source.ScreenShare,
			track: {
				getRTCStatsReport: async () =>
					({ forEach: (fn: (e: unknown) => void) => rows.forEach(fn) }) as unknown as RTCStatsReport,
			},
		};

		return {
			localParticipant: { trackPublications: new Map([["s", publication]]) },
			remoteParticipants: new Map(),
			on: () => {},
			off: () => {},
		} as unknown as Room;
	}

	beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
	afterEach(() => vi.useRealTimers());

	async function settle() {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
	}

	it("says the size that was chosen, not whichever rung came last", async () => {
		const room = ladder([
			{ ssrc: 3, rid: "f", frameWidth: 2560, frameHeight: 1440, framesPerSecond: 60 },
			{ ssrc: 2, rid: "h", frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 },
			{ ssrc: 1, rid: "q", frameWidth: 640, frameHeight: 360, framesPerSecond: 15 },
		]);

		const { result } = renderHook(() => useConnectionQuality(room));
		await settle();

		expect(result.current.share?.height).toBe(1440);
		expect(result.current.share?.width).toBe(2560);
		expect(result.current.share?.fps).toBe(60);
	});

	it("takes the reason from the rung it is reporting", async () => {
		// The bottom rung is never the one being squeezed — it is the one
		// squeezing was meant to reach. Reading its reason would say "nothing is
		// wrong" on a share the encoder is visibly struggling with.
		const room = ladder([
			{ ssrc: 3, rid: "f", frameWidth: 2560, frameHeight: 1440, qualityLimitationReason: "cpu" },
			{ ssrc: 1, rid: "q", frameWidth: 640, frameHeight: 360, qualityLimitationReason: "none" },
		]);

		const { result } = renderHook(() => useConnectionQuality(room));
		await settle();

		expect(result.current.share?.limited).toBe("cpu");
	});

	it("still draws a row before any rung has produced a frame", async () => {
		// The size and the rate are both absent until the encoder has run, and a
		// share that is plainly on screen with no line at all reads as the
		// reading being broken.
		const room = ladder([{ ssrc: 1, rid: "q" }, { ssrc: 3, rid: "f" }]);

		const { result } = renderHook(() => useConnectionQuality(room));
		await settle();

		expect(result.current.share).toBeDefined();
		expect(result.current.share?.sending).toBe(true);
	});
});
