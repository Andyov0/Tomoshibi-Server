import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useRoomForSide } from "./useRoomFor";

/*
 * That the controls only go down the side where a column of them fits.
 *
 * The bar is a little under four hundred points tall with eight buttons in it.
 * A phone on its side is about three hundred and ninety, and so is a laptop
 * window dragged flat — so at those heights the column runs off both edges at
 * once and the buttons at the ends, mute and leave, cannot be pressed. Nothing
 * on the screen says why, and there is nothing to scroll.
 *
 * Measured before this existed: at 420 the bar sat from 13 to 408, at 360 it
 * started at -17.
 *
 * The window is also watched rather than read once. A window is resized and a
 * phone is turned, and the fault appears on exactly those two events.
 */

const was = window.innerHeight;

function tall(height: number) {
	Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

afterEach(() => tall(was));

it("gives the side to a window with room for it", () => {
	tall(900);

	const { result } = renderHook(() => useRoomForSide());

	expect(result.current).toBe(true);
});

it("refuses the side on a window the column would run off", () => {
	tall(390);

	const { result } = renderHook(() => useRoomForSide());

	expect(result.current).toBe(false);
});

it("changes its mind when the window does", () => {
	tall(900);

	const { result } = renderHook(() => useRoomForSide());
	expect(result.current).toBe(true);

	// A phone being turned on its side, which is the case this is for.
	act(() => {
		tall(390);
		window.dispatchEvent(new Event("resize"));
	});

	expect(result.current).toBe(false);
});
