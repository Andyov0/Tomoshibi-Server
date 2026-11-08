import { useEffect, useState } from "react";

/**
 * How tall the window has to be before a column of controls fits down the side.
 *
 * Eight round buttons, a divider and the padding came to a little under four
 * hundred, and something has to be left above and below or the bar is against
 * both edges: at 420 it fitted with thirteen points to spare, at 360 the top
 * button was off the screen. The buttons are forty-four now and the reactions
 * have a button of their own in a column, so the column is eleven buttons at
 * most — the music and the film included — and about five hundred and seventy
 * tall; six hundred and forty leaves room at both ends.
 */
const NEEDS = 640;

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

/**
 * How wide the window has to be before every control fits in one row.
 *
 * Seven round buttons, the hand with its caret, the divider and the hang-up
 * button, at forty-four pixels each with the gaps and the padding, come to
 * four hundred and fifty with nothing optional in the call and five hundred
 * and fifty with the music and the film as well. Six hundred and forty leaves
 * the widest of those a margin either side.
 */
const ROW = 640;

/**
 * Whether the controls fit in one row, or need the island's second row.
 *
 * Below this the bar used to shrink instead: in three steps keyed to how many
 * optional buttons it carried, down to twenty-eight pixels a button on a
 * 320-pixel phone. Everything stayed on screen and every target was smaller
 * than a fingertip, on exactly the screens that are only ever used with one.
 * What is not needed every minute — the reactions, the screen, the sound
 * panel, the music, the film, the devices — goes up a row behind one button
 * instead, and what is left stays at a finger's size.
 */
export function useRoomForRow(): boolean {
	const [roomy, setRoomy] = useState(() => {
		try {
			return window.innerWidth >= ROW;
		} catch {
			return true;
		}
	});

	useEffect(() => {
		const measure = () => setRoomy(window.innerWidth >= ROW);

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
