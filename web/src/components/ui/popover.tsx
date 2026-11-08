import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-popover";
import type * as React from "react";

/*
 * A panel that opens from a control and lies over the page rather than in it,
 * so that opening it moves nothing: the guest links' calendar (WhenField).
 *
 * The same family as the menus, and pinned to the version released with the
 * installed dropdown menu, so that every package beneath it is one already
 * installed for that menu and this adds only itself. Drawn and moving as a
 * menu does.
 */

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverClose = Primitive.Close;

export function PopoverContent({
	className,
	sideOffset = 6,
	collisionPadding = 8,
	align = "start",
	...props
}: React.ComponentProps<typeof Primitive.Content>) {
	return (
		<Primitive.Portal>
			<Primitive.Content
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				align={align}
				className={cn(
					// No taller than the window has room for, as the menus are.
					"z-50 max-h-(--radix-popover-content-available-height) max-w-(--radix-popover-content-available-width) overflow-y-auto",
					"rounded-[16px] border border-border bg-surface p-3 shadow-lg outline-none",
					"data-[state=open]:animate-arrive data-[state=closed]:animate-depart",
					className,
				)}
				{...props}
			/>
		</Primitive.Portal>
	);
}
