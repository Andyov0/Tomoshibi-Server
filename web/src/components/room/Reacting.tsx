import { cn } from "@/lib/utils";

/**
 * A raised hand and whatever somebody just reacted with, on their picture.
 *
 * The two are drawn together and behave oppositely, which is the point of
 * putting them in one place: the hand stays until it is lowered and sits still,
 * and the reaction rises off the tile and is gone. Somebody glancing at a wall
 * of tiles should be able to tell "wants to speak" from "just laughed" without
 * reading either.
 *
 * Top-left, away from the name and the mute badge, and away from the stage
 * controls, which are the two other things that can be over a tile at once.
 */
export function Reacting({ hand, reactions }: { hand?: boolean; reactions?: string[] }) {
	return (
		<>
			{hand && (
				<span
					className={cn(
						"absolute top-2 left-2 flex size-7 items-center justify-center rounded-full",
						"animate-arrive bg-tally text-base text-bg shadow-lg",
					)}
					// Announced, because a hand nobody sees is a hand that was not
					// put up. A reader has no tile to glance at.
					role="status"
				>
					{"✋"}
				</span>
			)}

			{reactions?.map((one, at) => (
				<span
					// Position and key from the index: two of the same reaction at
					// once are two separate things on screen and must not share a
					// key, and they must not sit on top of each other either.
					key={`${one}-${at}`}
					className="pointer-events-none absolute bottom-10 left-1/2 animate-float text-3xl"
					style={{ marginLeft: `${(at % 3) * 28 - 28}px` }}
					aria-hidden
				>
					{one}
				</span>
			))}
		</>
	);
}
