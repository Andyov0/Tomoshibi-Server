import type { Said } from "@/live/chat";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { Linked } from "./Linked";

/**
 * What somebody just said, in the corner, for everybody.
 *
 * This used to be the fallback. Messages floated over the speaker's own
 * picture, and the corner was only for somebody with no picture to float over —
 * on another page, or hidden behind a share. Two things were wrong with that,
 * and the second one is why it is gone.
 *
 * The bubble was easy to miss. It sat on one tile among several, in a grid the
 * reader was not looking at because they were reading the shared screen, and a
 * message nobody notices is a message that was not delivered. The corner is one
 * place, always the same place, and it is where every other application that
 * has solved this puts it.
 *
 * And the two together were worse than either. Showing the same sentence on a
 * tile and in the corner makes the reader decide twice whether they have seen
 * it, which is the same objection that kept messages off the tiles while the
 * panel is open. So there is one place now, and the bubbles are gone rather
 * than kept alongside.
 *
 * Nothing appears here while the panel is open, for that same reason: the
 * message is already on screen, in the place somebody opened in order to read
 * it.
 */

/** How long a card takes to leave. Matches animate-depart. */
const DEPARTS_IN = 180;

interface Departing {
	one: Said;
	leaving: boolean;
}

/**
 * Hold a card on screen long enough to leave.
 *
 * Messages are dropped from the list by a timer that knows nothing about the
 * interface, so without this a card is simply absent on the next frame. The
 * arrival is animated and the departure was not, and that asymmetry is exactly
 * what reads as a glitch rather than as a message expiring — the same argument
 * as useLingering, which cannot be used here because that hook holds one thing
 * and this holds a list whose members leave independently.
 *
 * Order is taken from what was already held rather than rebuilt from the new
 * list, so a card that is on its way out stays where it was instead of jumping
 * to the end of the stack while it fades.
 */
function useDeparting(said: Said[]): Departing[] {
	const [held, setHeld] = useState<Departing[]>([]);

	useEffect(() => {
		const here = new Map(said.map((one) => [one.id, one]));

		setHeld((was) => {
			const known = new Set(was.map((each) => each.one.id));

			return [
				...was.map((each) => {
					const still = here.get(each.one.id);

					return still ? { one: still, leaving: false } : { one: each.one, leaving: true };
				}),
				...said.filter((one) => !known.has(one.id)).map((one) => ({ one, leaving: false })),
			];
		});

		// A timer rather than animationend: an element in a background tab never
		// fires the event, and the node would stay mounted for the rest of the
		// call.
		const timer = setTimeout(() => {
			setHeld((was) => was.filter((each) => here.has(each.one.id)));
		}, DEPARTS_IN);

		return () => clearTimeout(timer);
	}, [said]);

	return held;
}

/**
 * How many cards the corner will stack.
 *
 * A message stays for six seconds and nothing throttles a conversation, so a
 * lively minute would otherwise grow a column up the side of the window and
 * cover the pictures it is meant to sit beside. Three is what a notification
 * stack shows; the panel holds the rest and the badge says it is there.
 *
 * Applied to what is held rather than to what arrives, so a card already on its
 * way out is not shoved off the screen a frame early by the one that replaced
 * it.
 */
const AT_MOST = 3;

export function SaidInCorner({ said }: { said: Said[] }) {
	const held = useDeparting(said).slice(-AT_MOST);

	if (held.length === 0) return null;

	// Above the controls while narrow, where the island is wide enough to reach
	// this corner; back down beside them once the screen is not.
	return (
		<div
			className={cn(
				"pointer-events-none absolute right-3 z-20 flex flex-col items-end gap-1.5",
				"bottom-[calc(max(1.25rem,env(safe-area-inset-bottom)+0.5rem)+4rem)] sm:bottom-3",
			)}
		>
			{held.map(({ one, leaving }, index) => {
				// A run from one person drops the face, the same rule the panel
				// uses, so both readings are the same conversation. Read from what
				// is held rather than from the incoming list, so the grouping does
				// not change under a card that is already leaving.
				const run = index > 0 && held[index - 1]?.one.from === one.from;

				return (
					<div
						key={one.id}
						className={cn(
							"flex max-w-[17rem] gap-2 rounded-lg border border-border bg-surface/95 px-2.5 py-2",
							"shadow-lg backdrop-blur-md",
							leaving ? "animate-depart" : "animate-arrive",
						)}
					>
						<div className={cn("shrink-0", run && "invisible")}>
							<Avatar identity={one.from} className="w-5 min-w-5" />
						</div>

						<div className="flex min-w-0 flex-col">
							{!run && <span className="text-[11px] text-fg-muted">{one.name}</span>}
							<span className="break-words text-[12.5px] leading-snug text-fg">
								<Linked text={one.body} />
							</span>
						</div>
					</div>
				);
			})}
		</div>
	);
}
