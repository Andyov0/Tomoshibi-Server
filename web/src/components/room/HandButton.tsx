import { useT } from "@/hooks/useT";
import { useLingering } from "@/hooks/useLingering";
import { cn } from "@/lib/utils";
import { REACTIONS, type Reaction } from "@/live/hands";
import { Hand } from "lucide-react";
import { useState } from "react";

/**
 * Putting a hand up, and the reactions that live behind it.
 *
 * One control for two things because they are the same intention: saying
 * something without interrupting whoever is talking. Separating them would put
 * two buttons on a bar that is already the width of the screen on a phone, to
 * distinguish a distinction nobody making it is thinking about.
 *
 * The hand is the button and the reactions are behind a press-and-hold — no,
 * behind the menu, because press-and-hold is a gesture nobody discovers and
 * has no keyboard equivalent at all. A press raises the hand, which is the
 * common case; the caret opens the rest.
 */
export function HandButton({
	up,
	onRaise,
	onReact,
}: {
	up: boolean;
	onRaise: (up: boolean) => void;
	onReact: (what: Reaction) => void;
}) {
	const t = useT();

	const [open, setOpen] = useState(false);
	const { mounted, leaving } = useLingering(open, 160);

	return (
		<span className="relative flex items-center">
			{mounted && (
				<span
					className={cn(
						"-translate-x-1/2 absolute bottom-full left-1/2 mb-2 flex gap-0.5",
						"rounded-xl border border-border bg-surface-hi p-1 shadow-2xl ring-1 ring-black/40",
						"origin-bottom",
						leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					{REACTIONS.map((one) => (
						<button
							key={one}
							type="button"
							aria-label={one}
							onClick={() => {
								onReact(one);
								setOpen(false);
							}}
							className={cn(
								"rounded-lg px-2 py-1 text-lg leading-none",
								"transition-transform hover:scale-125 hover:bg-surface",
							)}
						>
							{one}
						</button>
					))}
				</span>
			)}

			<button
				type="button"
				aria-label={up ? t("Lower your hand") : t("Raise your hand")}
				onClick={() => onRaise(!up)}
				/* Held open by a second press on the caret rather than by this
				   one, so the common act — putting a hand up — is one press and
				   never opens anything. */
				onContextMenu={(event) => {
					event.preventDefault();
					setOpen((was) => !was);
				}}
				className={cn(
					"flex size-10 items-center justify-center rounded-l-full rounded-r-none",
					"transition-colors",
					up ? "bg-tally text-bg" : "bg-surface-hi text-fg hover:bg-surface",
				)}
			>
				<Hand className="size-4" />
			</button>

			<button
				type="button"
				aria-label={t("Reactions")}
				aria-expanded={open}
				onClick={() => setOpen((was) => !was)}
				className={cn(
					"flex h-10 items-center rounded-r-full rounded-l-none pr-2.5 pl-1 text-[11px]",
					"transition-colors",
					open ? "bg-surface text-fg" : "bg-surface-hi text-fg-muted hover:bg-surface hover:text-fg",
				)}
			>
				{"▴"}
			</button>
		</span>
	);
}
