import { describe, expect, it } from "vitest";

import { powers } from "./grants";

/*
 * What this guards is a page that offers each administrator the switches their
 * role covers, and no others.
 *
 * The server spells every capability out, so most of the time a flag is just
 * whether its word is in the list. The case that goes wrong silently is a page
 * deployed ahead of its server: the older server says observe and moderate and
 * nothing finer, and a page reading only the finer words would draw a moderator
 * as somebody who may change nothing at all — every switch greyed, with no
 * error anywhere, on the deployment's owner.
 */

describe("what an administrator is offered", () => {
	it("is everything for a moderator, whether or not the four are spelled out", () => {
		const all = { rooms: true, accounts: true, relays: true, settings: true, moderate: true };

		expect(powers(["observe", "rooms", "accounts", "relays", "settings", "moderate"])).toEqual(all);
		expect(powers(["observe", "moderate"])).toEqual(all);
	});

	it("is exactly the boxes ticked for a custom administrator, and never the roster", () => {
		expect(powers(["observe", "accounts", "settings"])).toEqual({
			rooms: false,
			accounts: true,
			relays: false,
			settings: true,
			moderate: false,
		});
	});

	it("is nothing for somebody who may only look", () => {
		expect(Object.values(powers(["observe"])).some(Boolean)).toBe(false);
	});
});
