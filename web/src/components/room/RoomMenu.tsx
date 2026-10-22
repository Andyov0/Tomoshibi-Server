import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLinkWorks } from "@/hooks/useJoining";
import { useT } from "@/hooks/useT";
import { Link2 } from "lucide-react";
import type { ReactNode } from "react";

/**
 * What can be done to the room rather than to anybody in it.
 *
 * One thing, because one thing has nowhere else to be. The panels and the way
 * off the stage are a press away on a bar that is always on screen, and a menu
 * that repeats a visible button is a longer menu that says nothing new.
 *
 * The link is the exception. There is an invitation on screen while somebody is
 * alone in a room, which is the moment they most need one — and it goes the
 * instant a second person arrives, which is not the moment they stop needing it.
 * Somebody waiting for a third had nowhere to get the address back except the
 * browser's own bar, where it is a room name buried in a fragment.
 */
export function RoomItems() {
	const t = useT();

	// The room as the address names it, because the address is what this
	// copies.
	const linkWorks = useLinkWorks(window.location.hash.replace(/^#\/?/, ""));

	// Nothing at all where a plain link opens for nobody. See useJoining: an
	// offer to copy the address reads as an offer to invite somebody, and under
	// an invitation-only door it is the opposite.
	if (!linkWorks) return null;

	return (
		<ContextMenuItem
			// The address bar's own text, never one assembled here: a hand-built
			// URL is right until the first deployment that puts this behind a
			// path or a different port.
			onSelect={() => void navigator.clipboard.writeText(window.location.href)}
		>
			<Link2 />
			{t("Copy link")}
		</ContextMenuItem>
	);
}

/**
 * The same thing, on the space between the pictures.
 *
 * There is not always any. Two people are drawn as one picture filling the
 * frame with the other in a corner of it, which is a plane with no plane left
 * showing — so this cannot be the only way to reach what it holds, and it is
 * not: every picture's own menu ends with the same item.
 */
export function RoomMenu({ children }: { children: ReactNode }) {
	return (
		<ContextMenu>
			<ContextMenuTrigger className="block size-full">{children}</ContextMenuTrigger>

			<ContextMenuContent>
				<RoomItems />
			</ContextMenuContent>
		</ContextMenu>
	);
}
