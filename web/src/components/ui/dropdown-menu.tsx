import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type * as React from "react";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;

export function DropdownMenuContent({
	className,
	sideOffset = 6,
	collisionPadding = 8,
	...props
}: React.ComponentProps<typeof Primitive.Content>) {
	return (
		<Primitive.Portal>
			<Primitive.Content
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className={cn(
					// No taller than the window has room for, and scrolled past that.
					// It was clipped instead: the device menu opens upward from a bar
					// at the bottom, and on a short window its first items -- the
					// microphones -- were above the top edge, where a press landed
					// outside the menu and closed it. The width is held the same way,
					// because a two-line item with a long description widened the
					// menu past the edge of a phone.
					"z-50 max-h-(--radix-dropdown-menu-content-available-height) max-w-(--radix-dropdown-menu-content-available-width)",
					"min-w-56 overflow-y-auto overflow-x-hidden",
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

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
	return (
		<Primitive.Label
			className={cn("px-2 py-1.5 font-medium text-fg-muted text-xs", className)}
			{...props}
		/>
	);
}

export function DropdownMenuSeparator({
	className,
	...props
}: React.ComponentProps<typeof Primitive.Separator>) {
	return <Primitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

/**
 * An item that does something, rather than one that records a state.
 *
 * No indicator column, because nothing here is ever ticked: the difference
 * between this and the checkbox beside it is the difference between choosing and
 * starting, and a row that reserves space for a tick it will never show reads as
 * a setting somebody forgot to turn on.
 */
export function DropdownMenuItem({
	className,
	...props
}: React.ComponentProps<typeof Primitive.Item>) {
	return (
		<Primitive.Item
			className={cn(
				"relative flex cursor-default select-none items-start gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
				"focus:bg-surface-hi data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuCheckboxItem({
	className,
	children,
	checked,
	...props
}: React.ComponentProps<typeof Primitive.CheckboxItem>) {
	return (
		<Primitive.CheckboxItem
			checked={checked}
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-sm outline-none",
				"focus:bg-surface-hi data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<span className="absolute left-2 flex size-4 items-center justify-center">
				<Primitive.ItemIndicator>
					<Check className="size-4" />
				</Primitive.ItemIndicator>
			</span>
			{children}
		</Primitive.CheckboxItem>
	);
}
