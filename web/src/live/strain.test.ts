/**
 * What these guard is a hint that is wrong, which is worse than no hint.
 *
 * live/strain.ts tells somebody sharing their screen that their line cannot
 * carry the share, and offers a smaller setting. Its predecessor — an automatic
 * follower, deleted — took a still screen for a struggling one and remembered a
 * bad line for ever, and both faults were silent: nothing on anybody's screen
 * said the share had been quietly cut to a fifth of what was chosen. The same
 * two faults are possible here in a gentler form, a card telling somebody with
 * a perfectly good line to send less, and they would be just as silent to
 * anybody reading the code.
 *
 * So most of what is here is the things that must *not* raise the card: the
 * estimate's climb at the start of a share, which reads exactly like a full
 * line reading by reading; a still screen; a machine too busy to encode; a
 * ceiling too low for the content, which a smaller setting would make worse; a
 * browser that reports less than Chrome. Each was either measured in Chrome or
 * follows from what was, and the recorded readings are in strain.recorded.ts
 * with the conditions they were taken under.
 *
 * The rest is the card's promises about itself: that it asks nothing of the
 * share until somebody presses for it, that "Not now" lasts exactly one share
 * — a reconnect included, which publishes the same share again — that a change
 * of setting starts the watch again and takes the card down with it, and that
 * nothing is written down anywhere.
 */

import { act, renderHook } from "@testing-library/react";
import type { Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIDDLE_FAST, SMALL, type ShareSetting, askOf, retune, runningShare, share, stepsDown } from "./room";
import {
	type Counters,
	EVERY_MS,
	type Hint,
	type Sample,
	classify,
	judge,
	megabits,
	readSample,
	suggest,
	useShareStrain,
} from "./strain";
import { RECORDED, type Row } from "./strain.recorded";

const M = 1_000_000;

/*
 * The owner's numbers, written out rather than imported. A test that took its
 * timings from the constants it is checking would move along with them: set
 * the quiet time to nothing and the test would wait nothing and pass, which is
 * the fault CLAUDE.md records one test here already having had.
 */
const QUIET_START = 30_000;
const QUIET_CHANGE = 15_000;
const WINDOW = 20_000;

/* -------------------------------------------------------------------------- */
/* Reading Chrome's report                                                    */
/* -------------------------------------------------------------------------- */

/*
 * Two consecutive readings exactly as Chrome 145 gave them, from the recording
 * with the line held at 8 Mb/s. Kept whole because their shape is the point:
 * three outbound entries in no particular order, a media-source linked from
 * only one of them — the bottom rung, not the top — and the estimate on a pair
 * reached through the transport.
 */
const CHROME_BEFORE = [
	{ type: "candidate-pair", id: "CPmm4orUUS_2+XMyrOk", timestamp: 1791884715847, state: "succeeded", nominated: true, availableOutgoingBitrate: 8000000 },
	{ type: "outbound-rtp", id: "OT01V2131759287", timestamp: 1791884715847, rid: "h", active: true, bytesSent: 22972777, framesSent: 168, framesEncoded: 168, framesPerSecond: 4, frameWidth: 1280, frameHeight: 720, targetBitrate: 1250070, qualityLimitationReason: "none", totalEncodeTime: 1.144, kind: "video" },
	{ type: "outbound-rtp", id: "OT01V3993335387", timestamp: 1791884715847, rid: "f", active: true, bytesSent: 17469907, framesSent: 84, framesEncoded: 84, framesPerSecond: 2, frameWidth: 1920, frameHeight: 1080, targetBitrate: 2325206, qualityLimitationReason: "none", totalEncodeTime: 0.593, kind: "video" },
	{ type: "outbound-rtp", id: "OT01V517873725", timestamp: 1791884715847, rid: "q", active: true, bytesSent: 6137959, framesSent: 168, framesEncoded: 168, framesPerSecond: 4, frameWidth: 640, frameHeight: 360, targetBitrate: 250004, qualityLimitationReason: "none", mediaSourceId: "SV1", totalEncodeTime: 0.419, kind: "video" },
	{ type: "media-source", id: "SV1", timestamp: 1791884715847, kind: "video", frames: 2833, framesPerSecond: 56, width: 1920, height: 1080 },
	{ type: "transport", id: "T01", timestamp: 1791884715847, selectedCandidatePairId: "CPmm4orUUS_2+XMyrOk" },
];

const CHROME_AFTER = [
	{ type: "candidate-pair", id: "CPmm4orUUS_2+XMyrOk", timestamp: 1791884717849, state: "succeeded", nominated: true, availableOutgoingBitrate: 8000000 },
	{ type: "outbound-rtp", id: "OT01V2131759287", timestamp: 1791884717849, rid: "h", active: true, bytesSent: 23894605, framesSent: 175, framesEncoded: 175, framesPerSecond: 3, frameWidth: 1280, frameHeight: 720, targetBitrate: 1250081, qualityLimitationReason: "none", totalEncodeTime: 1.205, kind: "video" },
	{ type: "outbound-rtp", id: "OT01V3993335387", timestamp: 1791884717849, rid: "f", active: true, bytesSent: 18283613, framesSent: 87, framesEncoded: 87, framesPerSecond: 1, frameWidth: 1920, frameHeight: 1080, targetBitrate: 2325189, qualityLimitationReason: "none", totalEncodeTime: 0.613, kind: "video" },
	{ type: "outbound-rtp", id: "OT01V517873725", timestamp: 1791884717849, rid: "q", active: true, bytesSent: 6386541, framesSent: 175, framesEncoded: 175, framesPerSecond: 3, frameWidth: 640, frameHeight: 360, targetBitrate: 250010, qualityLimitationReason: "none", mediaSourceId: "SV1", totalEncodeTime: 0.433, kind: "video" },
	{ type: "media-source", id: "SV1", timestamp: 1791884717849, kind: "video", frames: 2944, framesPerSecond: 54, width: 1920, height: 1080 },
	{ type: "transport", id: "T01", timestamp: 1791884717849, selectedCandidatePairId: "CPmm4orUUS_2+XMyrOk" },
];

const CHROME_ENCODINGS: RTCRtpEncodingParameters[] = [
	{ rid: "q", active: true, maxBitrate: 500000, maxFramerate: 15 },
	{ rid: "h", active: true, maxBitrate: 2500000, maxFramerate: 30 },
	{ rid: "f", active: true, maxBitrate: 19400000, maxFramerate: 60 },
];

type Entry = Record<string, unknown>;

function read(entries: Entry[], encodings = CHROME_ENCODINGS, previous?: Counters, now = 0) {
	return readSample(entries as never, encodings, previous, now);
}

/** The same report with one field taken out of whichever entries have it. */
function without(entries: Entry[], field: string, type?: string): Entry[] {
	return entries.map((entry) => {
		if (type && entry.type !== type) return entry;
		const { [field]: _gone, ...rest } = entry;
		return rest;
	});
}

describe("reading what Chrome reports", () => {
	it("finds the top layer by its rid and the capture through whichever layer links it", () => {
		const first = read(CHROME_BEFORE);
		const { sample } = read(CHROME_AFTER, CHROME_ENCODINGS, first.counters, 2002);
		const seconds = 2.002;

		expect(sample.source).toBeCloseTo((2944 - 2833) / seconds, 5);
		// The top layer's frames and bits, not the bottom rung's: "f" was the
		// middle entry of three, and the rung that carries the link is "q".
		expect(sample.sent).toBeCloseTo((87 - 84) / seconds, 5);
		expect(sample.spent).toBeCloseTo(((18283613 - 17469907) * 8) / seconds, 0);
		expect(sample.rest).toBeCloseTo(((23894605 - 22972777 + 6386541 - 6137959) * 8) / seconds, 0);
		// The rungs one by one, in the order of their encodings — not the
		// report's, which had "h" first — each with its own ceiling.
		expect(sample.rungs?.map((rung) => rung.ceiling)).toEqual([500_000, 2_500_000]);
		expect(sample.rungs?.[0]?.spent).toBeCloseTo(((6386541 - 6137959) * 8) / seconds, 0);
		expect(sample.rungs?.[1]?.spent).toBeCloseTo(((23894605 - 22972777) * 8) / seconds, 0);
		expect(sample.target).toBe(2325189);
		expect(sample.ceiling).toBe(19_400_000);
		expect(sample.asked).toBe(22_400_000);
		expect(sample.available).toBe(8_000_000);
		expect(sample.reason).toBe("none");
		expect([sample.width, sample.height]).toEqual([1920, 1080]);

		// And, read whole, this is the case the hint is for: 55 frames a second
		// captured, one and a half sent, a quarter of the ceiling allotted, and
		// all of it spent — while the browser calls the limitation "none".
		expect(classify(sample)).toBe("strained");
	});

	it("says nothing about a rate it has only one reading of", () => {
		const { sample } = read(CHROME_AFTER);

		expect(sample.spent).toBeUndefined();
		expect(classify(sample)).toBe("unknown");
	});

	it("takes a counter that went backwards as a new stream, not a negative rate", () => {
		const first = read(CHROME_AFTER);
		const { sample } = read(CHROME_BEFORE.map((entry) => ({ ...entry, timestamp: 1791884719851 })), CHROME_ENCODINGS, first.counters);

		expect(sample.sent).toBe(2); // fell back to the browser's own figure
		expect(sample.spent).toBeUndefined();
		expect(classify(sample)).toBe("unknown");
	});

	it("counts the whole line where the browser does, and only against the same pair", () => {
		// The pair's own count, which in Chrome 145 ran ahead of the share's
		// layers by a second sender's worth: the camera and the voice go out on
		// the same connection, and a line is full of everything on it.
		const counted = (entries: Entry[], bytes: number, id = "CPmm4orUUS_2+XMyrOk") =>
			entries.map((entry) => {
				if (entry.type === "candidate-pair") return { ...entry, id, bytesSent: bytes };
				if (entry.type === "transport") return { ...entry, selectedCandidatePairId: id };
				return entry;
			});

		const first = read(counted(CHROME_BEFORE, 50_000_000));
		const { sample } = read(counted(CHROME_AFTER, 52_000_000), CHROME_ENCODINGS, first.counters, 2002);

		expect(sample.carried).toBeCloseTo((2_000_000 * 8) / 2.002, 0);

		// The connection moved to another pair: two counts of two things, and the
		// difference between them is not a rate of anything.
		const moved = read(counted(CHROME_AFTER, 52_000_000, "CPelsewhere"), CHROME_ENCODINGS, first.counters, 2002);
		expect(moved.sample.carried).toBeUndefined();

		// And Chrome's own report as recorded, which kept no count, says nothing.
		expect(read(CHROME_AFTER, CHROME_ENCODINGS, read(CHROME_BEFORE).counters, 2002).sample.carried).toBeUndefined();
	});

	it("reads a top layer nobody is watching as no evidence", () => {
		// dynacast pauses the top rung when nobody has the share at full size,
		// and a paused rung sends nothing for reasons that have nothing to do
		// with the line. Read as strained, it would be the strongest evidence
		// there is.
		const paused = CHROME_ENCODINGS.map((encoding) => (encoding.rid === "f" ? { ...encoding, active: false } : encoding));
		const first = read(CHROME_BEFORE, paused);
		const { sample } = read(CHROME_AFTER, paused, first.counters, 2002);

		expect(sample.active).toBe(false);
		expect(classify(sample)).toBe("unknown");
	});

	/*
	 * Two consecutive readings from Firefox 157 (Playwright's Nightly build),
	 * headless, the same loopback page. It drops frames too — fifteen sent of
	 * nineteen captured — but has no target, no limitation reason and no
	 * estimate of the line, and without those nothing can tell a full line
	 * from a busy machine or a ceiling too low. So it is told nothing, for as
	 * long as it shares.
	 */
	it("tells Firefox nothing, because it reports too little to be sure", () => {
		const first: Entry[] = [
			{ type: "outbound-rtp", id: "dfc7d826", timestamp: 1791887135722, kind: "video", bytesSent: 2749786, framesSent: 83, framesEncoded: 83, framesPerSecond: 15, frameWidth: 1280, frameHeight: 720 },
			{ type: "media-source", id: "mediasource_video_0{b68aa4ef-719a-45bd-b390-0cc284da4473}", timestamp: 1791887135722, kind: "video", framesPerSecond: 20, frames: 132, width: 1280, height: 720 },
			{ type: "candidate-pair", id: "684970da", timestamp: 1791887135722, state: "succeeded", nominated: true, selected: true },
			{ type: "transport", id: "41e5c119", timestamp: 1791887135722, selectedCandidatePairId: "684970da" },
		];
		const encodings = [{ active: true, maxBitrate: 4_000_000, maxFramerate: 30 }];

		let counters = readSample(first as never, encodings, undefined, 0).counters;
		const samples: Sample[] = [];

		// A minute and a half of it, the counters climbing the way they did.
		for (let step = 1; step <= 45; step++) {
			const at = step * 2000;
			const later = first.map((entry) => {
				const moved = { ...entry, timestamp: Number(entry.timestamp) + at };
				if (entry.type === "outbound-rtp") {
					return { ...moved, bytesSent: Number(entry.bytesSent) + step * 950006, framesSent: Number(entry.framesSent) + step * 30 };
				}
				if (entry.type === "media-source") return { ...moved, frames: Number(entry.frames) + step * 38 };
				return moved;
			});
			const out = readSample(later as never, encodings, counters, at);
			counters = out.counters;
			samples.push(out.sample);
		}

		expect(samples[0]?.source).toBeCloseTo(19, 0);
		expect(samples[0]?.sent).toBeCloseTo(15, 0);
		expect(samples.every((sample) => classify(sample) === "unknown")).toBe(true);
		expect(replay(samples, { quality: "1080p", frameRate: 30 })).toEqual([]);
	});

	it.each([
		["the line's estimate", "availableOutgoingBitrate", "candidate-pair"],
		["the limitation reason", "qualityLimitationReason", undefined],
		["the target", "targetBitrate", undefined],
		["the capture's frames", "frames", "media-source"],
		["the layer's bytes", "bytesSent", undefined],
	])("says nothing without %s", (_name, field, type) => {
		const before = without(CHROME_BEFORE, field, type);
		const after = without(CHROME_AFTER, field, type);

		// The capture's rate has a second source in the browser's own figure;
		// take that away too, or the reading is not missing anything.
		const strip = (entries: Entry[]) => (field === "frames" ? without(entries, "framesPerSecond", "media-source") : entries);

		const first = read(strip(before));
		const { sample } = read(strip(after), CHROME_ENCODINGS, first.counters, 2002);

		expect(classify(sample)).toBe("unknown");
	});
});

/* -------------------------------------------------------------------------- */
/* Replaying a share                                                          */
/* -------------------------------------------------------------------------- */

/** One recorded row back into the shape Chrome reports it in. */
function chromeShaped(row: Row): { entries: Entry[]; encodings: RTCRtpEncodingParameters[] } {
	const [at, available, [frames, fps, width, height], layers, encodings] = row;

	const entries: Entry[] = [
		{ type: "transport", id: "T01", timestamp: at, selectedCandidatePairId: "CP1" },
		{ type: "candidate-pair", id: "CP1", timestamp: at, state: "succeeded", nominated: true, ...(available >= 0 ? { availableOutgoingBitrate: available } : {}) },
		{ type: "media-source", id: "SV1", timestamp: at, kind: "video", frames, framesPerSecond: fps, width, height },
	];

	for (const [rid, bytes, sent, rate, w, h, target, reason] of layers) {
		entries.push({
			type: "outbound-rtp",
			id: `OT-${rid}`,
			timestamp: at,
			kind: "video",
			rid,
			active: true,
			bytesSent: bytes,
			framesSent: sent,
			framesEncoded: sent,
			...(rate === null ? {} : { framesPerSecond: rate }),
			...(w === null ? {} : { frameWidth: w, frameHeight: h }),
			targetBitrate: target,
			qualityLimitationReason: reason,
			// As Chrome does it: the link from the bottom rung only.
			...(rid === "q" ? { mediaSourceId: "SV1" } : {}),
		});
	}

	return { entries, encodings: encodings.map(([rid, active, maxBitrate]) => ({ rid, active, maxBitrate })) };
}

interface Said {
	at: number;
	hint: Hint | null;
}

/**
 * Feed readings through the judge the way the hook does, and keep what it said.
 *
 * `settled` is the moment readings start to count; the hook works it out from
 * when the share began and last changed.
 */
function replay(samples: Sample[], setting: ShareSetting, settled = QUIET_START) {
	const said: Said[] = [];
	let showing = false;

	for (let index = 1; index <= samples.length; index++) {
		const verdict = judge(samples.slice(0, index), settled, setting, showing);
		const at = samples[index - 1]?.at ?? 0;

		if (verdict === null) {
			showing = false;
			said.push({ at, hint: null });
		} else if (verdict) {
			showing = true;
			said.push({ at, hint: verdict });
		}
	}

	return said;
}

function fromRecording(rows: Row[]): Sample[] {
	let counters: Counters | undefined;

	return rows.map((row) => {
		const { entries, encodings } = chromeShaped(row);
		const out = readSample(entries as never, encodings, counters, row[0]);
		counters = out.counters;
		return out.sample;
	});
}

const AT_1440_60: ShareSetting = { quality: "1440p", frameRate: 60 };
const AT_1080_60: ShareSetting = { quality: "1080p", frameRate: 60 };

describe("recorded in Chrome", () => {
	it("says so on a line that genuinely cannot carry the share, once, and not early", () => {
		// 1440p at sixty asking 34.4 Mb/s on a line held at 25, with content
		// that costs what a game costs: 36 of 57 frames sent, for a minute.
		const said = replay(fromRecording(RECORDED.limit1440Noise ?? []), AT_1440_60);

		expect(said).toHaveLength(1);

		const [first] = said;
		if (!first?.hint) throw new Error("nothing was said");

		// Thirty seconds of quiet and then twenty of evidence: never before.
		expect(first.at).toBeGreaterThanOrEqual(QUIET_START + WINDOW - EVERY_MS);
		expect(megabits(first.hint.have)).toBe("25");
		expect(megabits(first.hint.need)).toBe("37");
		expect(first.hint.to).toEqual({ quality: "1080p", frameRate: 30 });
	});

	it("takes it back once the line is lifted", () => {
		// The same share, with the cap removed by renegotiating at 56 seconds.
		// The estimate climbs to 144 and the top layer is given its whole
		// ceiling. It still drops frames — the content needs more than 34.4 —
		// but that is the ceiling's doing, and a smaller setting would make it
		// worse, so the card must go.
		const said = replay(fromRecording(RECORDED.recover1440Noise ?? []), AT_1440_60);

		expect(said.map((one) => one.hint === null)).toEqual([false, true]);

		const [shown, withdrawn] = said;
		expect(shown?.at).toBeLessThan(56_000);
		expect(withdrawn?.at).toBeGreaterThan(56_000 + WINDOW * 0.75);
		expect(withdrawn?.at).toBeLessThan(56_000 + WINDOW + 2 * EVERY_MS);
	});

	it("is not fooled by the estimate's climb at the start of a share", () => {
		// Unconstrained, asking 48.7. The estimate starts near five and takes
		// thirty-six seconds to reach the ask, and through that time the
		// readings are, one by one, indistinguishable from a full line.
		const samples = fromRecording(RECORDED.ramp1440Noise ?? []);

		expect(samples.filter((sample) => classify(sample) === "strained").length).toBeGreaterThan(5);
		expect(replay(samples, { quality: "1440p", frameRate: 120 })).toEqual([]);
	});

	it("says nothing about a still screen, however starved its estimate", () => {
		// The trap the deleted follower fell into. A screen that is not changing
		// offers the encoder no frames, so it sends none, so the estimate never
		// climbs past five — every figure except the capture's says "struggling".
		const samples = fromRecording(RECORDED.static1440Capped ?? []);

		expect(samples.every((sample) => classify(sample) === "unknown")).toBe(true);
		expect(replay(samples, AT_1440_60)).toEqual([]);
	});

	it("says nothing about cheap content on an open line", () => {
		expect(replay(fromRecording(RECORDED.cheap1080Free ?? []), AT_1080_60)).toEqual([]);
	});

	it("says nothing when not even the lightest setting would fit", () => {
		// Held at 8 Mb/s, one or two frames a second at the top — plainly
		// struggling, and with nothing to offer: 1080p at fifteen alone has a
		// ceiling of 9.7, before the rest of the share.
		const samples = fromRecording(RECORDED.limitSimCheap ?? []);

		expect(samples.slice(-10).every((sample) => classify(sample) === "strained")).toBe(true);
		expect(replay(samples, AT_1080_60)).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* Readings made up to order                                                  */
/* -------------------------------------------------------------------------- */

interface Shape {
	source?: number;
	sent?: number;
	spent?: number;
	target?: number;
	ceiling?: number;
	asked?: number;
	available?: number;
	rest?: number;
	reason?: string;
	active?: boolean;
}

/*
 * What the rungs beneath the top take, as Chrome allots them.
 *
 * The ladder of 2026-10-14 — 720p at 2.5 Mb/s and thirty frames, and for a
 * share at sixty or more 1080p at sixty and 11.3 — measured in Chrome 145
 * through this application, a 1440p share at sixty with a full-size viewer:
 * the 720p rung's target 2.5, the 1080p rung's 8.5 (Chrome holds a lower layer
 * to three quarters of its ceiling while the top is on), and the two sending
 * 2.5 and 8.4. The friend's share below is at 120, which carries the same
 * rungs. The ladder of 2026-10-13 measured seven and a half here, and the one
 * before it three, its two ceilings added up.
 */
const RUNGS = 11 * M;

/*
 * The friend's share that prompted this: 1440p at 120 asking 48.7 Mb/s for the
 * top layer, on a home uplink that carried about 37.
 */
const STRAINED: Required<Shape> = {
	source: 118,
	sent: 64,
	spent: 29 * M,
	target: 29 * M,
	ceiling: 48_660_000,
	// The top's ceiling and both rungs': 48.66 + 2.5 + 11.31.
	asked: 62_473_708,
	available: 37 * M,
	rest: RUNGS,
	reason: "none",
	active: true,
};

const AT_1440_120: ShareSetting = { quality: "1440p", frameRate: 120 };

/** Readings every two seconds from `from` to `to`, each shaped by `shape(at)`. */
function readings(from: number, to: number, shape: (at: number) => Shape): Sample[] {
	const out: Sample[] = [];
	for (let at = from; at <= to; at += EVERY_MS) {
		out.push({ at, width: 2560, height: 1440, ...STRAINED, ...shape(at) });
	}
	return out;
}

describe("made up to order", () => {
	it("tells the friend what his line carries and what would fit it", () => {
		const said = replay(readings(2_000, 60_000, () => ({})), AT_1440_120);
		const hint = said[0]?.hint;

		expect(hint).toBeTruthy();
		expect(megabits(hint?.have ?? 0)).toBe("37");
		expect(megabits(hint?.need ?? 0)).toBe("62");
		// Four fifths of 37 is 29.6, less the rungs' eleven: 18.6 left for the
		// top. 1440p at thirty asked 24.3 and stopped fitting under the ladder
		// of 2026-10-13 (seven and a half for the rungs); 1080p at sixty asks
		// 19.4 and has stopped fitting under this one. 1440p at fifteen asks
		// 17.2 and is worth more than 1080p at thirty's 13.7. The rungs cost
		// the friend the frames: the ladder is the owner's, and so is the
		// trade.
		expect(hint?.to).toEqual({ quality: "1440p", frameRate: 15 });
		expect(askOf({ quality: "1080p", frameRate: 60 })).toBeGreaterThan(0.8 * 37 * M - RUNGS);
		expect(askOf({ quality: "1440p", frameRate: 15 })).toBeLessThanOrEqual(0.8 * 37 * M - RUNGS);
	});

	it("waits out a climb that outlasts the quiet time", () => {
		// A slow climb, still under the ask at the end of the quiet time and
		// still rising twenty seconds later. Every reading is strained, and the
		// line is used to the full all the way up — which is what a climb looks
		// like, measured: four fifths of the estimate and more going out on it.
		// Only the slope says otherwise.
		const climbing = (at: number) => {
			const available = (10 + (35 * at) / 56_000) * M;
			return { available, target: 0.7 * available, spent: 0.85 * available };
		};
		const samples = readings(2_000, 56_000, climbing);

		expect(samples.every((sample) => classify(sample) === "strained")).toBe(true);
		expect(samples.every((sample) => (sample.available ?? 0) < (sample.asked ?? 0))).toBe(true);
		expect(replay(samples, AT_1440_120)).toEqual([]);

		// And the same share, once the climb levels off below the ask, is told —
		// once the window holds more of the level than of the climb.
		const level = climbing(56_000);
		const said = replay([...samples, ...readings(58_000, 100_000, () => level)], AT_1440_120);

		expect(said).toHaveLength(1);
		expect(said[0]?.at).toBeGreaterThan(56_000);
	});

	it("takes a sawtooth for the ceiling it is, not a climb", () => {
		// A real full line is not flat: the estimate backs off and recovers
		// around what the line carries.
		const tooth = (at: number) => ({ available: (33 + ((at / EVERY_MS) % 4) * 2.5) * M });
		const said = replay(readings(2_000, 60_000, tooth), AT_1440_120);

		expect(said).toHaveLength(1);
	});

	it("says nothing about an estimate that stopped climbing because nothing was testing it", () => {
		// 1440p at sixty on a 60 Mb/s line. The encoder is starved on the way up
		// — allotted little, sending eight frames of sixty — and the estimate,
		// which libwebrtc holds to about one and a half times what gets through,
		// stands still at 20 from 36 to 52 seconds before it climbs on: the
		// shape of the stalls at 6.4 and 11.6 seen end to end, and long enough
		// to fill a window after the quiet time. Strained reading by reading,
		// flat across the window, short of the ask — and the line two thirds
		// used, which is not a line that is full.
		const stall = (at: number): Shape => {
			const available =
				at < 36_000 ? (5 + (15 * at) / 36_000) * M : at < 52_000 ? 20 * M : Math.min(60, 20 + (2 * (at - 52_000)) / 1000) * M;

			if (available >= 40 * M) return { available, sent: 60, target: 34.4 * M, spent: 30 * M };

			const out = available / 1.5;
			return { available, sent: 8, target: out - RUNGS, spent: out - RUNGS };
		};
		const samples = readings(2_000, 90_000, (at) => ({ source: 60, ceiling: 34_400_000, asked: 48_220_000, ...stall(at) }));

		expect(samples.filter((sample) => sample.at >= 36_000 && sample.at < 52_000).every((sample) => classify(sample) === "strained")).toBe(true);
		expect(replay(samples, AT_1440_60)).toEqual([]);
	});

	it("counts the camera and the voice where the browser counts the line", () => {
		// The friend's share with his camera on. The share's own layers take 29
		// of the 37, which on their own are not a full line; the line's count,
		// with the camera and the voice in it, says it is.
		const shared = readings(2_000, 60_000, () => ({ spent: 18 * M, target: 18 * M }));

		expect(replay(shared, AT_1440_120)).toEqual([]);
		expect(replay(shared.map((sample) => ({ ...sample, carried: 34 * M })), AT_1440_120)).toHaveLength(1);
	});

	it("says nothing while the encoder carries something other than the setting", () => {
		// A reconnect published the share again with its first options — 1440p
		// at 120, 48.7 at the top — under a menu that says 1440p at thirty. The
		// figures are about one setting and the card would be about the other.
		const samples = readings(2_000, 90_000, () => ({}));

		expect(replay(samples, { quality: "1440p", frameRate: 30 })).toEqual([]);
		expect(replay(samples, AT_1440_120)).toHaveLength(1);
	});

	it("says nothing about a still screen", () => {
		// Two frames a second captured and two sent, with every other figure
		// starved: the estimate cannot climb on a share that sends nothing.
		const said = replay(readings(2_000, 90_000, () => ({ source: 2, sent: 2, available: 4 * M, target: 2 * M, spent: 2 * M })), AT_1440_120);

		expect(said).toEqual([]);
	});

	it("says nothing when the machine is the limit", () => {
		const said = replay(readings(2_000, 90_000, () => ({ reason: "cpu" })), AT_1440_120);
		expect(said).toEqual([]);
	});

	it("says nothing about a ceiling too low for the content", () => {
		// Allotted its whole ceiling and still dropping frames: the content wants
		// more than the setting allows, and a smaller setting allows less. The
		// line is a little short of the whole ask, so nothing but the allotment
		// tells this apart from a full line.
		const said = replay(
			readings(2_000, 90_000, () => ({ ceiling: 34_400_000, asked: 48_220_000, target: 34_000_000, spent: 34_000_000, available: 47 * M })),
			AT_1440_60,
		);
		expect(said).toEqual([]);
	});

	it("says nothing about an allotment the encoder is not using", () => {
		// A short target that is not being spent is an estimate that never had
		// a reason to climb, not a line that is full.
		const said = replay(readings(2_000, 90_000, () => ({ spent: 12 * M })), AT_1440_120);
		expect(said).toEqual([]);
	});

	it("says nothing about a stutter that passed before twenty seconds of it", () => {
		const said = replay(
			readings(2_000, 90_000, (at) => (at > 40_000 && at <= 52_000 ? {} : { sent: 116 })),
			AT_1440_120,
		);
		expect(said).toEqual([]);
	});

	it("does not speak once the stutter has stopped, however recent it was", () => {
		// Strained until the very moment the window fills, and clear from then
		// on: nine in ten at that moment, and the one that matters is the last.
		const said = replay(
			readings(2_000, 90_000, (at) => (at >= QUIET_START + WINDOW ? { sent: 116 } : {})),
			AT_1440_120,
		);
		expect(said).toEqual([]);
	});

	it("wants four readings in five, not most of them", () => {
		// Seven in ten strained, steadily, for a minute and a half.
		const said = replay(
			readings(2_000, 90_000, (at) => ((at / EVERY_MS) % 10 < 3 ? { sent: 116 } : {})),
			AT_1440_120,
		);
		expect(said).toEqual([]);
	});

	it("does not count readings from before the share settled", () => {
		// Strained from the first second. A change of setting at 40 seconds
		// moves the start of counting to 55; the hint may come no earlier than
		// twenty seconds after that.
		const settled = 40_000 + QUIET_CHANGE;
		const said = replay(readings(2_000, 100_000, () => ({})), AT_1440_120, settled);

		expect(said).toHaveLength(1);
		expect(said[0]?.at).toBeGreaterThanOrEqual(settled + WINDOW - EVERY_MS);
	});

	it("does not reach a verdict across gaps in the readings", () => {
		// A tab the browser stopped running for a while: one reading in three.
		const sparse = readings(2_000, 120_000, () => ({})).filter((_, index) => index % 3 === 0);
		expect(replay(sparse, AT_1440_120)).toEqual([]);
	});

	it("does not tell somebody their line is short of what it carries", () => {
		// The share stutters and the allotment is short, but the line's own
		// estimate is above the ask — something else on the line is taking it,
		// and "this share needs more than your connection sends" would be false.
		const said = replay(readings(2_000, 90_000, () => ({ available: 60 * M })), AT_1440_120);
		expect(said).toEqual([]);
	});

	it("is not taken down by the screen going still", () => {
		const said = replay(
			readings(2_000, 140_000, (at) => (at > 60_000 ? { source: 1, sent: 1, spent: 0.2 * M } : {})),
			AT_1440_120,
		);

		expect(said.map((one) => one.hint === null)).toEqual([false]);
	});

	it("is taken down when the line recovers", () => {
		const said = replay(
			readings(2_000, 140_000, (at) => (at > 70_000 ? { sent: 118, target: 48_000_000, available: 80 * M } : {})),
			AT_1440_120,
		);

		expect(said.map((one) => one.hint === null)).toEqual([false, true]);
		expect(said[1]?.at).toBeGreaterThanOrEqual(70_000 + WINDOW * 0.8 - EVERY_MS);
	});
});

/* -------------------------------------------------------------------------- */
/* What the rungs give back                                                   */
/* -------------------------------------------------------------------------- */

/*
 * The 1080p rung beneath a share at sixty is 11.3 Mb/s at sixty frames, and
 * beneath anything slower 8 at thirty; retune moves it with the rate. So a
 * setting under sixty frames leaves the top more than the rungs take now — and
 * a hint that budgets every step against what the rungs take now offers fifteen
 * frames where thirty would fit. Found in review on 2026-10-14, on a 30 Mb/s
 * line under a 1440p share at sixty.
 *
 * What the rungs give back is measured, not priced: what the 1080p rung sent
 * above three quarters of 8 Mb/s, which is what Chrome allotted it at thirty
 * (6.0, against 8.5 at sixty). Each case below is made so that a different way
 * of getting this wrong changes what is offered.
 */
const AT_1440_60_ASKS = askOf({ quality: "1440p", frameRate: 60 });
const TWO_RUNGS = (SMALL.encoding.maxBitrate ?? 0) + (MIDDLE_FAST.encoding.maxBitrate ?? 0);

/** A 1440p share at sixty, top layer starved, with the two rungs sending `small` and `middle`. */
function underSixty(available: number, spent: number, small: number, middle: number): Sample[] {
	return readings(2_000, 60_000, () => ({
		source: 60,
		sent: 30,
		spent,
		target: spent,
		ceiling: AT_1440_60_ASKS,
		asked: AT_1440_60_ASKS + TWO_RUNGS,
		available,
		rest: small + middle,
	})).map((sample) => ({
		...sample,
		rungs: [
			{ ceiling: SMALL.encoding.maxBitrate, spent: small },
			{ ceiling: MIDDLE_FAST.encoding.maxBitrate, spent: middle },
		],
	}));
}

describe("what the rungs give back", () => {
	it("counts the megabits the 1080p rung gives back at thirty frames", () => {
		// 30 Mb/s: four fifths is 24, less the rungs' 10.9 leaves 13.1, and
		// 1080p at thirty asks 13.7. At thirty the 1080p rung is allotted 6.0
		// and gives back the 2.4 it sent above that: 15.5, which holds 1080p at
		// thirty and not 1440p at fifteen (17.2).
		const samples = underSixty(30 * M, 18 * M, 2.5 * M, 8.4 * M);

		expect(askOf({ quality: "1080p", frameRate: 30 })).toBeGreaterThan(0.8 * 30 * M - 10.9 * M);
		expect(askOf({ quality: "1080p", frameRate: 30 })).toBeLessThanOrEqual(0.8 * 30 * M - 10.9 * M + 2.4 * M);
		expect(replay(samples, AT_1440_60)[0]?.hint?.to).toEqual({ quality: "1080p", frameRate: 30 });

		// Read without the rungs one by one, the same line is offered half the
		// frames: what the hint said before this was counted.
		const blind = samples.map(({ rungs: _rungs, ...rest }) => rest);
		expect(replay(blind, AT_1440_60)[0]?.hint?.to).toEqual({ quality: "1080p", frameRate: 15 });
	});

	it("credits nothing for a rung already sending less than it would be allotted", () => {
		// Calm enough content that the 1080p rung sends 5.5 at sixty frames,
		// under the 6.0 it would be allotted at thirty: lowering its ceiling
		// takes nothing from it. 16 left for the top holds 1080p at thirty.
		// Crediting the difference in ceilings instead (three quarters of 3.3)
		// or everything the rung sent would make it 1440p at fifteen, 17.2, on a
		// line that does not have it.
		const said = replay(underSixty(30 * M, 18 * M, 2.5 * M, 5.5 * M), AT_1440_60);

		expect(askOf({ quality: "1440p", frameRate: 15 })).toBeGreaterThan(0.8 * 30 * M - 8 * M);
		expect(said[0]?.hint?.to).toEqual({ quality: "1080p", frameRate: 30 });
	});

	it("gives nothing back to a step that keeps sixty frames, nor for the 720p rung", () => {
		// 37 Mb/s, the rungs sending 10.5: 19.1 left, and 1080p at sixty asks
		// 19.4. At sixty the 1080p rung stays 11.3 and gives back nothing, and
		// the 720p rung is 2.5 under every setting. Credited either — the 2.0
		// the 1080p rung gives back at thirty, or the 0.6 by which the 720p
		// rung's 2.5 exceeds three quarters of itself — 1080p at sixty would
		// seem to fit and be offered over 1440p at fifteen.
		const said = replay(underSixty(37 * M, 24 * M, 2.5 * M, 8 * M), AT_1440_60);

		expect(askOf({ quality: "1080p", frameRate: 60 })).toBeGreaterThan(0.8 * 37 * M - 10.5 * M);
		expect(askOf({ quality: "1080p", frameRate: 60 })).toBeLessThanOrEqual(0.8 * 37 * M - 10.5 * M + 0.6 * M);
		expect(said[0]?.hint?.to).toEqual({ quality: "1440p", frameRate: 15 });
	});
});

/* -------------------------------------------------------------------------- */
/* What is offered                                                            */
/* -------------------------------------------------------------------------- */

const AREA: Record<string, number> = { "1080p": 1920 * 1080, "1440p": 2560 * 1440, "4k": 3840 * 2160, auto: 2560 * 1440 };
const RATE = (setting: ShareSetting) => (setting.quality === "auto" ? 60 : setting.frameRate);

describe("what is offered", () => {
	it("is never a larger picture or more frames than were chosen", () => {
		const chosen: ShareSetting[] = [
			{ quality: "4k", frameRate: 60 },
			{ quality: "4k", frameRate: 15 },
			{ quality: "1440p", frameRate: 120 },
			{ quality: "1080p", frameRate: 240 },
			{ quality: "1080p", frameRate: 30 },
			{ quality: "auto", frameRate: 240 },
		];

		for (const from of chosen) {
			for (let budget = 0; budget <= 100 * M; budget += 0.5 * M) {
				const to = suggest(from, budget, { width: 3840, height: 2160 });
				if (!to) continue;

				expect(AREA[to.quality]).toBeLessThanOrEqual(AREA[from.quality] ?? 0);
				expect(RATE(to)).toBeLessThanOrEqual(RATE(from));
				expect(to).not.toEqual(from);
				expect(askOf(to, { width: 3840, height: 2160 })).toBeLessThanOrEqual(budget);
			}
		}
	});

	it("is the most the line will hold", () => {
		// 26.6 left for the top: 1440p at thirty (24.3) over 1080p at sixty
		// (19.4) and 1440p at fifteen (17.2).
		expect(suggest(AT_1440_120, 26.6 * M, { width: 2560, height: 1440, frameRate: 118 })).toEqual({ quality: "1440p", frameRate: 30 });
		// 21: 1080p at sixty, the most that fits.
		expect(suggest(AT_1440_120, 21 * M, { width: 2560, height: 1440, frameRate: 118 })).toEqual({ quality: "1080p", frameRate: 60 });
	});

	it("is nothing at all when nothing fits", () => {
		expect(suggest(AT_1440_120, 9 * M, { width: 2560, height: 1440, frameRate: 118 })).toBeUndefined();
	});

	it("never offers a rate the display was not giving anyway", () => {
		// 120 chosen on a sixty-hertz display: the capture offers sixty, so
		// "1440p at sixty" would change the label and nothing that is sent.
		const to = suggest(AT_1440_120, 40 * M, { width: 2560, height: 1440, frameRate: 60 });

		expect(to).not.toEqual({ quality: "1440p", frameRate: 60 });
		expect(to).toEqual({ quality: "1440p", frameRate: 30 });
	});

	it("names the smaller picture when two would send the same one", () => {
		// A 1080p display shared on Automatic: 1440p and 1080p at fifteen both
		// capture 1920x1080 and cost the same, and "Switch to 1440p" reads as
		// asking for more to somebody whose screen has no more to give.
		const display = { width: 1920, height: 1080, frameRate: 60 };

		expect(suggest({ quality: "auto", frameRate: 60 }, 13 * M, display)).toEqual({ quality: "1080p", frameRate: 15 });
		expect(suggest(AT_1440_60, 17 * M, display)).toEqual({ quality: "1080p", frameRate: 30 });

		// Where the display has the larger picture to give, the larger name is
		// what would be sent, and it stays.
		expect(suggest(AT_1440_60, 18 * M, { width: 2560, height: 1440, frameRate: 60 })).toEqual({ quality: "1440p", frameRate: 15 });
	});

	it("lists the steps down largest first and fastest first", () => {
		const steps = stepsDown(AT_1440_120);

		expect(steps[0]).toEqual({ quality: "1440p", frameRate: 60 });
		expect(steps.at(-1)).toEqual({ quality: "1080p", frameRate: 15 });
		expect(steps.some((step) => step.quality === "4k")).toBe(false);
	});

	/*
	 * The price used to decide whether a setting fits has to be the price
	 * retune will actually set. They are one function now; this is what notices
	 * if somebody makes them two again.
	 */
	it("prices a setting the way retune applies it", async () => {
		for (const capture of [
			{ width: 2560, height: 1440, frameRate: 120 },
			{ width: 1920, height: 1080, frameRate: 60 },
			{ width: 1366, height: 768, frameRate: 60 },
		]) {
			for (const to of stepsDown({ quality: "4k", frameRate: 60 })) {
				const { room, encodings } = sharing(capture);
				await retune(room, to.frameRate, to.quality);

				expect(encodings[2]?.maxBitrate).toBe(askOf(to, capture));
			}
		}
	});
});

/* -------------------------------------------------------------------------- */
/* In a room                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A room with one share in it, whose sender reports whatever `shape` says.
 *
 * The capture's `getSettings` is the size the browser gives back, clamped to
 * what applyConstraints last asked for, the way a real display source answers.
 * `shape` is told the top layer's ceiling as it stands, so a share can stay
 * short of whatever it is changed to.
 */
function sharing(capture: { width: number; height: number; frameRate: number }, shape: (ceiling: number) => Shape = () => ({})) {
	const encodings: RTCRtpEncodingParameters[] = [
		{ rid: "q", active: true, maxBitrate: SMALL.encoding.maxBitrate, maxFramerate: 30 },
		{ rid: "h", active: true, maxBitrate: MIDDLE_FAST.encoding.maxBitrate, maxFramerate: 60 },
		{ rid: "f", active: true, maxBitrate: STRAINED.ceiling, maxFramerate: 120 },
	];

	let asked: { width: number; height: number } = { width: capture.width, height: capture.height };
	const totals = { frames: 0, top: { frames: 0, bytes: 0 }, rest: 0 };
	let last = performance.now();

	const sender = {
		getParameters: () => ({ encodings }),
		setParameters: vi.fn(async () => undefined),
		getStats: async () => {
			const now = performance.now();
			const seconds = (now - last) / 1000;
			last = now;

			const shaped = { ...STRAINED, ...shape(encodings[2]?.maxBitrate ?? 0) };
			totals.frames += shaped.source * seconds;
			totals.top.frames += shaped.sent * seconds;
			totals.top.bytes += (shaped.spent / 8) * seconds;
			totals.rest += (shaped.rest / 8) * seconds;

			return new Map<string, Entry>([
				["T", { type: "transport", id: "T", timestamp: now, selectedCandidatePairId: "P" }],
				["P", { type: "candidate-pair", id: "P", timestamp: now, availableOutgoingBitrate: shaped.available }],
				["S", { type: "media-source", id: "S", timestamp: now, kind: "video", frames: Math.round(totals.frames), width: capture.width, height: capture.height }],
				["Q", { type: "outbound-rtp", id: "Q", timestamp: now, rid: "q", kind: "video", bytesSent: Math.round(totals.rest), framesSent: 0, targetBitrate: SMALL.encoding.maxBitrate, qualityLimitationReason: shaped.reason, mediaSourceId: "S" }],
				["F", { type: "outbound-rtp", id: "F", timestamp: now, rid: "f", kind: "video", bytesSent: Math.round(totals.top.bytes), framesSent: Math.round(totals.top.frames), targetBitrate: shaped.target, qualityLimitationReason: shaped.reason }],
			]);
		},
	};

	const track = {
		sender,
		mediaStreamTrack: {
			contentHint: "",
			getSettings: () => ({ width: Math.min(capture.width, asked.width), height: Math.min(capture.height, asked.height), frameRate: capture.frameRate }),
			applyConstraints: async (constraints: { width: { max: number }; height: { max: number } }) => {
				asked = { width: constraints.width.max, height: constraints.height.max };
			},
		},
	};

	const publication = { trackSid: "TR_1", videoTrack: track };

	// Published from the start, as far as the hint is concerned: it reads the
	// share through getTrackPublication, and share() finds it there.
	const room = {
		localParticipant: {
			trackPublications: new Map(),
			createScreenTracks: async () => [{ kind: "video", ...track, stop: () => {} }],
			publishTrack: async () => publication,
			setScreenShareEnabled: async () => undefined,
			getTrackPublication: () => publication,
		},
	} as unknown as Room;

	return { room, encodings, sender, publication };
}

describe("the watch, in a room", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
		localStorage.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function pass(ms: number) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	}

	it("says nothing to somebody who is not sharing", async () => {
		const { room } = sharing({ width: 2560, height: 1440, frameRate: 120 });
		await share(room, true, 120, "1440p");

		const { result } = renderHook(() => useShareStrain(room, false));
		await pass(120_000);

		expect(result.current.hint).toBeUndefined();
	});

	it("speaks after the quiet time and the evidence, and changes nothing by itself", async () => {
		const { room, sender } = sharing({ width: 2560, height: 1440, frameRate: 120 });
		await share(room, true, 120, "1440p");
		sender.setParameters.mockClear();

		const { result } = renderHook(() => useShareStrain(room, true));

		await pass(QUIET_START + WINDOW - 4_000);
		expect(result.current.hint).toBeUndefined();

		await pass(8_000);
		expect(result.current.hint?.to).toEqual({ quality: "1440p", frameRate: 15 });

		// A hint: nothing about the share has been touched.
		expect(sender.setParameters).not.toHaveBeenCalled();
		expect(runningShare(room)).toMatchObject({ quality: "1440p", frameRate: 120 });
	});

	it("applies the setting offered, and only when asked", async () => {
		const { room, sender, encodings } = sharing({ width: 2560, height: 1440, frameRate: 120 });
		await share(room, true, 120, "1440p");

		const { result } = renderHook(() => useShareStrain(room, true));
		await pass(60_000);

		const offered = result.current.hint?.to;
		expect(offered).toBeTruthy();

		await act(async () => {
			await result.current.accept();
		});

		expect(sender.setParameters).toHaveBeenCalled();
		expect(encodings[2]?.maxBitrate).toBe(askOf(offered as ShareSetting, { width: 2560, height: 1440, frameRate: 120 }));
		expect(runningShare(room)).toMatchObject(offered as ShareSetting);
		expect(result.current.hint).toBeUndefined();
	});

	it("puts the question away for the rest of the share, and not for the next one", async () => {
		const { room, publication } = sharing({ width: 2560, height: 1440, frameRate: 120 });
		await share(room, true, 120, "1440p");

		const { result } = renderHook(() => useShareStrain(room, true));
		await pass(60_000);
		expect(result.current.hint).toBeTruthy();

		act(() => result.current.decline());
		expect(result.current.hint).toBeUndefined();

		// The line is just as bad for the next five minutes of this share.
		await pass(300_000);
		expect(result.current.hint).toBeUndefined();

		// A new share is a new question, with its own quiet time first.
		publication.trackSid = "TR_2";
		await share(room, true, 120, "1440p");

		await pass(QUIET_START);
		expect(result.current.hint).toBeUndefined();

		await pass(WINDOW + 4_000);
		expect(result.current.hint).toBeTruthy();
	});

	/*
	 * A full reconnect, as the SDK does it: every local track unpublished and
	 * published again (republishAllTracks), the same capture under a new sid,
	 * and share() never called. The picture leaves the room and comes back, so
	 * `sharing` goes false and true again in between.
	 */
	it("keeps \"Not now\" through a reconnect, which is the same share published again", async () => {
		const { room, publication } = sharing({ width: 2560, height: 1440, frameRate: 120 });
		await share(room, true, 120, "1440p");

		const { result, rerender } = renderHook(({ on }) => useShareStrain(room, on), { initialProps: { on: true } });
		await pass(60_000);
		expect(result.current.hint).toBeTruthy();

		act(() => result.current.decline());

		rerender({ on: false });
		publication.trackSid = "TR_after_reconnect";
		await pass(EVERY_MS);
		rerender({ on: true });

		// The line is as bad as it was, for five minutes more of the same share.
		await pass(300_000);
		expect(result.current.hint).toBeUndefined();
	});

	it("owes a share published again the quiet time a new share is owed", async () => {
		// The new connection's estimate starts from nothing and climbs, exactly
		// as a new share's does; fifteen seconds, or none, would read its climb
		// as a full line.
		const { room, publication } = sharing({ width: 2560, height: 1440, frameRate: 120 });
		await share(room, true, 120, "1440p");

		const { result } = renderHook(() => useShareStrain(room, true));
		await pass(60_000);
		expect(result.current.hint).toBeTruthy();

		publication.trackSid = "TR_after_reconnect";
		await pass(EVERY_MS);

		// Down, because it was about a connection that is gone.
		expect(result.current.hint).toBeUndefined();

		await pass(QUIET_START + WINDOW - 4_000);
		expect(result.current.hint).toBeUndefined();

		await pass(8_000);
		expect(result.current.hint).toBeTruthy();
	});

	it("takes the card down the moment the menu changes the share, and a press then does nothing", async () => {
		const { room, sender } = sharing({ width: 2560, height: 1440, frameRate: 120 });
		await share(room, true, 120, "1440p");

		const { result } = renderHook(() => useShareStrain(room, true));
		await pass(60_000);
		expect(result.current.hint?.to).toEqual({ quality: "1440p", frameRate: 15 });

		// The press as the card had it, worked out for 1440p at 120.
		const press = result.current.accept;

		// Somebody picks 1080p at fifteen from the menu instead. No time passes:
		// the card goes with the change, not at the next reading.
		await act(async () => {
			await retune(room, 15, "1080p");
		});
		expect(result.current.hint).toBeUndefined();

		// And the press that was already on its way changes nothing — least of
		// all upward, to 1440p, over the 1080p just chosen.
		sender.setParameters.mockClear();
		await act(async () => {
			await press();
		});

		expect(sender.setParameters).not.toHaveBeenCalled();
		expect(runningShare(room)).toMatchObject({ quality: "1080p", frameRate: 15 });
	});

	it("starts again from nothing when the setting is changed from the menu", async () => {
		// Short of whatever ceiling it has, and sending as much as the line
		// takes whatever the ceiling, so the line is just as full after the
		// change as before it.
		const { room } = sharing({ width: 2560, height: 1440, frameRate: 120 }, (ceiling) => ({
			target: 0.6 * ceiling,
			spent: 30 * M,
		}));
		await share(room, true, 120, "1440p");

		const { result } = renderHook(() => useShareStrain(room, true));
		await pass(60_000);
		expect(result.current.hint).toBeTruthy();

		// The menu, not the card: what the card said was about a setting no
		// longer being sent.
		await act(async () => {
			await retune(room, 60, "1440p");
		});
		await pass(EVERY_MS);
		expect(result.current.hint).toBeUndefined();

		// Fifteen seconds of quiet and twenty of evidence, about the new setting.
		await pass(QUIET_CHANGE + WINDOW - 4_000);
		expect(result.current.hint).toBeUndefined();

		await pass(8_000);
		expect(result.current.hint?.to).toEqual({ quality: "1440p", frameRate: 15 });
	});

	it("writes nothing down", async () => {
		const { room } = sharing({ width: 2560, height: 1440, frameRate: 120 });
		await share(room, true, 120, "1440p");

		const stored = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));

		const before = stored();
		const { result } = renderHook(() => useShareStrain(room, true));
		await pass(60_000);
		expect(result.current.hint).toBeTruthy();

		act(() => result.current.decline());
		await pass(60_000);

		expect(stored()).toEqual(before);
	});
});
