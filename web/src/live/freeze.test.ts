import { RemoteTrackPublication, RemoteVideoTrack, RoomEvent, Track, TrackEvent } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	EVERY_MS,
	HOLD_MS,
	LONGEST_HOLD_MS,
	type Reading,
	type Rung,
	SETTLE_MS,
	STALL_MS,
	TRIED_MS,
	UNCAPPED,
	type Watch,
	fresh,
	judge,
	readInbound,
	rungAsked,
	rungsOf,
	watchShareFreezes,
} from "./freeze";

/*
What these guard is a step down that is either never taken or taken for the
wrong reason.

The first is the fault this exists for and is invisible: a viewer whose server
goes on sending the original down a line that cannot carry it receives bytes
and decodes nothing, for a minute, and the browser reports nothing at all. The
second is worse in its own way, because it is a picture made worse by the very
thing meant to help it — and the things that look like a freeze from one
reading are ordinary: a still screen sends nothing, a share coming back from a
pause or switching rungs arrives as bytes before it arrives as frames, and the
switch this file asks for takes a keyframe to show. Each of those is held
apart here, reading by reading.

And the boundary that matters more than any threshold: none of this reaches
what the person sharing sends. The only thing written is this viewer's own
request, and the room tests below hold that.
*/

const R720: Rung = { width: 1280, height: 720 };
const R1080: Rung = { width: 1920, height: 1080 };
const R1440: Rung = { width: 2560, height: 1440 };
const LADDER = [R720, R1080, R1440];

/**
 * Feed readings one second apart through the rule, and say what it did.
 * `shape(at)` gives the counters at each second.
 */
function run(
	from: number,
	to: number,
	shape: (at: number) => Omit<Reading, "at">,
	rungs: readonly Rung[] = LADDER,
	watch: Watch = fresh(0),
	asked?: number,
) {
	const acts: { at: number; act: NonNullable<ReturnType<typeof judge>["act"]> }[] = [];
	let current = watch;

	for (let at = from; at <= to; at += EVERY_MS) {
		const { watch: next, act } = judge(current, { at, ...shape(at) }, rungs, at, asked);
		current = next;
		if (act) acts.push({ at, act });
	}

	return { acts, watch: current };
}

/** A share decoding thirty frames a second, megabits arriving, nothing frozen. */
const moving = () => (at: number) => ({
	frames: (at / 1000) * 30,
	bytes: (at / 1000) * 2_000_000,
	received: (at / 1000) * 2000,
	lost: 0,
	freezes: 0,
});

/** Frozen from `since` to `until`: bytes go on arriving and the frame count stands still. */
const frozenBetween = (since: number, until: number) => (at: number) => ({
	frames: ((at < since ? at : at < until ? since : at - (until - since)) / 1000) * 30,
	bytes: (at / 1000) * 2_000_000,
	received: (at / 1000) * 2000,
	lost: 0,
});

/** Frozen from `since`: bytes go on arriving and the frame count stands still. */
const frozenFrom = (since: number) => (at: number) => ({
	frames: (Math.min(at, since) / 1000) * 30,
	bytes: (at / 1000) * 2_000_000,
	received: (at / 1000) * 2000,
	lost: 0,
});

/**
 * Moving, losing `share` of its packets, and freezing once a second where
 * `freezing` — the browser's own count of a frame that came far too late.
 */
const lossy = (share: number, freezing: boolean) => (at: number) => ({
	...moving()(at),
	lost: (at / 1000) * 2000 * share,
	freezes: freezing ? at / 1000 : 0,
});

describe("what counts as a freeze", () => {
	it("steps down once frames have stood still for two seconds while bytes kept coming", () => {
		const { acts } = run(0, 10_000, frozenFrom(4_000));

		expect(acts).toHaveLength(1);
		expect(acts[0]?.act).toEqual({ kind: "cap", rung: R1080 });

		// Not before two whole seconds of it: the reading at 4000 was the last
		// to see a frame, and 6000 is the first two seconds after.
		expect(acts[0]?.at).toBe(4_000 + STALL_MS);
	});

	it("says nothing about a share that is moving", () => {
		expect(run(0, 120_000, moving()).acts).toEqual([]);
	});

	it("does not take a still screen for a freeze", () => {
		// A still screen sends nothing and decodes nothing. Both counters stand.
		const { acts } = run(0, 120_000, (at) => ({
			frames: Math.min(at, 3_000) / 100,
			bytes: Math.min(at, 3_000) * 100,
			received: Math.min(at, 3_000),
			lost: 0,
		}));

		expect(acts).toEqual([]);
	});

	it("does not take a share coming back from a pause for a freeze", () => {
		// Paused at 3 s — nothing arrives — and resumed at 30 s, when bytes come
		// a second before the keyframe that lets frames be decoded again. Counted
		// from the last frame, that second is a stall of twenty-seven; it is a
		// stall of one.
		const paused = (at: number) => {
			const arrived = at < 3_000 ? at : at < 30_000 ? 3_000 : at - 27_000;
			const decoded = at < 3_000 ? at : at <= 31_000 ? 3_000 : at - 28_000;
			return { frames: (decoded / 1000) * 30, bytes: (arrived / 1000) * 2_000_000 };
		};

		expect(run(0, 60_000, paused).acts).toEqual([]);
	});

	it("does not take a trickle for a share arriving", () => {
		// A few hundred bytes a second — RTCP's company, not a picture — while
		// nothing is decoded.
		const { acts } = run(0, 60_000, (at) => ({ frames: 90, bytes: 50_000 + at / 5 }));

		expect(acts).toEqual([]);
	});

	it("steps down on a tenth of the packets lost while the picture freezes, even as frames move", () => {
		expect(run(0, 10_000, lossy(0.15, true)).acts[0]?.act).toEqual({ kind: "cap", rung: R1080 });
		expect(run(0, 60_000, lossy(0.05, true)).acts).toEqual([]);
	});

	it("does not step down on loss that retransmission brought back", () => {
		// A short line losing twelve per cent, all of it asked for again and
		// recovered in time: the browser goes on counting the packets lost, and
		// counts no freeze, because the picture had none. Stepped down on the
		// count alone this was the 720p rung most of the time, and a keyframe
		// at every switch.
		expect(run(0, 120_000, lossy(0.12, false)).acts).toEqual([]);
	});

	it("does not take loss for harm in a browser that does not count freezes", () => {
		// No freezeCount at all: the stall is the only evidence there is.
		const { acts } = run(0, 60_000, (at) => {
			const { freezes: _, ...rest } = lossy(0.3, false)(at);
			return rest;
		});

		expect(acts).toEqual([]);
	});

	it("does not judge loss over a handful of packets", () => {
		// Thirty packets a second, a third of them lost: a still screen's
		// keep-alives on a bad second, not a share that cannot be carried.
		const { acts } = run(0, 60_000, (at) => ({ frames: at / 100, bytes: at * 10, received: (at / 1000) * 20, lost: (at / 1000) * 10, freezes: at / 1000 }));

		expect(acts).toEqual([]);
	});

	it("takes a counter that went backwards for a new stream, not a freeze", () => {
		// Resubscribed at 10 s: everything starts again from nothing.
		const { acts } = run(0, 30_000, (at) => (at < 10_000 ? moving()(at) : moving()(at - 10_000)));

		expect(acts).toEqual([]);
	});
});

describe("what is asked for instead", () => {
	it("is the rung beneath the one this viewer's subscription asks for", () => {
		// A picture sized for the 1080p rung freezes: the step is to 720, not
		// to 1080 again.
		expect(run(0, 10_000, frozenFrom(4_000), LADDER, fresh(0), 1).acts[0]?.act).toEqual({ kind: "cap", rung: R720 });
	});

	it("is the rung beneath the top for a viewer at full size, whatever height its frames arrive at", () => {
		// A share published at 1440p and set to 1080p afterwards: its top now
		// arrives at 1080 lines, the same as its 1080p rung. Read by the
		// frames, this viewer was on the 1080p rung and went to the 720p
		// rung, past the one built for them; the request says the top.
		const at1080 = (at: number) => ({ ...frozenFrom(2_000)(at), height: 1080 });
		expect(run(0, 6_000, at1080, LADDER, fresh(0), 2).acts[0]?.act).toEqual({ kind: "cap", rung: R1080 });
		expect(run(0, 6_000, at1080).acts[0]?.act).toEqual({ kind: "cap", rung: R1080 });
	});

	it("is the rung beneath the original when nothing has been decoded at all", () => {
		// The e3 run: a minute of bytes and not one frame, from the start.
		const { acts } = run(0, 10_000, (at) => ({ frames: 0, bytes: (at / 1000) * 2_000_000 }));

		expect(acts[0]?.act).toEqual({ kind: "cap", rung: R1080 });
	});

	it("is nothing at all for a share with no rungs beneath it", () => {
		// A window of 720 lines or less is published without rungs, and there
		// is nothing smaller to ask for. Asking anyway would be asking for the
		// same picture every second.
		expect(run(0, 60_000, frozenFrom(4_000), [R720]).acts).toEqual([]);
	});

	it("steps down again when the lower rung freezes too, but not before it has had time to arrive", () => {
		const { acts } = run(0, 30_000, frozenFrom(4_000));

		expect(acts.map((one) => one.act)).toEqual([
			{ kind: "cap", rung: R1080 },
			{ kind: "cap", rung: R720 },
		]);

		// The switch asked for at 6 s takes a keyframe to show. Nothing is
		// judged for SETTLE_MS, and then a stall has to be counted again.
		const [first, second] = acts;
		expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(SETTLE_MS + STALL_MS);
	});

	it("does not judge loss again until the rung it asked for has had time to arrive", () => {
		// A line losing a sixth of everything, throughout, and the picture
		// freezing on it. The first step is taken on the loss; the second waits
		// out the switch to the first.
		const [first, second] = run(0, 20_000, lossy(0.15, true)).acts;

		expect(first?.act).toEqual({ kind: "cap", rung: R1080 });
		expect(second?.act).toEqual({ kind: "cap", rung: R720 });
		expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(SETTLE_MS);
	});

	it("never goes below the bottom rung", () => {
		// Frozen for good, so every step is taken; up to the end of the hold
		// there are two to take and no third.
		const { acts } = run(0, 6_000 + HOLD_MS - EVERY_MS, frozenFrom(4_000));

		expect(acts.map((one) => one.act)).toEqual([
			{ kind: "cap", rung: R1080 },
			{ kind: "cap", rung: R720 },
		]);
	});
});

describe("asking for the original again", () => {
	it("happens twenty seconds after the step down, and not before", () => {
		// Frozen until the step down at 6 s takes, then the lower rung moves.
		const { acts } = run(0, 60_000, frozenBetween(4_000, 7_000));

		expect(acts.map((one) => one.act.kind)).toEqual(["cap", "release"]);
		expect((acts[1]?.at ?? 0) - (acts[0]?.at ?? 0)).toBe(HOLD_MS);
	});

	it("happens whether or not anybody is watching", () => {
		// Capped, then the share went off the stage: no readings at all. The
		// clock still runs, so coming back finds the original asked for.
		const capped = run(0, 6_000, frozenFrom(4_000)).watch;

		expect(judge(capped, undefined, LADDER, 6_000 + HOLD_MS - 1).act).toBeUndefined();
		expect(judge(capped, undefined, LADDER, 6_000 + HOLD_MS).act).toEqual({ kind: "release" });
	});
});

/*
Asking for the original again, on a line that cannot carry it.

The acceptance runs of 2026-10-14 found the fallback making freezes of its own:
with one viewer, the step down leaves the original unsubscribed and dynacast
stops it at the sender, so every return to it is a restart — seconds of no
frames — and on a line that cannot carry it, a freeze and a step down after
that, every forty seconds to a minute for the whole share. What these guard is
the waits growing while the returns keep failing, and only then: a viewer whose
trouble has passed must not be left on the lower rung for minutes because of
what the line did before.
*/

/**
 * A viewer driven through the rule second by second, on a line described by
 * `carries(at)`: where it says no, the original stands still `after` ms after
 * it was asked for — bytes arriving, nothing decoded — while any lower rung
 * moves. Returns how long each cap was held before the original was asked for
 * again, in the order they were taken.
 */
function holds(to: number, carries: (at: number) => boolean, after = 10_000): number[] {
	let watch = fresh(0);
	let frames = 0;
	let asked = 0;
	let capped: number | undefined;
	const held: number[] = [];

	for (let at = 0; at <= to; at += EVERY_MS) {
		if (watch.cap || carries(at) || at - asked < after) frames += 30;

		const { watch: next, act } = judge(watch, { at, frames, bytes: at * 2_000, received: at * 2, lost: 0 }, LADDER, at);
		watch = next;

		if (act?.kind === "cap" && capped === undefined) capped = at;
		if (act?.kind === "release") {
			if (capped !== undefined) held.push(at - capped);
			capped = undefined;
			asked = at;
		}
	}

	return held;
}

/** Readings one second apart from `from` until the rule first acts, and the watch it left. */
function firstStep(watch: Watch, from: number, shape: (at: number) => Omit<Reading, "at">) {
	const acts: { at: number; act: NonNullable<ReturnType<typeof judge>["act"]> }[] = [];
	let current = watch;

	for (let at = from; at <= from + 60_000 && !acts.length; at += EVERY_MS) {
		const { watch: next, act } = judge(current, { at, ...shape(at) }, LADDER, at);
		current = next;
		if (act) acts.push({ at, act });
	}

	return { acts, watch: current };
}

describe("asking for the original again after it froze again", () => {
	it("waits twice as long each time, up to five minutes", () => {
		// The original never carried: every return freezes ten seconds in.
		expect(holds(1_400_000, () => false)).toEqual([20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
		expect(LONGEST_HOLD_MS).toBe(300_000);
	});

	it("starts again from twenty seconds once the original has held for two minutes", () => {
		// Bad for the first 200 s, good until 600 s, bad again after. The return
		// at 348 s holds; two minutes on, what went before is forgiven, and the
		// trouble at 600 s is met with twenty seconds, not with five minutes —
		// and grows again from there.
		const line = (at: number) => at >= 200_000 && at < 600_000;

		expect(holds(800_000, line)).toEqual([20_000, 40_000, 80_000, 160_000, 20_000, 40_000, 80_000]);
	});

	it("counts a freeze long after a return as a new trouble rather than a failed return", () => {
		// The original carried for two and a half minutes after each return.
		expect(holds(1_000_000, () => false, TRIED_MS + 30_000)).toEqual([20_000, 20_000, 20_000, 20_000, 20_000]);
	});

	it("does not take a second step under one cap for a second failed return", () => {
		// The original fails once after a return, and is capped for forty
		// seconds; the 1080p rung then freezes too. That is one failed return
		// and two steps, and the wait stays forty — counted from the second
		// step, as every step's is — rather than doubling again to eighty.
		const capped = run(0, 6_000, frozenFrom(4_000)).watch;
		let watch = judge(capped, undefined, LADDER, 26_000).watch;

		const acts: { at: number; act: NonNullable<ReturnType<typeof judge>["act"]> }[] = [];
		for (let at = 30_000; at <= 120_000; at += EVERY_MS) {
			const { watch: next, act } = judge(watch, { at, ...frozenFrom(6_000)(at - 30_000) }, LADDER, at);
			watch = next;
			if (act) acts.push({ at, act });
		}

		expect(acts.slice(0, 3).map((one) => one.act)).toEqual([
			{ kind: "cap", rung: R1080 },
			{ kind: "cap", rung: R720 },
			{ kind: "release" },
		]);
		expect((acts[2]?.at ?? 0) - (acts[1]?.at ?? 0)).toBe(2 * HOLD_MS);
	});

	it("remembers a failed return through a share taken off the stage", () => {
		// Capped, and released while nobody was looking — no readings at all —
		// then back, and the original freezes once more. That is the original
		// failing again, and the wait is doubled, not forgotten with the
		// readings.
		const capped = run(0, 6_000, frozenFrom(4_000)).watch;
		const released = judge(capped, undefined, LADDER, 26_000);
		expect(released.act).toEqual({ kind: "release" });

		const watch = judge(released.watch, undefined, LADDER, 27_000).watch;
		const { acts, watch: after } = firstStep(watch, 30_000, (at) => frozenFrom(6_000)(at - 30_000));

		expect(acts[0]?.act.kind).toBe("cap");
		expect(after.cap?.until).toBe((acts[0]?.at ?? 0) + 2 * HOLD_MS);
	});

	it("remembers a failed return through a stream that was replaced", () => {
		// Released while watching, and then the counters start again from
		// nothing — a resubscription — before the original freezes once more.
		// The readings of the old stream are thrown away; how the original
		// fared is not.
		const capped = run(0, 6_000, frozenFrom(4_000)).watch;
		const released = judge(capped, { at: 26_000, ...frozenBetween(4_000, 7_000)(26_000) }, LADDER, 26_000);
		expect(released.act).toEqual({ kind: "release" });

		const { acts, watch: after } = firstStep(released.watch, 30_000, (at) => frozenFrom(6_000)(at - 30_000));

		expect(acts[0]?.act.kind).toBe("cap");
		expect(after.cap?.until).toBe((acts[0]?.at ?? 0) + 2 * HOLD_MS);
	});
});

describe("reading the receiver", () => {
	it("reads the video stream's counters, and nothing that is not a number", () => {
		const report = new Map<string, Record<string, unknown>>([
			["A", { type: "inbound-rtp", kind: "audio", bytesReceived: 9e9, framesDecoded: 0 }],
			["V", { type: "inbound-rtp", kind: "video", bytesReceived: 123, framesDecoded: 4, packetsReceived: 5, packetsLost: 1, freezeCount: 2 }],
			["C", { type: "codec", mimeType: "video/H264" }],
		]);

		expect(readInbound(report, 7)).toEqual({ at: 7, bytes: 123, frames: 4, received: 5, lost: 1, freezes: 2 });
		expect(readInbound(new Map([["V", { type: "inbound-rtp", kind: "video", bytesReceived: "lots" }]]), 0).bytes).toBeUndefined();
	});

	it("takes the rungs from the publication, smallest first, one per height", () => {
		const layers = [
			{ quality: 2, width: 2560, height: 1440 },
			{ quality: 0, width: 1280, height: 720 },
			{ quality: 1, width: 1920, height: 1080 },
			{ quality: 1, width: 1920, height: 1080 },
			{ quality: 0, width: 0, height: 0 },
		];

		// biome-ignore lint: only the field read
		expect(rungsOf({ trackInfo: { layers } } as any)).toEqual(LADDER);
	});

	it("names the rung a request is answered with by the server's rule", () => {
		// The smallest rung at least nine tenths as tall as asked.
		expect(rungAsked(LADDER, { width: 1400, height: 790 })).toBe(0);
		expect(rungAsked(LADDER, { width: 1500, height: 810 })).toBe(1);
		expect(rungAsked(LADDER, { width: 2134, height: 1200 })).toBe(1);
		expect(rungAsked(LADDER, { width: 2504, height: 1408 })).toBe(2);
		expect(rungAsked(LADDER, { width: 9000, height: 5000 })).toBe(2);
		expect(rungAsked(LADDER, undefined)).toBeUndefined();

		// Taller than wide: the server compares the request's width.
		expect(rungAsked(LADDER, { width: 790, height: 1400 }, true)).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */
/* In a room                                                                  */
/* -------------------------------------------------------------------------- */

/** What the SDK sent the server for one subscription, in order. */
type Sent = { width?: number; height?: number }[];

/** A remote video track whose receiver reports `shape(now)`. */
function receiving(shape: (at: number) => Omit<Reading, "at">) {
	// The shape is told the time since the track was made, whatever the fake
	// clock started at.
	const start = performance.now();
	const track = Object.create(RemoteVideoTrack.prototype) as RemoteVideoTrack;
	Object.defineProperty(track, "kind", { value: Track.Kind.Video });
	// Read by the SDK's log context, and by nothing here.
	Object.defineProperty(track, "mediaStreamTrack", { value: { enabled: true, id: "share" } });
	Object.defineProperty(track, "receiver", {
		value: {
			getStats: async () => {
				const counters = shape(performance.now() - start);
				return new Map([
					[
						"V",
						{
							type: "inbound-rtp",
							kind: "video",
							bytesReceived: counters.bytes,
							framesDecoded: counters.frames,
							packetsReceived: counters.received,
							packetsLost: counters.lost,
							freezeCount: counters.freezes,
						},
					],
				]);
			},
		},
	});
	return track;
}

/**
 * A real publication of a share, so that what the SDK does with a request —
 * including dropping it while there is no track — is what is tested. The
 * fakes these tests used first took every call, and that is how a lift told
 * into the gap before a track arrived went unseen.
 */
function publish(source = Track.Source.ScreenShare) {
	const info = {
		sid: "TR_share",
		name: "screen",
		source: source === Track.Source.ScreenShare ? 3 : 1,
		mimeType: "video/H264",
		simulcast: true,
		type: 1,
		muted: false,
		width: 2560,
		height: 1440,
		layers: LADDER.map((rung, quality) => ({ quality, ...rung })),
	};

	const publication = new RemoteTrackPublication(Track.Kind.Video, info as never, true);
	const sent: Sent = [];
	publication.on(TrackEvent.UpdateSettings, (settings: { width?: number; height?: number }) =>
		sent.push({ width: settings.width, height: settings.height }),
	);

	vi.spyOn(publication, "setVideoDimensions");
	vi.spyOn(publication, "setVideoQuality");

	return { publication, sent };
}

/** What adaptive streaming measured for the picture, as the SDK reports it. */
function measure(publication: RemoteTrackPublication, width: number, height: number) {
	(publication as unknown as { handleVideoDimensionsChange(d: Rung): void }).handleVideoDimensionsChange({ width, height });
}

/** A room holding `publication`, whose local participant throws if anything here touches it. */
function room(publication: RemoteTrackPublication) {
	const handlers = new Map<string, (...args: unknown[]) => void>();

	const untouchable = new Proxy(
		{},
		{
			get(_target, name) {
				throw new Error(`the local participant was touched: ${String(name)}`);
			},
		},
	);

	const participants = new Map([["P", { trackPublications: new Map([[publication.trackSid, publication]]) }]]);

	const fake = {
		remoteParticipants: participants,
		localParticipant: untouchable,
		on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
		off: (event: string) => handlers.delete(event),
	};

	// biome-ignore lint: the fake is deliberately narrow
	return { room: fake as any, handlers, participants };
}

/** A share on a large screen at full size, receiving `shape`. */
function watching(shape: (at: number) => Omit<Reading, "at">, source = Track.Source.ScreenShare) {
	const { publication, sent } = publish(source);
	publication.track = receiving(shape);
	measure(publication, 2504, 1408);
	return { publication, sent, ...room(publication) };
}

const last = (sent: Sent) => sent[sent.length - 1];

describe("in a room", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("asks for the lower rung through this viewer's own subscription, then for the original", async () => {
		// Frozen from 4 s; the lower rung asked for at 6 s arrives at 7 s.
		const { room: made, publication, sent } = watching(frozenBetween(4_000, 7_000));
		const stop = watchShareFreezes(made);

		await vi.advanceTimersByTimeAsync(4_000 + STALL_MS + EVERY_MS);
		expect(publication.setVideoDimensions).toHaveBeenCalledTimes(1);
		expect(last(sent)).toEqual(R1080);

		// Lifted: the server is asked for what the picture measures again.
		await vi.advanceTimersByTimeAsync(HOLD_MS);
		expect(publication.setVideoDimensions).toHaveBeenLastCalledWith({ width: UNCAPPED.width, height: UNCAPPED.height });
		expect(last(sent)).toEqual({ width: 2504, height: 1408 });

		// Never by quality, which asks for the top by name on a share without
		// a layer of that name and so undoes the measurement.
		expect(publication.setVideoQuality).not.toHaveBeenCalled();

		stop();
	});

	it("steps a picture sized for the 1080p rung straight to 720p", async () => {
		// What the subscription asks for is read from what the SDK sends.
		const { room: made, publication, sent } = watching(frozenFrom(2_000));
		measure(publication, 1800, 1012);
		const stop = watchShareFreezes(made);

		await vi.advanceTimersByTimeAsync(2_000 + STALL_MS + EVERY_MS);
		expect(last(sent)).toEqual(R720);

		stop();
	});

	it("never touches a share that does not freeze", async () => {
		// The subscription is then exactly what it would be without this file:
		// adaptive streaming's measurement and nothing else.
		const { room: made, publication } = watching(moving());
		const stop = watchShareFreezes(made);

		await vi.advanceTimersByTimeAsync(120_000);
		expect(publication.setVideoDimensions).not.toHaveBeenCalled();

		stop();
	});

	it("leaves the camera to adaptive streaming", async () => {
		const { room: made, publication } = watching(frozenFrom(2_000), Track.Source.Camera);
		const stop = watchShareFreezes(made);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(publication.setVideoDimensions).not.toHaveBeenCalled();

		stop();
	});

	it("reads nothing in a tab in the background", async () => {
		vi.stubGlobal("document", { visibilityState: "hidden" });

		const { room: made, publication } = watching(frozenFrom(2_000));
		const stop = watchShareFreezes(made);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(publication.setVideoDimensions).not.toHaveBeenCalled();

		stop();
	});

	/*
	 * Capped, then shrunk to its card — the picture unmounts, the library
	 * unsubscribes, the track goes — past the end of the hold, and then put
	 * back: wanted again at once, the track a round trip or two later. The SDK
	 * drops a size told in between and says nothing; told only then and
	 * recorded as told, the lift was never told again and the viewer stayed a
	 * rung down, full screen included, until the share ended.
	 */
	for (const gap of [0, EVERY_MS, 3 * EVERY_MS]) {
		it(`lifts a cap left on a share that went to its card, its track back ${gap} ms after it was wanted`, async () => {
			const { room: made, publication, sent, handlers } = watching(frozenFrom(2_000));
			const stop = watchShareFreezes(made);

			await vi.advanceTimersByTimeAsync(2_000 + STALL_MS + EVERY_MS);
			expect(last(sent)).toEqual(R1080);

			publication.setSubscribed(false);
			publication.track = undefined;
			await vi.advanceTimersByTimeAsync(HOLD_MS + 5_000);

			publication.setSubscribed(true);
			await vi.advanceTimersByTimeAsync(gap);

			publication.track = receiving(moving());
			handlers.get(RoomEvent.TrackSubscribed)?.(publication.track, publication);
			measure(publication, 2504, 1408);
			await vi.advanceTimersByTimeAsync(EVERY_MS);

			expect(last(sent)).toEqual({ width: 2504, height: 1408 });

			stop();
		});
	}

	it("lifts it as soon as the track is here, before the room says so", async () => {
		// During a reconnection the room holds TrackSubscribed back until it
		// has reconnected; the track is already here, and the tick tells it.
		const { room: made, publication, sent } = watching(frozenFrom(2_000));
		const stop = watchShareFreezes(made);

		await vi.advanceTimersByTimeAsync(2_000 + STALL_MS + EVERY_MS);
		publication.setSubscribed(false);
		publication.track = undefined;
		await vi.advanceTimersByTimeAsync(HOLD_MS + 5_000);

		publication.setSubscribed(true);
		await vi.advanceTimersByTimeAsync(2 * EVERY_MS);
		publication.track = receiving(moving());
		measure(publication, 2504, 1408);
		await vi.advanceTimersByTimeAsync(EVERY_MS);

		expect(last(sent)).toEqual({ width: 2504, height: 1408 });

		stop();
	});

	/**
	 * A share on a line that carries the 1080p rung and not the original:
	 * every time the original is asked for, it moves for eight seconds and
	 * then stands still while bytes go on arriving. `waits()` is how long each
	 * cap was held before the original was asked for again, read from what the
	 * SDK sent the server and when.
	 */
	function cannotCarryTheOriginal() {
		const { publication, sent } = publish();
		const at: { when: number; height?: number }[] = [];
		publication.on(TrackEvent.UpdateSettings, (settings: { height?: number }) =>
			at.push({ when: performance.now(), height: settings.height }),
		);

		let frames = 0;
		let bytes = 0;
		let original = performance.now();
		let wasOriginal = true;
		const line = () => {
			const now = performance.now();
			const onOriginal = (last(sent)?.height ?? 0) > R1080.height;
			if (onOriginal && !wasOriginal) original = now;
			wasOriginal = onOriginal;

			bytes += 2_000_000;
			if (!onOriginal || now - original < 8_000) frames += 30;
			return { frames, bytes, received: bytes / 1000, lost: 0 };
		};

		publication.track = receiving(line);
		measure(publication, 2504, 1408);

		// By changes of what was asked for, since the same cap is told again
		// to a share that comes back from its card.
		const changes = () => {
			const out: { when: number; capped: boolean }[] = [];
			for (const one of at) {
				if (!one.height) continue;
				const capped = one.height <= R1080.height;
				if (out[out.length - 1]?.capped !== capped) out.push({ when: one.when, capped });
			}
			return out;
		};
		const caps = () => changes().filter((one) => one.capped);
		const waits = () => {
			const all = changes();
			return all.flatMap((one, index) => {
				const next = all[index + 1];
				return one.capped && next ? [next.when - one.when] : [];
			});
		};

		return { publication, line, caps, waits, ...room(publication) };
	}

	it("asks for the original again later each time it freezes again, through the SDK", async () => {
		const { room: made, waits } = cannotCarryTheOriginal();
		const stop = watchShareFreezes(made);

		await vi.advanceTimersByTimeAsync(200_000);
		stop();

		expect(waits().slice(0, 3)).toEqual([HOLD_MS, 2 * HOLD_MS, 4 * HOLD_MS]);
	});

	it("remembers how the original fared through a share taken to its card and back", async () => {
		// Taken to its card during the second cap and put back: a new
		// subscription, a new track, the readings thrown away. How often the
		// original has failed is about the line, not the subscription, and
		// survives it — the third wait is eighty seconds, not forty.
		const { room: made, publication, line, caps, waits, handlers } = cannotCarryTheOriginal();
		const stop = watchShareFreezes(made);

		while (caps().length < 2) await vi.advanceTimersByTimeAsync(EVERY_MS);
		await vi.advanceTimersByTimeAsync(5_000);

		publication.setSubscribed(false);
		publication.track = undefined;
		await vi.advanceTimersByTimeAsync(3_000);

		publication.setSubscribed(true);
		publication.track = receiving(line);
		handlers.get(RoomEvent.TrackSubscribed)?.(publication.track, publication);
		measure(publication, 2504, 1408);

		await vi.advanceTimersByTimeAsync(200_000);
		stop();

		expect(waits().slice(0, 3)).toEqual([HOLD_MS, 2 * HOLD_MS, 4 * HOLD_MS]);
	});

	it("follows the publication the room has now, after a full reconnection", async () => {
		// Every publication is a new object under the same sid, swapped in
		// between two ticks. The new one freezes at once; the request has to
		// land on it, not on the one that is gone.
		const { room: made, participants, sent: before } = watching(moving());
		const stop = watchShareFreezes(made);
		await vi.advanceTimersByTimeAsync(3_000);

		const { publication: renewed, sent } = publish();
		renewed.track = receiving((at) => ({ bytes: at * 2_000, frames: 5, received: at, lost: 0 }));
		measure(renewed, 2504, 1408);
		participants.set("P", { trackPublications: new Map([[renewed.trackSid, renewed]]) });

		await vi.advanceTimersByTimeAsync(8_000);

		expect(sent).toContainEqual(R1080);
		expect(before.filter((one) => one.height === R1080.height)).toEqual([]);

		stop();
	});
});
