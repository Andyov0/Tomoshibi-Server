import { describe, expect, it } from "vitest";
import { type Placed, aside, landing } from "./useReorder";

/*
 * What these guard is a drag that lands one place out.
 *
 * Nothing about an off-by-one here throws, logs, or fails a type check. The row
 * arrives somewhere plausible, the list saves happily, and the only witness is
 * whoever dragged a relay to the top and got second — on a page where the order
 * decides which machine calls are offered first, so the mistake is not cosmetic
 * and is discovered by somebody wondering why the wrong relay is busy.
 *
 * The arithmetic is separated from the pointer for exactly this reason. Driving
 * a real drag would test the browser's event delivery, which works; what does
 * not work by itself is deciding where a half-covered row belongs.
 */

/** A list of rows of the given heights, laid out one after another. */
function laid(heights: number[], gap: number): Placed[] {
	const rows: Placed[] = [];
	let top = 0;

	for (const height of heights) {
		rows.push({ top, height });
		top += height + gap;
	}

	return rows;
}

describe("landing", () => {
	const rows = laid([60, 60, 60, 60], 16);

	it("keeps a row where it is until it is dragged anywhere", () => {
		expect(landing(rows, 2, 0, 16)).toBe(2);
	});

	it("stays put for a nudge that does not clear the row below", () => {
		expect(landing(rows, 0, 20, 16)).toBe(0);
	});

	it("takes the next place once the row is nearer it than its own", () => {
		expect(landing(rows, 0, 60, 16)).toBe(1);
	});

	it("goes as far up as it is carried", () => {
		expect(landing(rows, 3, -228, 16)).toBe(0);
	});

	it("goes no further than the ends of the list", () => {
		expect(landing(rows, 0, -400, 16)).toBe(0);
		expect(landing(rows, 3, 400, 16)).toBe(3);
	});

	/*
	 * The one that fails on the obvious implementation.
	 *
	 * Comparing the carried row against the midpoints of the rows it passes
	 * works while every row is the same height and breaks as soon as one is not:
	 * a relay with its settings open is three times the height of the rest, and
	 * a short row dragged over it would have had to travel most of the tall
	 * row's height before anything moved. What decides it is where the carried
	 * row would sit, which is a question about the gap it is being held over.
	 */
	it("does not make a short row cross the whole of a tall one", () => {
		const uneven = laid([40, 200, 40], 16);

		// Past the point where it would sit below the tall row, and nowhere near
		// that row's own middle, which is another 100 pixels down.
		expect(landing(uneven, 0, 120, 16)).toBe(1);
	});
});

describe("aside", () => {
	const rows = laid([60, 60, 60, 60], 16);
	const span = 76;

	it("moves nothing while the row is over its own place", () => {
		for (let index = 0; index < rows.length; index++) {
			expect(aside(rows, 1, 1, 16, index)).toBe(0);
		}
	});

	it("leaves the carried row to the pointer", () => {
		expect(aside(rows, 3, 0, 16, 3)).toBe(0);
	});

	it("sends the rows a carried one has passed downwards", () => {
		// The last row taken to the top: everything above it comes down one
		// place, and nothing has to move twice.
		expect(aside(rows, 3, 0, 16, 0)).toBe(span);
		expect(aside(rows, 3, 0, 16, 1)).toBe(span);
		expect(aside(rows, 3, 0, 16, 2)).toBe(span);
	});

	it("sends them upwards when the row is carried the other way", () => {
		expect(aside(rows, 0, 2, 16, 1)).toBe(-span);
		expect(aside(rows, 0, 2, 16, 2)).toBe(-span);
		expect(aside(rows, 0, 2, 16, 3)).toBe(0);
	});

	it("leaves the rows outside the journey alone", () => {
		expect(aside(rows, 3, 2, 16, 0)).toBe(0);
		expect(aside(rows, 3, 2, 16, 1)).toBe(0);
		expect(aside(rows, 3, 2, 16, 2)).toBe(span);
	});
});
