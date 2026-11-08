import { useEffect, useRef } from "react";

/**
 * What a panel over the call owes a keyboard: the focus when it opens, Escape
 * to close it, and the focus back where it came from once it has gone.
 *
 * None of the four panels did the last two, and only the messages did the
 * first. A panel is drawn after the pictures in the document and the controls
 * that open it are drawn before them, so with the focus left on the button,
 * Tab carried on along the island and never reached the panel that had just
 * opened; and closing it left the focus wherever it happened to be, often on
 * the page itself, with the whole room to Tab through again.
 *
 * The focus goes to the first control in the panel unless something there has
 * already taken it, which is what the messages do with their field.
 */
export function usePanel(onClose: () => void) {
	const panel = useRef<HTMLElement>(null);
	const close = useRef(onClose);
	close.current = onClose;

	useEffect(() => {
		const before = document.activeElement as HTMLElement | null;
		const element = panel.current;

		if (element && !element.contains(document.activeElement)) {
			element.querySelector<HTMLElement>("input, textarea, button, [tabindex='0']")?.focus({ preventScroll: true });
		}

		const key = (event: KeyboardEvent) => {
			// Left to a menu or a dialog that is open over the panel, which
			// closes itself on the same key.
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (document.querySelector("[data-radix-popper-content-wrapper], [role=dialog][aria-modal]")) return;
			close.current();
		};

		document.addEventListener("keydown", key);

		return () => {
			document.removeEventListener("keydown", key);

			// Back to the button that opened it, if the focus was in the panel
			// or nowhere when it went.
			const now = document.activeElement;
			if ((now === document.body || element?.contains(now)) && before?.isConnected) {
				before.focus({ preventScroll: true });
			}
		};
	}, []);

	return panel;
}
