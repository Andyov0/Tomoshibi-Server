import { useEffect, useState } from "react";

/**
 * Hold a flag on for a moment after it goes off.
 *
 * Speaking arrives as a flag the server re-derives whenever the order of
 * speakers changes, which means a pause between two sentences turns it off and
 * the next word turns it back on. Rendering that directly makes the tally
 * flicker through a single remark.
 *
 * Rising is immediate, because the point of the mark is to say who is talking
 * and being late with that is worse than holding it a moment too long. Only the
 * fall is delayed.
 */
export function useSteady(value: boolean, hold = 700): boolean {
	const [held, setHeld] = useState(value);

	useEffect(() => {
		if (value) {
			setHeld(true);
			return;
		}

		const timer = setTimeout(() => setHeld(false), hold);
		return () => clearTimeout(timer);
	}, [value, hold]);

	return held;
}
