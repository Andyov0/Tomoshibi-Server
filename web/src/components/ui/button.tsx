import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";

/*
 * Keyboard focus is a white ring rather than a second colour. The palette has
 * exactly one hue that means something is happening, and spending it on "this
 * is where the keyboard is" would make it mean two things. It stands two
 * pixels off the button, in the page's own colour, so that on a round control
 * sitting in the island it reads as a ring around the button rather than as a
 * thicker edge of it.
 *
 * Every variant has a hover and a press of its own, and they move the same
 * way: towards the foreground by a step, and by another under the finger. The
 * translucent hovers they had before (`/80`, `/90`) let whatever was behind
 * the button through, and behind a button is usually the same grey, so the
 * hover was measured at two levels in two hundred and fifty-five on the call's
 * own controls — there, and nobody could see it.
 */
const buttonVariants = cva(
	cn(
		"pressable inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-medium text-sm outline-none",
		"focus-visible:ring-2 focus-visible:ring-fg/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
		"disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0",
	),
	{
		variants: {
			variant: {
				default: "bg-tally text-tally-fg hover:bg-tally/90 active:bg-tally/80",
				/*
				 * The one action on a screen — start, join, sign in — in the
				 * amber, with the dark ink the amber always carries, as the
				 * native clients draw it. It was the foreground colour, on the
				 * argument that the amber means something is happening and a
				 * button not yet pressed is not; the four clients disagreed about
				 * it, and the owner chose the amber for all of them (2026-10-29).
				 * The ink is seven to one or better on either amber.
				 *
				 * Disabled, it is grey rather than a faded amber. A pale amber
				 * still reads as the button to press, only weaker, and somebody
				 * presses it and nothing happens; grey reads as not yet.
				 */
				primary: cn(
					"bg-tally text-tally-fg hover:bg-tally/90 active:bg-tally/80",
					"disabled:bg-surface-hi disabled:text-fg-muted disabled:opacity-100",
				),
				secondary: "bg-surface-hi text-fg hover:bg-surface-hi-hover active:bg-surface-hi-press",
				outline: "border border-border bg-transparent text-fg hover:bg-wash active:bg-wash-press",
				ghost: "text-fg hover:bg-wash active:bg-wash-press",
				danger: "bg-danger text-danger-fg hover:bg-danger/90 active:bg-danger/80",
				/*
				 * A switch that is off, on the controls for one's own devices.
				 *
				 * Drawn in the foreground, the way FaceTime and the phone's own
				 * call screen draw a muted microphone: the one state on that row
				 * somebody must be able to read from across the room, because
				 * talking into a muted microphone is the commonest mistake a
				 * call has. It was drawn as the same grey as a live microphone
				 * with a dimmer icon, which at arm's length is the same button;
				 * and the screen before a call drew it red, so the one switch
				 * looked like two different things a screen apart. Not red here,
				 * for the reason the island gives: red is for leaving and for
				 * faults, and a muted microphone is a choice.
				 */
				off: "bg-fg text-bg hover:bg-fg/88 active:bg-fg/78",
			},
			/*
			 * Four heights, the same four the native clients use, each taller
			 * where the pointer is a finger: thirty-two or thirty-six to a
			 * cursor, forty-four or fifty-two to a thumb. The radius is the
			 * shared small step, ten, and the large one takes the next.
			 */
			size: {
				default: "h-9 px-4 pointer-coarse:h-11",
				sm: "h-8 px-3 text-xs pointer-coarse:h-9",
				lg: "h-11 px-6 text-[15px] rounded-[14px] pointer-coarse:h-13",
				icon: "size-9 pointer-coarse:size-11",
				// Round, for the controls on the island. A rounded square inside
				// a capsule reads as a button that was placed there; a circle
				// reads as part of it. Forty-four, the size the platforms ask a
				// finger to be given, and the size the native islands already
				// are; the icon at four tenths of it, as theirs is. At sixteen
				// inside forty it was a quarter of the button, and read as a
				// button with nothing much on it.
				round: "size-11 rounded-full [&_svg]:size-[18px]",
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
