import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Surface } from "@/live/surface";
import { StageControls } from "./StageControls";
import { Tile } from "./Tile";

/*
 * The controls over a picture on the stage, and the picture they are drawn on.
 *
 * They sit inside the tile, and the tile is a button of its own that takes a
 * picture off the stage when pressed. A press on a control that also reaches the
 * tile undoes whatever the control just did, and the screen shows nothing wrong:
 * the picture is where it was, and the button looks as if it was never wired
 * up. So what is tested is not that each control calls its handler but that the
 * tile around it hears nothing.
 */

const other = { id: "screen", kind: "screen", local: false } as unknown as Surface;

function staged() {
	const onSelect = vi.fn();
	const onExpand = vi.fn();
	const onSwitch = vi.fn();
	const onFullscreen = vi.fn();

	render(
		<Tile
			label="somebody"
			selected
			onSelect={onSelect}
			onExpand={onExpand}
			overlay={
				<StageControls
					other={other}
					onSwitch={onSwitch}
					fullscreen={false}
					onFullscreen={onFullscreen}
					fullscreenSupported
				/>
			}
		>
			<div />
		</Tile>,
	);

	return { onSelect, onExpand, onSwitch, onFullscreen };
}

describe("StageControls", () => {
	it("switches to the other picture without the tile taking it back", () => {
		const { onSelect, onSwitch } = staged();

		fireEvent.click(screen.getByText("Their screen"));

		expect(onSwitch).toHaveBeenCalledWith(other);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("fills the screen without the tile leaving the stage", () => {
		const { onSelect, onExpand, onFullscreen } = staged();

		const button = screen.getByRole("button", { name: "Fill the screen" });
		fireEvent.click(button);
		fireEvent.doubleClick(button);

		expect(onFullscreen).toHaveBeenCalled();
		expect(onSelect).not.toHaveBeenCalled();
		expect(onExpand).not.toHaveBeenCalled();
	});

	// The tile answers Enter and Space by preventing their default, which for a
	// button inside it is the press itself.
	it("leaves a key pressed on a control to the control", () => {
		const { onSelect } = staged();

		const button = screen.getByRole("button", { name: "Fill the screen" });
		const pressed = fireEvent.keyDown(button, { key: "Enter" });

		expect(pressed).toBe(true);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("still lets the picture itself be pressed", () => {
		const { onSelect } = staged();

		fireEvent.click(screen.getByRole("button", { name: /Show everybody/ }));

		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});
