import { describe, expect, it } from "vitest";
import { arrange } from "./layout";

// The height a laptop actually leaves for the stage, once the control bar has
// taken its share. Tested at the real number because the choice between two
// arrangements can turn on a few dozen pixels.
const LAPTOP = { width: 1200, height: 730 };
const PHONE = { width: 390, height: 760 };
const ULTRAWIDE = { width: 2400, height: 800 };

/** Shorthand for asserting the shape of an arrangement. */
function shape(container: { width: number; height: number }, count: number): string {
	const found = arrange(container, count);
	return found ? `${found.columns}x${found.rows}` : "none";
}

describe("arrange", () => {
	it("has nothing to say about an empty or unmeasured container", () => {
		expect(arrange(LAPTOP, 0)).toBeUndefined();
		expect(arrange({ width: 0, height: 0 }, 4)).toBeUndefined();
	});

	// The whole point: a picture keeps its shape rather than being stretched to
	// whatever a cell happens to be.
	it("keeps every tile at sixteen by nine", () => {
		for (let count = 1; count <= 9; count++) {
			const found = arrange(LAPTOP, count);
			if (!found) throw new Error("no arrangement");

			expect(found.width / found.height).toBeCloseTo(16 / 9, 1);
		}
	});

	it("fits inside the container it was given", () => {
		for (let count = 1; count <= 9; count++) {
			const found = arrange(LAPTOP, count);
			if (!found) throw new Error("no arrangement");

			expect(found.columns * found.width).toBeLessThanOrEqual(LAPTOP.width);
			expect(found.rows * found.height).toBeLessThanOrEqual(LAPTOP.height);
		}
	});

	// One person should be a picture in a room, not a wall.
	it("leaves a lone participant some room", () => {
		const found = arrange(LAPTOP, 1);
		if (!found) throw new Error("no arrangement");

		expect(found.height).toBeLessThan(LAPTOP.height);
	});

	it("arranges a wide screen the way people expect", () => {
		expect(shape(LAPTOP, 1)).toBe("1x1");
		expect(shape(LAPTOP, 2)).toBe("2x1");
		expect(shape(LAPTOP, 4)).toBe("2x2");
		expect(shape(LAPTOP, 6)).toBe("3x2");
		expect(shape(LAPTOP, 9)).toBe("3x3");
	});

	// Two people side by side is what every meeting application does, and the
	// arrangement that wins it is close enough to the alternative that a control
	// bar's worth of height used to decide it. Pinned at several heights so a
	// change to the algorithm cannot quietly flip it back.
	it("keeps two people side by side across the heights a window has", () => {
		for (const height of [600, 650, 700, 730]) {
			expect(shape({ width: 1200, height }, 2), `${height}`).toBe("2x1");
		}
	});

	// The arrangement follows the container, which a fixed column count cannot
	// do: two people on a phone belong one above the other.
	it("stacks on a tall screen", () => {
		expect(shape(PHONE, 2)).toBe("1x2");
		expect(shape(PHONE, 3)).toBe("1x3");
	});

	it("spreads out on a wide one", () => {
		expect(shape(ULTRAWIDE, 3)).toBe("3x1");
	});

	// Four people over six cells wastes two of them at no gain, which is what
	// the occupancy term exists to prevent.
	it("does not spread people over cells it will leave empty", () => {
		for (const container of [LAPTOP, ULTRAWIDE, { width: 1600, height: 900 }]) {
			const found = arrange(container, 4);
			if (!found) throw new Error("no arrangement");

			expect(found.columns * found.rows, `${container.width}x${container.height}`).toBe(4);
		}
	});

	// A layout that changes shape as the window is dragged is worse than one
	// that is slightly suboptimal, so the choice should hold over a range.
	it("holds its shape while a window is resized", () => {
		const shapes = new Set([600, 800, 1000, 1200, 1400, 1600].map((width) => shape({ width, height: 700 }, 4)));
		expect(shapes).toEqual(new Set(["2x2"]));
	});

	it("grows the tiles when there is more room", () => {
		const small = arrange({ width: 800, height: 600 }, 4);
		const large = arrange({ width: 1600, height: 900 }, 4);
		if (!small || !large) throw new Error("no arrangement");

		expect(large.width).toBeGreaterThan(small.width);
	});
});
