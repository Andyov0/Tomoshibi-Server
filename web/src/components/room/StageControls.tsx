import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import type { Surface } from "@/live/surface";

import { Maximize2, Minimize2, MonitorUp, User } from "lucide-react";

/**
 * What can be done with whatever is on the stage.
 *
 * Hidden until the pointer is over the stage, because a shared screen is being
 * read and anything permanently on top of it is competing with the thing people
 * came to look at.
 */
export function StageControls({
	other,
	onSwitch,
	fullscreen,
	onFullscreen,
	fullscreenSupported,
	at = "top",
	lift = 0,
}: {
	/** The same person's other picture, when they have one. */
	other: Surface | undefined;
	onSwitch: (surface: Surface) => void;
	fullscreen: boolean;
	onFullscreen: () => void;
	fullscreenSupported: boolean;
	/**
	 * The corner they sit in. The top, on the stage; the foot, on the other
	 * person in a call of two, whose top right corner holds one's own picture
	 * as a card — drawn there, the button to fill the screen read as the card's.
	 */
	at?: "top" | "bottom";
	/**
	 * How far up from the picture's foot to sit, where the picture runs under
	 * the island: on a phone the other person in a call of two fills the whole
	 * screen, and the foot of the picture is behind the hang-up button.
	 */
	lift?: number;
}) {
	const t = useT();
	return (
		// Revealed by hovering the picture these controls belong to. They used to
		// answer to a stage that owned them, and the stage is gone: a picture on
		// the stage is now the same tile it was in the grid, put somewhere else.
		//
		// Kept to themselves, because they are drawn inside the tile and the
		// tile is itself a button. A press on either one used to carry on to the
		// tile beneath: "Their screen" pinned the other picture and the tile's own
		// click pinned this one straight back, so it did nothing, and filling the
		// screen unpinned the picture it had just filled the screen with. Enter
		// and Space went the same way and never reached the button at all, since
		// the tile swallows both to act on itself.
		<div
			className={cn(
				"absolute right-2.5 z-20 flex gap-1.5",
				at === "bottom"
					? "bottom-(--lift)"
					: // Below the host's console where there is one. Both are in
						// the top right corner, and a picture on the stage reaches
						// the top of the room, so the console's crown was drawn over
						// the button that fills the screen — for whoever runs the
						// room, and only for them, which is why nobody else saw it.
						"top-2.5 group-data-[hosting]/room:top-14",
				// Out of sight and out of reach together. Faded to nothing, they
				// still took presses: a tap in the top corner of a share on a
				// phone filled the screen or swapped the picture with nothing
				// there to have been aimed at.
				"pointer-events-none opacity-0 transition-opacity duration-200",
				"group-hover:pointer-events-auto group-hover:opacity-100",
				"focus-within:pointer-events-auto focus-within:opacity-100",
				// Always there where nothing hovers. On a phone the only way to
				// see them was a keyboard nobody has; the stage is pressed with
				// the same finger, so they stay, small and in the corner.
				"pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
			)}
			style={{ "--lift": `${lift + 10}px` } as React.CSSProperties}
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
		>
			{/* Somebody sharing their screen is two pictures, and reaching the
			    other one otherwise means hunting for a thumbnail in the strip.
			    Only shown when there is somewhere to switch to. */}
			{other && (
				<button
					type="button"
					onClick={() => onSwitch(other)}
					className={cn(FLOATING, "gap-1.5 px-3 text-[13px] max-sm:w-11 max-sm:px-0")}
				>
					{other.kind === "screen" ? <MonitorUp /> : <User />}
					{/* The words on a screen with room for them, and only the icon
					    on a phone, where the words ran into the page count in the
					    middle of the top edge. Still said to a reader either way. */}
					<span className="max-sm:sr-only">{other.kind === "screen" ? t("Their screen") : t("Their camera")}</span>
				</button>
			)}

			{fullscreenSupported && (
				<button
					type="button"
					aria-label={fullscreen ? t("Leave fullscreen") : t("Fill the screen")}
					onClick={onFullscreen}
					className={cn(FLOATING, "w-9 pointer-coarse:w-11")}
				>
					{fullscreen ? <Minimize2 /> : <Maximize2 />}
				</button>
			)}
		</div>
	);
}

/*
 * The island's material at the stage's size: thirty-six to a cursor and
 * forty-four to a finger, both round. They were a forty-pixel square and a
 * thirty-two pixel tab in black at sixty per cent, two shapes and two heights
 * side by side, in a material nothing else floating over a call wore.
 */
const FLOATING = cn(
	"pressable glass inline-flex h-9 items-center justify-center rounded-full border font-medium text-fg outline-none",
	"pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0",
	"hover:bg-surface-hi focus-visible:ring-2 focus-visible:ring-fg/70",
);
