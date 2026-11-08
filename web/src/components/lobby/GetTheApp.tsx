import { Steady } from "@/components/Steady";
import type { Phrase } from "@/live/i18n";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { ipad, platform } from "@/live/platform";
import { LINUX_APP } from "@/components/apps/shelves";
import { ChevronRight, Download, Laptop, type LucideIcon, Smartphone, TabletSmartphone } from "lucide-react";
import { useState } from "react";

/**
 * The way to the native apps, from the lobby and from the account page.
 *
 * A card in the column rather than a button in the corner. It was a button in
 * the corner, and then on a phone a line of muted text under everything, and
 * the owner found neither: the corner is where somebody's own controls are,
 * read only by somebody looking for them, and the line sat below the server
 * globe, a whole screen down on a phone. A card is read on the way down the
 * page, at every width, in the one place, so the phone and the desktop cannot
 * come to offer it differently. What keeps it from competing with starting a
 * meeting is the same thing that keeps "Join" below "Start": a muted mark
 * rather than the amber one, no button of its own, and its place after the
 * meeting cards rather than among them.
 *
 * It names the app for the device the browser says it is on, from the same
 * guess the download page uses, because "the iPhone app" is something
 * somebody holding an iPhone recognises as theirs and "the apps" is not. Where
 * there is no useful guess — Windows has no app yet, and an unknown agent could
 * be anything — it offers the apps in general. Android's mark is the one its
 * card on the download page has, so the card leads somewhere that looks like
 * where it said it would.
 *
 * `compact` is the same way in, drawn small for the line the lobby's greeting
 * is on, at the right of the content rather than in the page's corner, where a
 * wide screen with two blocks puts it: as a card it was a fourth row under the
 * meeting's three, which the servers' card beside them had to match, and the
 * lobby no longer fitted a laptop's window. A phone keeps the card, last, as
 * the owner chose.
 */
export function GetTheApp({ className, compact = false }: { className?: string; compact?: boolean }) {
	const t = useT();

	// Read once, like the download page's own guess: a label that changed under
	// somebody because the browser answered differently a second time would be
	// worse than a generic one.
	const [guessed] = useState(platform);
	const [onIPad] = useState(ipad);

	// Phrases rather than words, so that each is drawn at the size of its
	// longest language (Steady) and choosing one does not resize the card.
	const said: { icon: LucideIcon; title: Phrase; line: Phrase } =
		guessed === "ios"
			? {
					icon: Smartphone,
					title: onIPad ? "Get the iPad app" : "Get the iPhone app",
					line: "For iPhone and iPad, through TestFlight.",
				}
			: guessed === "mac"
				? { icon: Laptop, title: "Get the Mac app", line: "For your Mac." }
				: guessed === "android"
					? { icon: TabletSmartphone, title: "Get the Android app", line: "For Android 10 or later." }
					: guessed === "linux"
						? { icon: LINUX_APP.icon, title: "Get the Linux app", line: LINUX_APP.meant }
						: { icon: Download, title: "Get the apps", line: "For Mac, Windows, Linux, iPhone, iPad and Android." };

	const Icon = said.icon;

	if (compact) {
		return (
			<a
				href="/apps"
				title={t(said.line)}
				className={cn(
					"group inline-flex shrink-0 items-center gap-2 rounded-full border border-border bg-surface py-1 pr-3 pl-1",
					"outline-none transition-colors hover:border-fg/20 hover:bg-surface-hi/40",
					"focus-visible:ring-2 focus-visible:ring-fg/40",
					className,
				)}
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-hi text-fg">
					<Icon className="size-4" />
				</span>
				<span data-entry-label className="font-medium text-[13px] text-fg">
					<Steady phrase={said.title} />
				</span>
				<ChevronRight className="size-3.5 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5" />
			</a>
		);
	}

	return (
		<a
			href="/apps"
			className={cn(
				"group flex items-center gap-3.5 rounded-[18px] border border-border bg-surface p-4",
				"outline-none transition-colors hover:border-fg/20 hover:bg-surface-hi/40",
				"focus-visible:ring-2 focus-visible:ring-fg/40",
				className,
			)}
		>
			<span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-surface-hi text-fg">
				<Icon className="size-5" />
			</span>

			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span data-entry-label className="font-medium text-[14px] text-fg">
					<Steady phrase={said.title} />
				</span>
				{/* Balanced rather than filled, so a phone does not leave the
				    last character of a Chinese line alone on the next: at 375
				    the iPhone line broke as "...TestFlight 安" over "装。". */}
				<Steady phrase={said.line} block className="text-pretty text-[12px] text-fg-muted leading-snug" />
			</span>

			<ChevronRight className="size-4 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5" />
		</a>
	);
}
