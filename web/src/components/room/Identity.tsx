import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";

/**
 * Who somebody is, as one control.
 *
 * A name and the passphrase that proves it were two fields, one above the other,
 * which said they were two decisions. They are not: the passphrase is the whole
 * of what makes the name anybody's, and it is worth nothing on its own. So they
 * are one bordered field with a hairline through it, and the ring on focus
 * belongs to the pair rather than to whichever half is being typed in.
 *
 * The name takes the wider share because it is read as letters and the
 * passphrase is read as dots.
 *
 * Two bare inputs rather than the shared field component, which brings a border
 * and a ring of its own: here the container owns both, and a field inside a
 * field is a box drawn twice.
 */
export function Identity({
	name,
	passphrase,
	onName,
	onPassphrase,
	nameOnly = false,
	fixed = false,
}: {
	name: string;
	passphrase: string;
	onName: (name: string) => void;
	onPassphrase: (passphrase: string) => void;
	/**
	 * Somebody who arrived on an invitation, for whom the second field is a
	 * question they cannot answer.
	 *
	 * They were sent a link precisely so that they would not need a passphrase,
	 * and a field asking for one — beside a name they did choose — reads as
	 * something they have forgotten to do. Removed rather than disabled: a
	 * greyed-out box is still a box somebody wonders about.
	 */
	nameOnly?: boolean;
	/**
	 * A name somebody else chose, which is the one that will be worn.
	 *
	 * Shown and not editable, rather than hidden: the guest should see what the
	 * room will call them before they are in it. Read-only rather than disabled,
	 * so it can still be selected and read by a screen reader.
	 */
	fixed?: boolean;
}) {
	const t = useT();
	const [shown, setShown] = useState(false);

	return (
		<div
			className={cn(
				"overflow-hidden rounded-lg border border-border bg-surface",
				nameOnly ? "grid grid-cols-1" : "grid grid-cols-[1.25fr_1fr]",
				"transition-[border-color,box-shadow]",
				"focus-within:border-fg/40 focus-within:ring-2 focus-within:ring-fg/30",
			)}
		>
			<input
				value={name}
				onChange={(event) => onName(event.target.value)}
				readOnly={fixed}
				placeholder={t("Your name")}
				aria-label={t("Your name")}
				// Named for the password manager rather than for this form. It is
				// what a stored credential is filed under, and what makes the half
				// beside it fill itself at the same time.
				autoComplete="username"
				// biome-ignore lint/a11y/noAutofocus: the screen exists to be typed into
				autoFocus={!fixed}
				maxLength={80}
				className={cn(
					"h-11 min-w-0 bg-transparent px-3 text-fg text-sm outline-none",
					"placeholder:text-fg-muted",
					fixed && "cursor-default text-fg-muted",
				)}
			/>

			{!nameOnly && (
			<div className="relative flex min-w-0 items-center border-border border-l">
				{/*
				 * The one place on this screen the signal colour appears, and it
				 * means what it means everywhere else in this application: this is
				 * live. A name nobody can take is the only thing here worth
				 * lighting, and it lights the moment there is something to light.
				 */}
				<KeyRound
					className={cn(
						"pointer-events-none absolute left-3 size-3.5 transition-colors",
						passphrase ? "text-tally" : "text-fg-muted",
					)}
				/>

				<input
					type={shown ? "text" : "password"}
					value={passphrase}
					onChange={(event) => onPassphrase(event.target.value)}
					placeholder={t("Passphrase")}
					aria-label={t("Passphrase")}
					autoComplete="current-password"
					maxLength={200}
					className={cn(
						"h-11 min-w-0 w-full bg-transparent pl-8.5 text-fg text-sm outline-none",
						"placeholder:text-fg-muted",
						// Room for the eye only while there is one.
						passphrase ? "pr-9" : "pr-3",
					)}
				/>

				{/*
				 * Only once there is something to look at. A passphrase generated
				 * by the server is eleven characters of nothing memorable, and the
				 * one thing anybody wants while typing it is to check they typed
				 * it — but an eye beside an empty field is a control offering to
				 * reveal nothing.
				 */}
				{passphrase && (
					<button
						type="button"
						onClick={() => setShown((was) => !was)}
						aria-label={shown ? t("Hide passphrase") : t("Show passphrase")}
						aria-pressed={shown}
						className={cn(
							"absolute right-2 grid size-6 place-items-center rounded text-fg-muted",
							"transition-colors hover:text-fg",
							"outline-none focus-visible:ring-2 focus-visible:ring-fg/70",
						)}
					>
						{shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
					</button>
				)}
			</div>
			)}
		</div>
	);
}
