import { useEffect, useState } from "react";

/** How long a panel takes to leave: index.css's page-leave, to the millisecond. */
export const LEAVING_MS = 160;

/**
 * Which panel to draw, trailing the one chosen by as long as the last takes to
 * leave.
 *
 * The rail answers a press at once and the panel underneath follows: the old
 * one leaves, and only then is the new one drawn, arriving. One panel at a time
 * and never two, because two panels in one column for a sixth of a second is
 * the new one drawn below the old and then jumping up into its place, which is
 * the layout moving under somebody's finger rather than a transition.
 *
 * A second press while the first panel is still leaving is the panel chosen
 * changing again, and the wait starts over for it; a press back on the panel
 * that is leaving stops it leaving, with everything on it as it was. Somebody
 * who has asked for less motion is given the new panel without the wait, since
 * the leaving itself is then a millisecond and the rest would be a blank page.
 */
export function useSwap<T>(chosen: T, ms = LEAVING_MS): { shown: T; leaving: boolean } {
	const [shown, setShown] = useState(chosen);

	useEffect(() => {
		if (shown === chosen) return;

		const still =
			typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

		const timer = window.setTimeout(() => setShown(chosen), still ? 0 : ms);

		return () => window.clearTimeout(timer);
	}, [chosen, shown, ms]);

	return { shown, leaving: shown !== chosen };
}
