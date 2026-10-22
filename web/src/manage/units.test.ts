import { beforeEach, describe, expect, it } from "vitest";
import { linkBits, linkIs } from "./units";

/*
 * What the bandwidth bars are drawn against.
 *
 * This was a constant, and therefore right on exactly one kind of link. Three
 * things read it: the mark that says a relay is busy, the bar showing how full
 * its pipe is, and the fixed axis of the six-month plot — which is fixed on
 * purpose, because a plot that rescales to its own maximum always looks the
 * same and hides the one thing it exists to show.
 *
 * So on a 200-megabit deployment the plot sat against the bottom of its axis and
 * the busy mark never appeared; on a ten-gigabit one the bar was permanently
 * full and the mark never went out. Both read as the readings being broken.
 */

describe("what the link is thought to carry", () => {
	beforeEach(() => linkIs(undefined));

	it("is a gigabit until the deployment says otherwise", () => {
		expect(linkBits()).toBe(1e9);
	});

	it("is what the deployment says, in megabits", () => {
		linkIs(200);
		expect(linkBits()).toBe(2e8);

		linkIs(10_000);
		expect(linkBits()).toBe(1e10);
	});

	// Zero is the unset value on the server, and a ceiling of nothing would make
	// every bar full and every relay busy for ever.
	it("falls back rather than believing nought", () => {
		linkIs(0);
		expect(linkBits()).toBe(1e9);

		linkIs(-5);
		expect(linkBits()).toBe(1e9);
	});
});
