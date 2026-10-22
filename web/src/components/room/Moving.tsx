import { useT } from "@/hooks/useT";
import { useLingering } from "@/hooks/useLingering";
import { cn } from "@/lib/utils";
import { say } from "@/live/i18n";
import { Loader2 } from "lucide-react";

/**
 * What a call being moved to another machine looks like from a chair.
 *
 * A move ends the call. There is no message in the protocol that asks a browser
 * to move — it holds a connection to the machine it dialled — so the only way
 * anybody arrives somewhere else is by arriving again, and everybody in the room
 * is disconnected and comes straight back.
 *
 * The coming back has always worked. What it looked like was being thrown out:
 * the room came down, the join screen appeared, and the call returned a few
 * seconds later. Somebody watching that would say the meeting ended, because
 * from where they sat it did.
 *
 * So the room does not come down. This is drawn over whatever is underneath for
 * the two or three seconds it takes, and it says what is happening and where to
 * — the server has always sent the destination and the client used to discard
 * it. Being told "moving to Tokyo" is being told what happened. A blank join
 * screen is being told nothing.
 *
 * Nothing here can be pressed and nothing is offered. It is not a question.
 */
export function Moving({ to }: { to?: string }) {
	const t = useT();
	const { mounted, leaving } = useLingering(to !== undefined);

	if (!mounted) return null;

	// The name the picker would have used, where the server named one. A move
	// with no destination is still a move, and saying so without a name is
	// better than saying nothing.
	const named = to?.trim() ? say(to.trim()) : "";

	return (
		<div
			className={cn(
				"pointer-events-none fixed inset-0 z-50 grid place-items-center",
				"bg-bg/80 backdrop-blur-sm",
				leaving ? "animate-depart" : "animate-arrive",
			)}
			// Announced, because the screen going quiet for three seconds is
			// exactly the moment somebody using a reader needs telling.
			role="status"
			aria-live="polite"
		>
			<div className="flex flex-col items-center gap-3 px-6 text-center">
				<Loader2 className="size-5 animate-spin text-fg-muted" />

				<p className="font-medium text-fg text-sm">
					{named ? t("Moving this meeting to {name}", { name: named }) : t("Moving this meeting")}
				</p>

				{/* The one thing worth saying about it: nobody has to do
				    anything. A person who thinks they have been disconnected
				    reaches for the join button, and the join button is not
				    there. */}
				<p className="text-fg-muted text-xs">{t("You will be back in a moment.")}</p>
			</div>
		</div>
	);
}
