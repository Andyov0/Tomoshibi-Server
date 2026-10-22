import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useHearing } from "@/hooks/useHearing";
import { useT } from "@/hooks/useT";
import { setBlocked, soundOf } from "@/live/hearing";
import { type Surface, label, owner, signature } from "@/live/surface";
import { Copy, Maximize2, Minimize2, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import type { ReactNode } from "react";
import { RoomItems } from "./RoomMenu";

/**
 * What can be done to one picture, on the gesture that has always meant that.
 *
 * Everything here is reachable some other way, and that is the point rather than
 * a redundancy to trim. Putting a picture on the stage is a click and filling the
 * screen with it is a double click — one of those is discoverable and the other
 * is not, and a gesture nobody finds is a feature nobody has. A menu says the
 * names out loud.
 *
 * The exception is the sound, which lives in a panel because sound carries on for
 * people the layout is not drawing. This is the shortcut for the person somebody
 * is looking straight at, writing to the same record; the panel is still where
 * the ones on the second page are reached.
 */
export function PictureMenu({
	surface,
	onStage,
	fullscreen,
	fullscreenSupported,
	onToggleStage,
	onFullscreen,
	onOpenSound,
	children,
}: {
	surface: Surface;
	onStage: boolean;
	fullscreen: boolean;
	fullscreenSupported: boolean;
	onToggleStage: () => void;
	onFullscreen: () => void;
	onOpenSound: () => void;
	children: ReactNode;
}) {
	const t = useT();
	const heard = useHearing();

	const participant = owner(surface);
	const named = label(surface);
	const mark = signature(surface);
	const sound = soundOf(surface.kind === "watch" ? "screen" : surface.kind);
	const setting = heard(participant.identity, sound);

	return (
		<ContextMenu>
			{/*
			 * A span rather than the picture itself, so no tile has to forward a
			 * ref to be right-clickable. It fills its place in the plan exactly,
			 * which is what makes the whole picture the target.
			 *
			 * The press stops here, and only the press. The space around the
			 * pictures carries a menu of its own, so every one of these sits
			 * inside that one — and the two ways a context menu opens do not
			 * nest alike. A right click is safe: the library calls
			 * `preventDefault` and skips its own handler on an event already
			 * defaulted, so the outer trigger declines the second one on its
			 * way past. A long press has no such chain. It opens from a timer
			 * seven hundred milliseconds after the event is over, and both
			 * triggers start one, so a finger held on a face opens the picture's
			 * menu and the room's on top of it.
			 */}
			<ContextMenuTrigger
				className="block size-full"
				onPointerDown={(event) => event.stopPropagation()}
			>
				{children}
			</ContextMenuTrigger>

			{/*
			  * Every item names the picture it is about rather than sitting under
			  * a heading that does. A menu opened on a small tile in a busy grid
			  * has to say which one it caught, and saying it in the items is what
			  * lets them borrow the words the rest of the interface already uses
			  * for the same acts.
			  */}
			<ContextMenuContent>
				<ContextMenuItem onSelect={onToggleStage}>
					{onStage ? <Minimize2 /> : <Maximize2 />}
					{onStage ? t("Show everybody") : t("Show {name} larger", { name: named })}
				</ContextMenuItem>

				{/* Only for the picture that is already on the stage, because the
				    stage is the element that goes full screen. Offered anywhere
				    else it would have to put the picture there first, and the
				    press would do two things under one name. */}
				{onStage && fullscreenSupported && (
					<ContextMenuItem onSelect={onFullscreen}>
						{fullscreen ? <Minimize2 /> : <Maximize2 />}
						{fullscreen ? t("Leave fullscreen") : t("Fill the screen")}
					</ContextMenuItem>
				)}

				{/* Nobody hears themselves, so there is nothing here for our own
				    picture and no row for it in the panel either. */}
				{!surface.local && (
					<>
						<ContextMenuSeparator />

						<ContextMenuItem
							onSelect={() => setBlocked(participant.identity, sound, !setting.blocked)}
						>
							{setting.blocked ? <Volume2 /> : <VolumeX />}
							{setting.blocked
								? t("Unmute {name}", { name: named })
								: t("Mute {name}", { name: named })}
						</ContextMenuItem>

						<ContextMenuItem onSelect={onOpenSound}>
							<SlidersHorizontal />
							{t("Sound settings")}
						</ContextMenuItem>
					</>
				)}

				{/*
				 * Only a signature somebody earned. An issued one is drawn from
				 * nothing and fresh each visit, so copying it produces a string
				 * that is true for the length of this call and misleading
				 * afterwards — and the reason anybody wants one in the clipboard
				 * is to put it in a configuration file.
				 */}
				{mark?.proven && (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem onSelect={() => void navigator.clipboard.writeText(mark.trip)}>
							<Copy />
							{t("Copy signature")}
						</ContextMenuItem>
					</>
				)}

				{/*
				 * The room's own, at the foot of every picture's.
				 *
				 * Not a duplicate to tidy away. Two people are drawn as one
				 * picture filling the frame with the other in a corner of it, so
				 * the space around the pictures — where the room's menu lives —
				 * is a space that is not there in the commonest call anybody
				 * holds. A menu reachable only in a crowd is not reachable.
				 */}
				<ContextMenuSeparator />
				<RoomItems />
			</ContextMenuContent>
		</ContextMenu>
	);
}
