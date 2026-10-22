import { cn } from "@/lib/utils";
import * as React from "react";

/**
 * A text field.
 *
 * Forwards its ref, because a caller that reveals a field on demand has to be
 * able to focus it: appearing without focus makes somebody click the thing they
 * just asked for.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
	({ className, ...props }, ref) => (
		<input
			ref={ref}
			className={cn(
				"h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg",
				"placeholder:text-fg-muted outline-none transition-colors",
				"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/30",
				"disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	),
);

Input.displayName = "Input";
