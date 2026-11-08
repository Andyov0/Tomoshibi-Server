import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tile } from "./Tile";

/*
What this guards is a mark in the corner of a picture coming back.

Every picture that could be pressed showed a small mark in its top right corner
under the pointer, saying that a press makes it larger. The picture on the
stage has the stage's own controls in that same corner, and the two met: the
picture is put on the stage by pressing it, so the pointer is resting on it at
that very moment. Leaving the mark off the stage was the first answer; the
owner then had it taken away on every platform (2026-10-26), the whole picture
being what is pressed. The native apps lost it in the same change.

Nothing else in a bare, unmuted tile draws an icon, so a mark would be the only
svg here.
*/

describe("Tile's corner", () => {
	it("draws no mark on a picture off the stage", () => {
		const { container } = render(
			<Tile label="Ada" onSelect={() => {}}>
				<div />
			</Tile>,
		);

		expect(container.querySelectorAll("svg")).toHaveLength(0);
	});

	it("draws no mark on the picture on the stage, whose corner holds the stage's controls", () => {
		const { container } = render(
			<Tile label="Ada" selected onSelect={() => {}} onExpand={() => {}}>
				<div />
			</Tile>,
		);

		expect(container.querySelectorAll("svg")).toHaveLength(0);
	});

	it("still draws the marks that belong to the name", () => {
		const { container } = render(
			<Tile label="Ada" muted onSelect={() => {}}>
				<div />
			</Tile>,
		);

		expect(container.querySelectorAll("svg")).toHaveLength(1);
	});
});
