import { useEffect, useState } from "react";

/**
 * How tall the window has to be before a column of controls fits down the side.
 *
 * Eight round buttons, a divider and the padding come to a little under four
 * hundred, and something has to be left above and below or the bar is against
 * both edges. Measured rather than guessed: at 420 it fits with thirteen points
 * to spare, at 360 the top button is off the screen.
 */
const NEEDS = 480;

/**
 * Whether there is room to put the controls down the side.
 *
 * A phone on its side is about 390 points tall, and so is a laptop window
 * dragged flat. The column is 395, so at those heights it runs off both edges
 * at once and the buttons at the ends — mute at the top, leave at the bottom —
 * cannot be pressed at all. There is no scrolling out of it and nothing on the
 * screen says why.
 *
 * So the choice is honoured where it can be. This is not the server-choice rule
 * in miniature: somebody choosing a side is choosing a shape, and a shape that
 * does not fit is not the thing they chose.
 */
export function useRoomForSide(): boolean {
	const [roomy, setRoomy] = useState(() => {
		try {
			return window.innerHeight >= NEEDS;
		} catch {
			return true;
		}
	});

	useEffect(() => {
		const measure = () => setRoomy(window.innerHeight >= NEEDS);

		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("orientationchange", measure);

		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("orientationchange", measure);
		};
	}, []);

	return roomy;
}
