import { describe, expect, it } from "vitest";
import {
	GAP,
	ISLAND,
	ISLAND_HEIGHT,
	ISLAND_OFFSET,
	clearOf,
	planClose,
	planFocus,
	planGrid,
	stripCapacity,
} from "./plan";

const WINDOW = { width: 1600, height: 900 };

/** Everything the plan places, as one list, for checking against each other. */
function spots(plan: ReturnType<typeof planGrid>) {
	return [...plan.values()];
}

/** Do these two overlap by more than a rounding difference? */
function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
	const tolerance = 0.5;
	return (
		a.x + a.width - tolerance > b.x &&
		b.x + b.width - tolerance > a.x &&
		a.y + a.height - tolerance > b.y &&
		b.y + b.height - tolerance > a.y
	);
}

function ids(count: number) {
	return Array.from({ length: count }, (_, i) => `p${i}`);
}

describe("planGrid", () => {
	it("places everybody, once", () => {
		for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
			const plan = planGrid(WINDOW, ids(count));
			expect(plan.size).toBe(count);
		}
	});

	it("never lets two pictures overlap", () => {
		for (const count of [2, 3, 4, 5, 6, 7, 8, 9]) {
			const placed = spots(planGrid(WINDOW, ids(count)));

			for (let i = 0; i < placed.length; i++) {
				for (let j = i + 1; j < placed.length; j++) {
					expect(overlaps(placed[i]!, placed[j]!)).toBe(false);
				}
			}
		}
	});

	it("keeps clear of the controls", () => {
		for (const count of [1, 2, 4, 6, 9]) {
			for (const spot of spots(planGrid(WINDOW, ids(count)))) {
				expect(spot.y + spot.height).toBeLessThanOrEqual(WINDOW.height - ISLAND / 2);
			}
		}
	});

	it("stays inside the window", () => {
		for (const count of [1, 3, 5, 8]) {
			for (const spot of spots(planGrid(WINDOW, ids(count)))) {
				expect(spot.x).toBeGreaterThanOrEqual(0);
				expect(spot.y).toBeGreaterThanOrEqual(0);
				expect(spot.x + spot.width).toBeLessThanOrEqual(WINDOW.width);
			}
		}
	});

	it("gives everybody the same size", () => {
		const placed = spots(planGrid(WINDOW, ids(7)));

		for (const spot of placed) {
			expect(spot.width).toBeCloseTo(placed[0]!.width, 5);
			expect(spot.height).toBeCloseTo(placed[0]!.height, 5);
		}
	});

	/*
	 * Only the last row is ever short. Aligned to the left it leaves its gap at
	 * one end, which reads as a mistake rather than as a room with somebody
	 * missing from it.
	 */
	it("centres a short last row", () => {
		// Five in a three-wide arrangement leaves two on the second row.
		const plan = planGrid({ width: 1200, height: 800 }, ids(5));
		const placed = [...plan.entries()].map(([, spot]) => spot);

		const rows = new Map<number, typeof placed>();
		for (const spot of placed) {
			const row = rows.get(Math.round(spot.y)) ?? [];
			row.push(spot);
			rows.set(Math.round(spot.y), row);
		}

		for (const row of rows.values()) {
			const left = Math.min(...row.map((s) => s.x));
			const right = Math.max(...row.map((s) => s.x + s.width));
			expect(left).toBeCloseTo(1200 - right, 5);
		}
	});

	it("plans nothing for an unmeasured container", () => {
		expect(planGrid({ width: 0, height: 0 }, ids(4)).size).toBe(0);
		expect(planGrid(WINDOW, []).size).toBe(0);
	});
});

describe("planFocus", () => {
	it("puts the stage above the strip, and both clear of the controls", () => {
		const plan = planFocus(WINDOW, "stage", ids(3));

		const stage = plan.get("stage");
		if (!stage) throw new Error("the stage was not placed");

		const strip = ids(3).map((id) => plan.get(id));
		for (const spot of strip) {
			if (!spot) throw new Error("somebody in the strip was not placed");
			expect(spot.y).toBeGreaterThanOrEqual(stage.y + stage.height);
			expect(spot.y + spot.height).toBeLessThanOrEqual(WINDOW.height - ISLAND + 0.5);
		}
	});

	it("gives the stage the whole height when nobody else is here", () => {
		const alone = planFocus(WINDOW, "stage", []);
		const crowded = planFocus(WINDOW, "stage", ids(3));

		expect(alone.get("stage")?.height).toBeGreaterThan(crowded.get("stage")!.height);
		expect(alone.size).toBe(1);
	});

	/*
	 * Fullscreen is the one place where nothing is reserved. The controls have
	 * stepped aside on their own, so leaving room for them would be a band of
	 * black somebody asked to be rid of.
	 */
	it("fills the screen exactly when asked to", () => {
		const plan = planFocus(WINDOW, "stage", ids(3), { fullscreen: true });

		expect(plan.size).toBe(1);
		expect(plan.get("stage")).toEqual({ x: 0, y: 0, ...WINDOW });
	});

	it("centres the strip", () => {
		const plan = planFocus(WINDOW, "stage", ids(2));
		const strip = ids(2).map((id) => plan.get(id)!);

		const left = Math.min(...strip.map((s) => s.x));
		const right = Math.max(...strip.map((s) => s.x + s.width));
		expect(left).toBeCloseTo(WINDOW.width - right, 5);
	});

	it("plans nothing for an unmeasured container", () => {
		expect(planFocus({ width: 0, height: 0 }, "stage", ids(2)).size).toBe(0);
	});
});

/*
 * Something drawn over the foot of the room that must not cover the filmstrip.
 *
 * The card saying a share is more than the line carries sat just clear of the
 * controls, which is where the strip begins: at every width it covered the
 * strip whole and a press on anybody in it landed on the card. Measured in the
 * browser at 320, 375, 414 and 1280; held here as the arithmetic it rests on.
 */
describe("clearOf", () => {
	const sizes = [
		{ width: 320, height: 640 },
		{ width: 375, height: 812 },
		{ width: 414, height: 896 },
		{ width: 1280, height: 800 },
	];

	it("ends whatever sits above it short of every picture in the strip", () => {
		for (const size of sizes) {
			const strip = ids(Math.min(3, stripCapacity(size)));
			const plan = planFocus(size, "stage", strip);
			const bottom = clearOf(plan, strip, size);
			if (bottom === undefined) throw new Error("a strip that is there was said not to be");

			for (const id of strip) {
				const spot = plan.get(id);
				if (!spot) throw new Error("somebody in the strip was not placed");

				// The lower edge of anything lifted by this, measured from the top.
				expect(size.height - bottom, `${size.width} wide`).toBeLessThanOrEqual(spot.y - GAP + 0.5);
			}

			// And so above the controls as well, which the strip is above.
			expect(bottom).toBeGreaterThan(ISLAND);
		}
	});

	it("is nothing where there is no strip to clear", () => {
		const size = { width: 375, height: 812 };

		expect(clearOf(planFocus(size, "stage", []), [], size)).toBeUndefined();
		expect(clearOf(planFocus(size, "stage", ids(2), { fullscreen: true }), ids(2), size)).toBeUndefined();
	});
});

describe("stripCapacity", () => {
	it("fits what the width allows", () => {
		// Both landscape, or this compares two different tile shapes rather
		// than two widths.
		expect(stripCapacity({ width: 1600, height: 900 })).toBeGreaterThan(
			stripCapacity({ width: 900, height: 600 }),
		);
	});

	it("holds somebody even when there is no room", () => {
		// A strip that held nobody would page for ever without showing anything.
		expect(stripCapacity({ width: 10, height: 900 })).toBe(1);
	});

	it("agrees with what it plans", () => {
		const width = 900;
		const capacity = stripCapacity({ width, height: 900 });
		const plan = planFocus({ width, height: 900 }, "stage", ids(capacity));

		for (const id of ids(capacity)) {
			const spot = plan.get(id);
			if (!spot) throw new Error(`${id} was not placed`);
			expect(spot.x).toBeGreaterThanOrEqual(GAP - 0.5);
			expect(spot.x + spot.width).toBeLessThanOrEqual(width - GAP + 0.5);
		}
	});
});

/*
 * Upright.
 *
 * Held in a hand the layout was answering a question it had not been written
 * for: one other person took twenty-eight per cent of the screen and the face
 * inside that band was cropped from a camera filming the other way round. What
 * follows fixes the two figures that showed it.
 */

const PHONE = { width: 393, height: 852 };

/** The share of usable height the pictures actually occupy. */
function occupancy(plan: ReturnType<typeof planGrid>, container: typeof PHONE) {
	const used = [...plan.values()].reduce((total, spot) => total + spot.width * spot.height, 0);
	return used / (container.width * (container.height - ISLAND));
}

describe("planGrid, upright", () => {
	it("fills a phone rather than banding it", () => {
		// Measured at 0.28 before this: a letterbox in an empty screen. The
		// bar is set from what upright tiles can actually reach on this screen
		// rather than from a round number — three of them cannot pass about a
		// half, and asking for more would only be asking for a squarer tile
		// than a phone films in.
		for (const count of [3, 4, 6]) {
			const share = occupancy(planGrid(PHONE, ids(count)), PHONE);
			expect(share, `${count} people`).toBeGreaterThan(0.45);
		}
	});

	it("gives upright pictures an upright shape", () => {
		const spot = [...planGrid(PHONE, ids(4)).values()][0];
		if (!spot) throw new Error("nobody was placed");

		// Taller than wide, because that is the shape a phone films in. A
		// sixteen-by-nine tile here crops a standing person to their eyes.
		expect(spot.height).toBeGreaterThan(spot.width);
	});

	it("keeps landscape shapes on a landscape screen", () => {
		const spot = [...planGrid({ width: 1440, height: 900 }, ids(4)).values()][0];
		if (!spot) throw new Error("nobody was placed");

		expect(spot.width).toBeGreaterThan(spot.height);
	});

	it("still lets nobody overlap", () => {
		for (const count of [2, 3, 4, 5, 6, 9]) {
			const placed = [...planGrid(PHONE, ids(count)).values()];
			for (let i = 0; i < placed.length; i++) {
				for (let j = i + 1; j < placed.length; j++) {
					expect(overlaps(placed[i]!, placed[j]!), `${count} people`).toBe(false);
				}
			}
		}
	});
});

describe("planClose", () => {
	it("gives the whole screen to the one being looked at", () => {
		const plan = planClose(PHONE, "them", ["me"]);
		const them = plan.get("them");

		expect(them).toEqual({ x: 0, y: 0, ...PHONE });
	});

	it("puts the other one in a corner, clear of the controls", () => {
		const plan = planClose(PHONE, "them", ["me"]);
		const me = plan.get("me");
		if (!me) throw new Error("the card was not placed");

		expect(me.x + me.width).toBeLessThanOrEqual(PHONE.width);
		expect(me.y + me.height).toBeLessThanOrEqual(PHONE.height - ISLAND);
		// Small enough to be a card rather than a second picture.
		expect(me.width).toBeLessThan(PHONE.width / 2);
	});

	it("drops a card that would not fit rather than stacking it under the controls", () => {
		const many = Array.from({ length: 12 }, (_, i) => `c${i}`);
		const plan = planClose(PHONE, "them", many);

		for (const id of many) {
			const spot = plan.get(id);
			if (!spot) continue;
			expect(spot.y + spot.height).toBeLessThanOrEqual(PHONE.height - ISLAND);
		}
	});

	it("plans nothing for an unmeasured container", () => {
		expect(planClose({ width: 0, height: 0 }, "them", ["me"]).size).toBe(0);
	});
});

/*
 * The controls are an island floating over the foot of the room, and nothing
 * the plan places may end underneath it: a picture there is a picture whose
 * name, and whose lower edge, press the controls instead.
 *
 * The reserve was a constant of 68 written when the island was forty pixels tall,
 * and the island grew to 58 and was lifted clear of the home indicator: the
 * filmstrip's last ten pixels sat under it on a laptop, and thirty-two on an
 * iPhone, where each picture's name is drawn. The room now measures the island
 * where it is drawn (hooks/useIslandReserve.ts) and passes what it found; these
 * hold the plan to it, and the figure for nothing measured to a laptop's island.
 */
describe("the island", () => {
	/** Where the controls' top edge is, from the bottom: max(20, inset + 8), then their height. */
	const top = (inset: number) => Math.max(ISLAND_OFFSET, inset + 8) + ISLAND_HEIGHT;

	const screens: [string, { width: number; height: number }, number][] = [
		["a laptop", { width: 1280, height: 800 }, 0],
		["an Android phone", { width: 414, height: 896 }, 0],
		["an iPhone with a home indicator", { width: 390, height: 844 }, 34],
		["a smaller iPhone with one", { width: 375, height: 812 }, 34],
	];

	it("keeps the stage, the strip and the cards above the controls as measured", () => {
		for (const [what, size, inset] of screens) {
			const island = top(inset) + GAP;
			const strip = ids(Math.min(3, stripCapacity(size)));

			const plans = {
				strip: planFocus(size, "stage", strip, { island }),
				close: planClose(size, "them", ["me"], island),
			};

			for (const [arrangement, plan] of Object.entries(plans)) {
				for (const [id, spot] of plan) {
					// The one picture that fills the screen in a call of two is
					// drawn under everything on purpose.
					if (arrangement === "close" && id === "them") continue;
					expect(spot.y + spot.height, `${what}, ${arrangement}, ${id}`).toBeLessThanOrEqual(size.height - top(inset) + 0.5);
				}
			}
		}
	});

	it("gives the grid the measured island to fill around", () => {
		// The grid is centred in the whole room by design and may reach half
		// the reserve into it (see planGrid, and "keeps clear of the controls"
		// above); what it must take is the measured reserve, not the old one.
		for (const [what, size, inset] of screens) {
			const island = top(inset) + GAP;
			for (const spot of planGrid(size, ids(6), island).values()) {
				expect(spot.y + spot.height, what).toBeLessThanOrEqual(size.height - island / 2 + 0.5);
			}
		}
	});

	it("is a laptop's controls where nothing has been measured", () => {
		const size = { width: 1280, height: 800 };
		const strip = ids(3);
		const plan = planFocus(size, "stage", strip);

		for (const id of strip) {
			const spot = plan.get(id);
			if (!spot) throw new Error("somebody in the strip was not placed");
			expect(spot.y + spot.height).toBeLessThanOrEqual(size.height - top(0));
		}
	});
});
