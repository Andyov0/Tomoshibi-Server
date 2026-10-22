import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Plan } from "@/live/plan";
import { Plane } from "./Plane";

/*
 * Two things centred at the bottom of the same screen.
 *
 * The page indicator sat at bottom-3, left-1/2, with no stacking order. The
 * control island sits at bottom-[max(1.25rem,…)], left-1/2, z-20, and is about
 * three hundred and eighty pixels wide. So the only thing on the screen saying
 * which page somebody was on was underneath the controls, on every size, from
 * the moment there were enough people for a second page — and the arrows either
 * side loop rather than disable, so there was nothing else to read it from.
 *
 * jsdom computes no layout, so this cannot measure the overlap; the browser
 * script does that. What it can do is hold the decision that put them apart,
 * which is the thing a later change would undo without noticing.
 */

describe("the page indicator", () => {
	it("is not at the bottom, where the controls are", () => {
		const plan: Plan = new Map([["a", { x: 0, y: 0, width: 320, height: 180 }]]);

		const { container } = render(
			<Plane
				measure={() => {}}
				plan={plan}
				tiles={[{ id: "a", node: <span>tile</span> }]}
				page={0}
				pages={3}
				onNext={() => {}}
				onPrevious={() => {}}
			/>,
		);

		const pill = [...container.querySelectorAll("div")].find((node) =>
			/^\s*1\s*\/\s*3\s*$/.test(node.textContent ?? ""),
		);

		expect(pill).toBeTruthy();
		expect(pill?.className).not.toMatch(/\bbottom-/);
		expect(pill?.className).toMatch(/\btop-/);
	});
});
