import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Point } from "./api";
import { INK, Trend, rateAxisWidth, series } from "./Trend";

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

/*
 * The canvas cannot read the stylesheet, so the chart's colours are written
 * out twice, and the copy fell behind once: the day's muted text was raised
 * to three quarters in index.css and stayed at three fifths here, which left
 * the axis and the incoming line at three and a third to one on white.
 */
it("draws its quiet ink by day in the stylesheet's own muted", () => {
	const css = readFileSync(join(import.meta.dirname, "..", "index.css"), "utf8");
	const day = /prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-appearance="night"\]\)\s*\{([\s\S]*?)\n\t\t\}/.exec(css)?.[1] ?? "";
	const muted = /--color-fg-muted:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(day);

	expect(muted, "no day muted in index.css").toBeTruthy();
	expect(INK.day.text).toBe(`rgba(${muted?.[1]}, ${muted?.[2]}, ${muted?.[3]}, ${muted?.[4]})`);
});

/*
 * The rate axis was forty-six pixels wide whatever it said, and the link's
 * own scale, a gigabit, is labelled "500.0 Mbps" and "1.00 Gbps": both were
 * drawn with their first characters outside the canvas. A monospace face is
 * about six-tenths of an em, so at ten pixels a label needs six pixels a
 * character and the axis its gap beside them.
 */
it("leaves the rate axis room for the longest label on it", () => {
	const labels = ["", "500.0 Mbps", "1.00 Gbps"];

	expect(rateAxisWidth(labels)).toBeGreaterThanOrEqual(10 * 6 + 5);
	expect(rateAxisWidth(["", "10.00 Gbps", "20.00 Gbps"])).toBeGreaterThanOrEqual(10 * 6 + 5);
	// And no narrower than it was before uPlot has said what it will draw.
	expect(rateAxisWidth(null)).toBe(46);
	expect(rateAxisWidth(["", "5 bps"])).toBe(46);
});
