import { useCallback, useEffect, useState } from "react";

/** How long the second press is waited for before the first is forgotten. */
const WAIT = 4000;

/**
 * A press that has to be made twice.
 *
 * For removing somebody from a call, which ends their meeting and cannot be
 * taken back. It used to happen on one press of an icon beside rows that
 * re-order themselves every couple of seconds as the poll comes back, so a
 * press meant for one row could land on another and there was nothing between
 * it and somebody being thrown out. Closing a room already asks first, in its
 * own way; this is the same step for the other irreversible thing on the page.
 *
 * Asked in place rather than in a dialog: the button says what a second press
 * will do, where the first one landed. It goes back on its own, so a press
 * nobody follows up is simply forgotten.
 */
export function useTwice(onConfirm: () => void) {
	const [armed, setArmed] = useState(false);

	useEffect(() => {
		if (!armed) return;
		const timer = window.setTimeout(() => setArmed(false), WAIT);
		return () => window.clearTimeout(timer);
	}, [armed]);

	const press = useCallback(() => {
		if (!armed) {
			setArmed(true);
			return;
		}
		setArmed(false);
		onConfirm();
	}, [armed, onConfirm]);

	const disarm = useCallback(() => setArmed(false), []);

	return { armed, press, disarm };
}
