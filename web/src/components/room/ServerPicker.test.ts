/**
 * What this guards is a menu that looks right on the deployment it was written
 * for and comes apart on the next one.
 *
 * Grouping is built from a free text field an operator types. That field can be
 * empty, can be one level deep or two, can repeat, and can change halfway down
 * the list — and every one of those has a correct rendering that is not obvious
 * from the code. A heading printed once per relay instead of once per run, or a
 * relay indented under a group it does not belong to, is the kind of fault that
 * is only visible with the right list in front of you.
 */

import { describe, expect, it } from "vitest";

import type { Relay } from "@/live/relays";
import { grouped } from "./ServerPicker";

function relay(name: string, region?: string): Relay {
	return { name, url: `wss://${name}.example:1`, region };
}

describe("grouping the relays", () => {
	it("prints a heading once for a run rather than once per relay", () => {
		const rows = grouped([
			relay("shct", "China Mainland"),
			relay("shbgp", "China Mainland"),
			relay("gzbgp", "China Mainland"),
		]);

		expect(rows.filter((row) => row.kind === "heading")).toHaveLength(1);
		expect(rows.filter((row) => row.kind === "relay")).toHaveLength(3);
	});

	it("opens only the levels that changed", () => {
		const rows = grouped([
			relay("tokyo", "Oversea/Asia"),
			relay("seoul", "Oversea/Asia"),
			relay("paris", "Oversea/Europe"),
		]);

		const headings = rows.filter((row) => row.kind === "heading").map((row) => row.text);

		// "Oversea" once, not twice: the second group is a change of the inner
		// level only.
		expect(headings).toEqual(["Oversea", "Asia", "Europe"]);
	});

	it("indents a relay by how deep its group is", () => {
		const rows = grouped([relay("shct", "China Mainland"), relay("tokyo", "Oversea/Asia")]);

		const depths = Object.fromEntries(
			rows.filter((row) => row.kind === "relay").map((row) => [row.relay.name, row.depth]),
		);

		expect(depths).toEqual({ shct: 1, tokyo: 2 });
	});

	// The deployment that has never touched the field, which is every one of
	// them until somebody does. It has to read as the flat list it was.
	it("leaves an ungrouped relay ungrouped", () => {
		const rows = grouped([relay("a"), relay("b", "")]);

		expect(rows.filter((row) => row.kind === "heading")).toHaveLength(0);
		expect(rows.every((row) => row.kind === "relay" && row.depth === 0)).toBe(true);
	});

	// Half typed in. A relay with no region among relays that have one must not
	// silently inherit the group above it.
	it("does not let an ungrouped relay fall inside the group above it", () => {
		const rows = grouped([relay("shct", "China Mainland"), relay("loose")]);

		const loose = rows.find((row) => row.kind === "relay" && row.relay.name === "loose");
		expect(loose).toMatchObject({ depth: 0 });
	});

	// The one somebody notices immediately. A group interrupted by another must
	// gather rather than print its heading twice with the interloper between:
	// the whole promise of a grouped list is that looking in one place finds all
	// of them.
	it("gathers a group that is interrupted in the list", () => {
		const rows = grouped([
			relay("shct", "China Mainland"),
			relay("tokyo", "Oversea/Asia"),
			relay("gzbgp", "China Mainland"),
		]);

		const headings = rows.filter((row) => row.kind === "heading").map((row) => row.text);
		expect(headings).toEqual(["China Mainland", "Oversea", "Asia"]);

		const order = rows.filter((row) => row.kind === "relay").map((row) => row.relay.name);
		expect(order).toEqual(["shct", "gzbgp", "tokyo"]);
	});

	// Gathering must not become sorting. Where a group first appears is where it
	// goes, so moving a relay to the top moves its group to the top.
	it("orders the groups by where each first appears", () => {
		const rows = grouped([
			relay("tokyo", "Oversea/Asia"),
			relay("shct", "China Mainland"),
		]);

		const headings = rows.filter((row) => row.kind === "heading").map((row) => row.text);
		expect(headings).toEqual(["Oversea", "Asia", "China Mainland"]);
	});

	it("ignores stray separators and spacing", () => {
		const rows = grouped([relay("a", " Oversea // Asia / ")]);

		const headings = rows.filter((row) => row.kind === "heading").map((row) => row.text);
		expect(headings).toEqual(["Oversea", "Asia"]);
	});
});
