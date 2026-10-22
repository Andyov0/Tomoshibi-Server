import { useT } from "@/hooks/useT";
import { VISIBLE } from "@/live/notices";
import { Toaster } from "sonner";

/**
 * Where notices appear, everywhere.
 *
 * Mounted at the root of each document rather than inside the room, which is
 * where it used to be — and where it left the page before the room with no way
 * to raise anything. That page therefore grew a red bar of its own for the one
 * error it knew about, and the management pages grew a third thing again, so a
 * deployment had four ways of saying something went wrong depending on which
 * screen somebody happened to be on.
 *
 * One rule now, and it is about lifetime rather than severity:
 *
 *   A notice is something that happened. Somebody arrived, a device was
 *   refused, a room would not open. It fades, because the event is over.
 *
 *   A banner is something that is still true. The connection is down; nobody
 *   has joined yet; this browser will not give up a camera. Those stay, because
 *   dismissing them would not change the fact.
 *
 * Both belong to the corner shared with what people say. What separates a
 * notice from a message is shape rather than position: a notice is a line of
 * dim text, a message has a face, a name, and somebody's own words.
 *
 * Sonner's own styling is replaced wholesale. Its defaults are a light card
 * with its own icons and its own type scale, none of which belong in a room
 * that is deliberately this quiet. Unstyled also takes its close button out of
 * its own hands: every rule it ships for one is written against a toast it
 * styled, so the button arrives here with nothing on it at all.
 */
export function Notices() {
	const t = useT();

	return (
		<Toaster
			position="bottom-right"
			// Its icons are not the set the rest of the interface uses, and a
			// notice this short says everything in the words anyway — the more so
			// now that what kind it is, is an edge. Hidden rather than unset,
			// because an icon it was given falsy falls through to the one it
			// ships: there is no way to ask for none.
			icons={{}}
			// Three is what fits above the island without becoming a column of
			// its own; the fourth pushes the oldest out, which is the right
			// thing to lose — except where the oldest is that sound is held
			// back, which notices.ts brings to the front again rather than lose.
			visibleToasts={VISIBLE}
			offset={16}
			gap={8}
			// Below six hundred these stretch across the foot of the screen, which
			// is the library's own doing and the right shape for a hand. How far
			// up is not one number: the screen before a call keeps its own button
			// down there and the call keeps an island, and a notice laid over
			// either is a notice covering the thing somebody is reaching for.
			// This clears the first. The second is index.css, by the position
			// rather than by this offset — the library writes the offset inline,
			// where no stylesheet can change it, which is why the rule there that
			// tried to went unnoticed for as long as it did.
			mobileOffset={{
				bottom: "calc(env(safe-area-inset-bottom) + 2.5rem)",
				left: 12,
				right: 12,
			}}
			toastOptions={{
				unstyled: true,
				closeButtonAriaLabel: t("Dismiss"),
				classNames: {
					toast: [
						// Across the foot in a hand, and no wider than its own words
						// once there is a column to sit in.
						//
						// Pushed to the right only in the column. In a hand the
						// library pins each notice at left 0 with a width of its own
						// two offsets short of the strip it sits in, and a left margin
						// of auto took those twenty-four pixels as room to move into:
						// every notice on a phone sat twelve pixels in from where it
						// should and ran twelve off the right edge, its last words
						// cut. Measured at 320 and 375 on the refusal a host meets
						// handing a room to a guest, and the same on every other.
						"flex w-full max-w-full sm:ml-auto sm:w-fit sm:max-w-72",
						"items-start gap-2 rounded-lg border border-border",
						// The edge is the whole of the severity system. A wash of
						// colour over a notice this small says less than a rail
						// beside it, and this interface spends its two colours on
						// what things are rather than on tinting them.
						"border-l-2 border-l-border",
						"bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-md",
						"font-sans text-[12.5px] text-fg leading-snug",
					].join(" "),
					icon: "hidden",
					title: "font-normal",
					description: "mt-0.5 text-[11.5px] text-fg-muted",
					error: "border-l-danger",
					actionButton: [
						// The foreground colour rather than the signal one. Amber
						// means something is happening, and the notice this sits on
						// says nothing can be heard.
						"shrink-0 self-center rounded-md bg-fg px-2 py-1",
						"font-semibold text-[11.5px] text-bg transition-opacity hover:opacity-90",
					].join(" "),
					closeButton: [
						"order-last shrink-0 self-start rounded p-0.5 text-fg-muted",
						"transition-colors hover:bg-surface-hi hover:text-fg",
						"outline-none focus-visible:ring-2 focus-visible:ring-fg/70",
					].join(" "),
				},
			}}
		/>
	);
}
