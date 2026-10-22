import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import type { Phrase } from "@/live/i18n";
import type { ShareQuality } from "@/live/room";
import { type Hint, megabits } from "@/live/strain";
import { cn } from "@/lib/utils";
import { Gauge } from "lucide-react";

/**
 * The line cannot carry the share, said to the one person who can change that.
 *
 * Drawn only for whoever is sharing, and only once live/strain.ts is sure.
 * Above the controls rather than over the picture: the person reading this is
 * the person whose screen everybody else is looking at, and what is on their
 * own screen is not the share — it is whatever they are presenting, which this
 * must not sit in the middle of.
 *
 * Two answers and no third. The setting is applied only by pressing for it,
 * which is the whole difference between this and the follower that was taken
 * out; and "Not now" is for the rest of this share, because somebody who has
 * decided a stutter is the price of the picture they want has decided.
 */
export function ShareStrain({
	hint,
	leaving,
	busy,
	onSwitch,
	onDismiss,
}: {
	hint: Hint;
	/** On its way out: drawn for its exit and no longer pressable. */
	leaving?: boolean;
	/** The switch is being applied. */
	busy?: boolean;
	onSwitch: () => void;
	onDismiss: () => void;
}) {
	const t = useT();

	return (
		<section
			// Polite: it is news, but not news that should interrupt somebody
			// mid-sentence in a presentation.
			role="status"
			aria-live="polite"
			className={cn(
				"pointer-events-auto flex w-[min(24rem,100%)] flex-col gap-2.5 rounded-xl border border-border",
				"bg-surface/95 p-3 shadow-2xl backdrop-blur-md",
				leaving ? "animate-depart" : "animate-arrive",
			)}
		>
			<div className="flex items-start gap-2.5">
				<Gauge className="mt-0.5 size-4 shrink-0 text-tally" />
				<div className="flex min-w-0 flex-col gap-1">
					<p className="text-[12.5px] text-fg leading-snug">
						{t("Your connection is sending about {have} Mbps, and this share needs about {need} Mbps, so it stutters.", {
							have: megabits(hint.have),
							need: megabits(hint.need),
						})}
					</p>
					<p className="text-[12.5px] text-fg-muted leading-snug">
						{t("Switch to {size} at {rate} frames a second?", {
							size: t(SIZE_LABELS[hint.to.quality]),
							rate: String(hint.to.frameRate),
						})}
					</p>
				</div>
			</div>

			{/* The switch drawn as the one action, in the foreground colour; the
			    signal colour is spent on the mark above, because the thing
			    actually happening is the stutter, not the button. */}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="outline" size="sm" disabled={busy || leaving} onClick={onDismiss}>
					{t("Not now")}
				</Button>
				<Button type="button" variant="primary" size="sm" disabled={busy || leaving} onClick={onSwitch}>
					{t("Switch")}
				</Button>
			</div>
		</section>
	);
}

/** The sizes by the names the menu gives them, so the two say the same thing. */
const SIZE_LABELS: Record<ShareQuality, Phrase> = {
	auto: "Automatic",
	"1080p": "1080p",
	"1440p": "1440p",
	"4k": "4K",
};
