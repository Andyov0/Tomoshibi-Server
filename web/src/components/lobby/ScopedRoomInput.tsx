import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
import { MAX_SCOPED_NAME } from "@/live/names";
import { type ComponentProps, type KeyboardEvent, useId, useState } from "react";

/**
 * A room name, with the part after `@` filled in from somebody's own scopes.
 *
 * The scope is the half of a scoped name nobody should have to type: it is one
 * of a short list this person already belongs to, and a slip in it is not a
 * different room but a refusal -- `standup@acne` is a room that does not exist
 * for anybody, and the first anybody hears of the typo is the door saying no.
 * So typing `@` offers the list, and where there is only one scope it is simply
 * written in.
 *
 * Only completed, never rewritten. Somebody who backs up over the scope and
 * types another is left to it, and told -- under the field, before they press
 * anything -- when what they typed is not a scope they are in. An administrator
 * belongs to every scope, so is never told.
 */
export function ScopedRoomInput({
	value,
	onValueChange,
	scopes,
	admin = false,
	className,
	...input
}: Omit<ComponentProps<"input">, "value" | "onChange"> & {
	value: string;
	onValueChange: (value: string) => void;
	/** The scopes the signed-in account carries. */
	scopes: readonly string[];
	admin?: boolean;
}) {
	const t = useT();
	const list = useId();
	const [focused, setFocused] = useState(false);
	const [active, setActive] = useState(0);
	const [dismissed, setDismissed] = useState(false);

	const at = value.lastIndexOf("@");
	const typedScope = at < 0 ? "" : value.slice(at + 1).toLowerCase();
	const matches = at < 0 ? [] : scopes.filter((scope) => scope.startsWith(typedScope));

	// Nothing to offer once what is typed is already a whole scope.
	const open =
		focused && !dismissed && matches.length > 0 && !(matches.length === 1 && matches[0] === typedScope);
	const chosen = Math.min(active, Math.max(0, matches.length - 1));

	const strange = at >= 0 && typedScope !== "" && !admin && !scopes.includes(typedScope) && !open;

	const accept = (scope: string) => {
		onValueChange(`${value.slice(0, at + 1)}${scope}`);
		setActive(0);
		setDismissed(true);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (!open) return;

		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((chosen + step + matches.length) % matches.length);
		} else if (event.key === "Enter" || event.key === "Tab") {
			// Taking the suggestion rather than submitting the form: with the
			// list open, the scope is what the key is for.
			event.preventDefault();
			accept(matches[chosen] as string);
		} else if (event.key === "Escape") {
			event.preventDefault();
			setDismissed(true);
		}
	};

	return (
		<div className="relative min-w-0 flex-1">
			<input
				{...input}
				value={value}
				maxLength={MAX_SCOPED_NAME}
				role="combobox"
				aria-autocomplete="list"
				aria-expanded={open}
				aria-controls={list}
				aria-activedescendant={open ? `${list}-${chosen}` : undefined}
				onFocus={(event) => {
					setFocused(true);
					input.onFocus?.(event);
				}}
				onBlur={(event) => {
					setFocused(false);
					input.onBlur?.(event);
				}}
				onKeyDown={(event) => {
					onKeyDown(event);
					input.onKeyDown?.(event);
				}}
				onChange={(event) => {
					const next = event.target.value;
					setDismissed(false);
					setActive(0);

					// The `@` just typed, at the end, by somebody with one scope:
					// there is nothing to choose, so it is written in.
					if (next === `${value}@` && scopes.length === 1 && !value.includes("@")) {
						onValueChange(`${next}${scopes[0]}`);
						setDismissed(true);
						return;
					}

					onValueChange(next);
				}}
				className={cn("w-full", className)}
			/>

			{/* Always rendered while there is something it could show, so it
			    can fade out as well as in rather than vanishing. */}
			<div
				id={list}
				role="listbox"
				aria-label={t("Your scopes")}
				className={cn(
					"absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-lg",
					"origin-top transition-[opacity,transform] duration-150 ease-out",
					open ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
				)}
			>
				{matches.map((scope, index) => (
					<div
						key={scope}
						id={`${list}-${index}`}
						role="option"
						aria-selected={open && index === chosen}
						// Down rather than click: a click would blur the field first,
						// and the list would be gone before the press arrived.
						onPointerDown={(event) => {
							event.preventDefault();
							accept(scope);
						}}
						onPointerEnter={() => setActive(index)}
						className={cn(
							"cursor-pointer truncate rounded-md px-2.5 py-1.5 text-sm transition-colors",
							open && index === chosen ? "bg-surface-hi text-fg" : "text-fg-muted",
						)}
					>
						<span className="text-fg-muted">@</span>
						{scope}
					</div>
				))}
			</div>

			<p
				role="status"
				className={cn(
					"overflow-hidden text-[12px] text-danger leading-snug transition-[max-height,opacity,margin] duration-150",
					strange ? "mt-1.5 max-h-10 opacity-100" : "max-h-0 opacity-0",
				)}
			>
				{strange ? t("You are not in {scope}, so this room will not let you in.", { scope: typedScope }) : ""}
			</p>
		</div>
	);
}
