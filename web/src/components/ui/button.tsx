import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";

/*
 * Keyboard focus is a white ring rather than a second colour. The palette has
 * exactly one hue that means something is happening, and spending it on "this
 * is where the keyboard is" would make it mean two things.
 */
const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-fg/70 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-tally text-tally-fg hover:bg-tally/90",
				// The one action on a screen, drawn in the foreground colour
				// rather than the signal one. By the same rule as the focus ring
				// above: the palette has a single hue that means something is
				// happening, and a button somebody has not pressed yet is not it.
				// On the screen before a call it would also be the second amber
				// thing there, beside a key that lights when a name is proven —
				// and two of them is none.
				primary: "bg-fg text-bg hover:bg-fg/90",
				secondary: "bg-surface-hi text-fg hover:bg-surface-hi/80",
				outline: "border border-border bg-transparent text-fg hover:bg-surface-hi",
				ghost: "text-fg hover:bg-surface-hi",
				danger: "bg-danger text-danger-fg hover:bg-danger/90",
			},
			size: {
				default: "h-10 px-4",
				sm: "h-8 px-3 text-xs",
				lg: "h-12 px-6 text-base",
				icon: "size-10",
				// Round, for the controls on the island. A rounded square inside
				// a capsule reads as a button that was placed there; a circle
				// reads as part of it.
				round: "size-10 rounded-full",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {}

/**
 * `forwardRef` because Radix triggers use `asChild`, which hands the child a ref.
 * A plain function component drops it and warns.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, ...props }, ref) => (
		<button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
	),
);
Button.displayName = "Button";

export { buttonVariants };
