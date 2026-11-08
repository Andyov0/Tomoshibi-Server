import { type RefObject, useEffect, useRef } from "react";

/**
 * Close something that is open when the press lands somewhere else, or on
 * Escape.
 *
 * For the few things on the island that open without Radix, which closes its
 * own menus both ways and was the reason those always behaved: the reactions
 * and the island's second row. Hand-written, each of them had closed only on
 * its own button, so the one way out of an open row of reactions was to find
 * the caret that opened it.
 *
 * On the press going down rather than on the click, so that the press which
 * closes this is not also the one that opens something under it a moment
 * later with this still drawn on top. A press inside a menu Radix has open
 * is not elsewhere: those menus are drawn at the end of the document, outside
 * the element this is anchored to, and a press on one of their rows would
 * otherwise take away the very row it was opened from.
 */
export function useDismiss(
	open: boolean,
	inside: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
	onClose: () => void,
): void {
	// The latest, without the effect starting over every render: the callers
	// pass an arrow written inline.
	const close = useRef(onClose);
	close.current = onClose;

	useEffect(() => {
		if (!open) return;

		const press = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (!target) return;
			const within = Array.isArray(inside) ? inside : [inside];
			if (within.some((one) => one.current?.contains(target))) return;
			if (target instanceof Element && target.closest("[data-radix-popper-content-wrapper]")) return;
			close.current();
		};

		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") close.current();
		};

		document.addEventListener("pointerdown", press, true);
		document.addEventListener("keydown", key);

		return () => {
			document.removeEventListener("pointerdown", press, true);
			document.removeEventListener("keydown", key);
		};
		// The refs are read when a press arrives rather than when this runs, so
		// an array of them written inline by the caller need not be stable.
		// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	}, [open]);
}
