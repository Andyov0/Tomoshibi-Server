import { actionFailed } from "@/live/notices";
import { useCallback, useMemo, useRef, useState } from "react";

/**
 * A row of checkboxes that move when pressed and go back if the server says no.
 *
 * The checkboxes elsewhere on these pages are drawn from what the server last
 * said, and wait for it: pressed, the box springs back to where it was until
 * the request and the reread of the list behind it have both come back, and
 * then flips. On a row of six that reads as a box that did not take, and the
 * natural response — press it again — sends the opposite change. So these show
 * the press at once, mark the box as in flight, and put it back with a message
 * only when the server refuses.
 *
 * Each box on its own as far as anybody can see. The accounts page's other
 * actions share one flag that drops any press made while another row is busy,
 * which is right for deleting an account and wrong for six boxes somebody ticks
 * in a row: the second press would vanish without a word.
 *
 * Underneath, one request at a time per row, each carrying the presses not yet
 * answered — the boxes that moved, and nothing about the others. It carried the
 * whole set once, as this page last drew it, and the server replaced its set
 * with that: so a page polled half a minute ago, ticking Music, also sent back
 * the Emby it had last seen, and undid another administrator's grant made in
 * between, with no message on either page because nothing had failed. The
 * server now lays what it is sent over what it holds, for an account's
 * permissions and an administrator's grants and capabilities alike, and the
 * set this row last drew is never sent: so there is nothing here for an old
 * answer from the poll to put back. Queued still, so that a box ticked and
 * unticked quickly reaches the server in the order it was pressed.
 *
 * What a request carries is read from a ref rather than from what was last
 * drawn. A request waiting behind a refused one leaves in the same turn of the
 * event loop as the refusal, before React has drawn anything, so presses read
 * from the last render would still hold the refused box and send it again.
 */
export function useOptimistic(
	server: Record<string, boolean> | undefined,
	settle: () => Promise<unknown> | unknown,
): {
	held: Record<string, boolean>;
	saving: (key: string) => boolean;
	set: (key: string, value: boolean, send: (changes: Record<string, boolean>) => Promise<unknown>) => Promise<void>;
} {
	const [pending, setPending] = useState<Record<string, boolean>>({});
	const [flying, setFlying] = useState<Record<string, number>>({});

	const held = useMemo(() => ({ ...server, ...pending }), [server, pending]);

	// The presses not yet answered: what is drawn over the server's answer,
	// and what every request lays over what the server holds.
	const unsent = useRef<Record<string, boolean>>({});

	// Which press last moved each box. A box ticked and unticked quickly has
	// two requests queued, and the first to finish must not clear the second's
	// value and show the server's older answer between them — nor, if it is
	// refused, take back a press made after it.
	const presses = useRef<Record<string, number>>({});

	// The request in flight, which the next one waits behind.
	const queue = useRef<Promise<void>>(Promise.resolve());

	const set = useCallback(
		(key: string, value: boolean, send: (changes: Record<string, boolean>) => Promise<unknown>) => {
			const press = (presses.current[key] ?? 0) + 1;
			presses.current[key] = press;

			unsent.current = { ...unsent.current, [key]: value };
			setPending(unsent.current);
			setFlying((was) => ({ ...was, [key]: (was[key] ?? 0) + 1 }));

			const run = queue.current.then(async () => {
				try {
					await send({ ...unsent.current });
					await settle();
				} catch (err) {
					// The sentence the API layer made from the server's code, as
					// on every other press here that did not take. It fades: the
					// box goes back below, so nothing is left for anybody to act
					// on.
					actionFailed(err instanceof Error ? err.message : String(err));
				} finally {
					// Answered either way: accepted, it is in what the server
					// holds; refused, it is taken back — off the screen, and out
					// of the set the next queued request sends, where left in it
					// would be refused a second time and take that box with it.
					if (presses.current[key] === press) {
						const { [key]: _, ...rest } = unsent.current;
						unsent.current = rest;
						setPending(rest);
					}

					setFlying((was) => ({ ...was, [key]: Math.max(0, (was[key] ?? 1) - 1) }));
				}
			});

			queue.current = run;

			return run;
		},
		[settle],
	);

	const saving = useCallback((key: string) => (flying[key] ?? 0) > 0, [flying]);

	return { held, saving, set };
}
