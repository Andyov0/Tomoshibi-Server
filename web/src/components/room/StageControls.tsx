import { useT } from "@/hooks/useT";
import { Button } from "@/components/ui/button";
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
}: {
	/** The same person's other picture, when they have one. */
	other: Surface | undefined;
	onSwitch: (surface: Surface) => void;
	fullscreen: boolean;
	onFullscreen: () => void;
	fullscreenSupported: boolean;
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
			className="absolute top-3 right-3 flex gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
		>
			{/* Somebody sharing their screen is two pictures, and reaching the
			    other one otherwise means hunting for a thumbnail in the strip.
			    Only shown when there is somewhere to switch to. */}
			{other && (
				<Button
					variant="secondary"
					size="sm"
					onClick={() => onSwitch(other)}
					className="gap-1.5 bg-black/60 backdrop-blur hover:bg-black/75"
				>
					{other.kind === "screen" ? <MonitorUp className="size-4" /> : <User className="size-4" />}
					{other.kind === "screen" ? t("Their screen") : t("Their camera")}
				</Button>
			)}

			{fullscreenSupported && (
				<Button
					variant="secondary"
					size="icon"
					aria-label={fullscreen ? t("Leave fullscreen") : t("Fill the screen")}
					onClick={onFullscreen}
					className="bg-black/60 backdrop-blur hover:bg-black/75"
				>
					{fullscreen ? <Minimize2 /> : <Maximize2 />}
				</Button>
			)}
		</div>
	);
}
