import { type RefObject, useEffect } from "react";

import { GAP, ISLAND } from "@/live/plan";

/**
 * How much of the bottom of the room the controls take, read off the element
 * drawn: its distance from the bottom, its height, and a gap.
 *
 * Read rather than worked out, because both halves move. The distance is a
 * safe-area expression — twenty pixels on a laptop, the home indicator's inset
 * and eight more on an iPhone — and the height steps down at several widths.
 * plan.ts's ISLAND is the figure for when there is nothing to read.
 *
 * The offset and height are the layout's, not the screen's: `offsetHeight` and
 * the computed `bottom` ignore the transform that slides the controls away when
 * they are idle, so the pictures do not jump every time the controls hide.
 */
export function islandReserve(element: HTMLElement): number {
	const bottom = Number.parseFloat(getComputedStyle(element).bottom);
	const height = element.offsetHeight;
	if (!Number.isFinite(bottom) || bottom < 0 || !height) return ISLAND;
	return Math.ceil(bottom + height + GAP);
}

/**
 * Report the controls' reserve whenever it may have changed: the element
 * resizing, the window resizing or turning (which moves the safe area without
 * resizing the element), and the controls moving to or from the side, where
 * they take nothing from the foot and the figure for nothing measured stands.
 */
export function useIslandReserve(
	element: RefObject<HTMLElement | null>,
	side: boolean,
	report: ((reserve: number) => void) | undefined,
): void {
	useEffect(() => {
		const drawn = element.current;
		if (!drawn || !report) return;

		const update = () => report(side ? ISLAND : islandReserve(drawn));
		update();

		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : undefined;
		observer?.observe(drawn);
		window.addEventListener("resize", update);

		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [element, side, report]);
}
