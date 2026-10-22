import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Point } from "./api";
import { Trend, series } from "./Trend";

/*
 * What these guard is a chart that draws and lies.
 *
 * The plot's vertical scale is fixed to what the link is thought to carry,
 * which is the whole reason it is worth looking at: a chart that rescales to
 * its own maximum looks the same on a quiet Sunday as on the evening it ran
 * out. The cost of that decision is that any arithmetic error in what is fed to
 * it is invisible — bytes where bits belong sit at an eighth of their height
 * and read as a quiet evening, and the peak band drawn from the mean simply is
 * not there, which looks exactly like a server that never bursts.
 *
 * None of it can be seen from here: uPlot draws to a canvas and there is none
 * in a test environment. So what the plot is handed is checked instead.
 */

function bucket(at: string, out: number, peak: number): Point {
	return {
		at,
		in: out / 4,
		out,
		inPeak: peak / 4,
		outPeak: peak,
		rooms: 1,
		clients: 2,
		nack: 0,
		nackPeak: 0,
		n: 6,
	};
}

describe("what the plot is handed", () => {
	it("draws the band from the peak and the line from the mean", () => {
		const [, peak, out] = series([
			bucket("2026-08-19T10:00:00Z", 1000, 8000),
			bucket("2026-08-19T11:00:00Z", 2000, 2000),
		]);

		// Bits, because the scale it is drawn against is a gigabit.
		expect(Array.from(out ?? [])).toEqual([8000, 16_000]);
		expect(Array.from(peak ?? [])).toEqual([64_000, 16_000]);
	});

	it("puts the buckets on the clock in seconds", () => {
		const [at] = series([bucket("2026-08-19T10:00:00Z", 1000, 1000)]);

		expect(Array.from(at ?? [])).toEqual([Date.parse("2026-08-19T10:00:00Z") / 1000]);
	});

	// An empty range is a young deployment asked about six months, not a fault.
	it("survives a range with nothing in it", () => {
		expect(series([]).every((row) => row.length === 0)).toBe(true);
	});
});

/*
 * And the component, which has no canvas to draw on.
 *
 * It used to throw one exception per render here, four per run, which is the
 * state in which nobody reads a failure. It checks for a drawing context and
 * draws nothing rather than throwing, and this is what says so.
 */
it("draws without a canvas rather than throwing", () => {
	expect(() => render(<Trend points={[bucket("2026-08-19T10:00:00Z", 1, 2)]} />)).not.toThrow();
	expect(() => render(<Trend points={[]} />)).not.toThrow();
});
