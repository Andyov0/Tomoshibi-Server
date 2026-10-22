import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-context-menu";
import type * as React from "react";

/**
 * The menu a right-click opens, drawn exactly like the one a button opens.
 *
 * A different trigger on the same machinery rather than a second menu: every
 * package this reaches for was already here for the device picker, down to the
 * one that does the whole of the work. What it adds is the gesture — and, on a
 * touchscreen, a long press, which the library handles itself and which is the
 * only way any of this is reachable from a phone.
 *
 * That long press is also why a call is not selectable text. The press and a
 * text selection are the same gesture to a browser, and whichever starts first
 * cancels the other.
 */
export const ContextMenu = Primitive.Root;
export const ContextMenuTrigger = Primitive.Trigger;

export function ContextMenuContent({
	className,
	...props
}: React.ComponentProps<typeof Primitive.Content>) {
	return (
		<Primitive.Portal>
			<Primitive.Content
				className={cn(
					// No taller than the window has room for, for the reason the dropdown
					// gives: clipped, the items past the edge could not be pressed.
					"z-50 max-h-(--radix-context-menu-content-available-height) min-w-52 overflow-y-auto overflow-x-hidden",
					"rounded-lg border border-border bg-surface p-1 shadow-lg",
					// This application's own motion, not a plugin's. The classes
					// that used to be here — animate-in, fade-in-0 — belong to
					// tailwindcss-animate, which is not in the manifest and never
					// has been, so they compiled to nothing and every menu here
					// cut in and out. arrive and depart are what the rest of the
					// interface already moves with, and Radix keeps the node
					// mounted for the closing one.
					"data-[state=open]:animate-arrive data-[state=closed]:animate-depart",
					className,
				)}
				{...props}
			/>
		</Primitive.Portal>
	);
}

export function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
	return (
		<Primitive.Label
			className={cn("truncate px-2 py-1.5 font-medium text-fg-muted text-xs", className)}
			{...props}
		/>
	);
}

export function ContextMenuSeparator({
	className,
	...props
}: React.ComponentProps<typeof Primitive.Separator>) {
	return <Primitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof Primitive.Item>) {
	return (
		<Primitive.Item
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
				"focus:bg-surface-hi data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				"[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-muted",
				className,
			)}
			{...props}
		/>
	);
}
