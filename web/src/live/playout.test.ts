import { expect, it } from "vitest";
import { Playout } from "./playout";

/*
 * The playout buffer.
 *
 * What it must never do is put out a frame that did not arrive, or put one out
 * twice, or out of order: any of those is the loss this path exists to avoid,
 * done locally. So the frames are numbered and the output is checked to be the
 * numbers in order -- across block boundaries the sound card's 128-frame
 * requests do not line up with, across a stall, and across a skip. What it may
 * do, and must say it did, is wait and drop.
 */

/** A block whose samples are their own frame numbers, scaled into range. */
function numbered(from: number, frames: number, channels = 2): Float32Array[] {
	return Array.from({ length: channels }, (_, c) =>
		Float32Array.from({ length: frames }, (_, i) => (from + i) / 1e6 + (c ? 0.5 : 0)),
	);
}

function pull(playout: Playout, frames = 128): Float32Array[] {
	const out = [new Float32Array(frames), new Float32Array(frames)];
	playout.pull(out);
	return out;
}

const frameOf = (sample: number) => Math.round(sample * 1e6);

it("waits for its target, then plays every frame in order", () => {
	const playout = new Playout(2, 1920, 48_000);

	playout.push(numbered(0, 960));
	expect(Array.from(pull(playout)[0] as Float32Array).every((s) => s === 0)).toBe(true);

	playout.push(numbered(960, 960));
	playout.push(numbered(1920, 960));

	const heard: number[] = [];
	for (let i = 0; i < 20; i++) {
		const [left, right] = pull(playout);
		for (let j = 0; j < 128; j++) {
			heard.push(frameOf(left?.[j] as number));
			// The channels stay together, and each is its own.
			expect(right?.[j]).toBeCloseTo((left?.[j] as number) + 0.5, 6);
		}
	}

	expect(heard).toEqual(Array.from({ length: 2560 }, (_, i) => i));
	expect(playout.counts()).toMatchObject({ underruns: 0, skipped: 0, played: 2560 });
});

it("goes quiet when it runs dry, says so, and waits for its target again", () => {
	const playout = new Playout(2, 960, 48_000);
	playout.push(numbered(0, 960));

	for (let i = 0; i < 7; i++) pull(playout);
	const last = pull(playout);
	// 7 * 128 = 896 played, 64 left: the rest of this request is silence.
	expect(frameOf(last[0]?.[63] as number)).toBe(959);
	expect(last[0]?.[64]).toBe(0);
	expect(playout.counts()).toMatchObject({ underruns: 1, playing: false });

	playout.push(numbered(960, 480));
	expect(Array.from(pull(playout)[0] as Float32Array).every((s) => s === 0)).toBe(true);

	playout.push(numbered(1440, 480));
	expect(frameOf(pull(playout)[0]?.[0] as number)).toBe(960);
});

it("drops whole blocks from the front past its ceiling, back to its target, and counts them", () => {
	const playout = new Playout(2, 1920, 4800);
	for (let block = 0; block < 6; block++) playout.push(numbered(block * 960, 960));

	// 5760 held is past 4800: blocks go from the front until 1920 remain.
	expect(playout.counts()).toMatchObject({ held: 1920, skipped: 3840 });
	expect(frameOf(pull(playout)[0]?.[0] as number)).toBe(3840);
});

it("plays a mono stream out of both speakers", () => {
	const playout = new Playout(1, 128, 48_000);
	playout.push(numbered(0, 128, 1));

	const [left, right] = pull(playout);
	expect(Array.from(left as Float32Array)).toEqual(Array.from(right as Float32Array));
	expect(frameOf(left?.[127] as number)).toBe(127);
});
