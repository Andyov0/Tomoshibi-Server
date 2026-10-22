import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { ipad, platform } from "@/live/platform";
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
 */
export function GetTheApp({ className }: { className?: string }) {
	const t = useT();

	// Read once, like the download page's own guess: a label that changed under
	// somebody because the browser answered differently a second time would be
	// worse than a generic one.
	const [guessed] = useState(platform);
	const [onIPad] = useState(ipad);

	const said: { icon: LucideIcon; title: string; line: string } =
		guessed === "ios"
			? {
					icon: Smartphone,
					title: onIPad ? t("Get the iPad app") : t("Get the iPhone app"),
					line: t("For iPhone and iPad, through TestFlight."),
				}
			: guessed === "mac"
				? { icon: Laptop, title: t("Get the Mac app"), line: t("For your Mac.") }
				: guessed === "android"
					? { icon: TabletSmartphone, title: t("Get the Android app"), line: t("For Android 10 or later.") }
					: { icon: Download, title: t("Get the apps"), line: t("For Mac, Windows, iPhone, iPad and Android.") };

	const Icon = said.icon;

	return (
		<a
			href="/apps"
			className={cn(
				"group flex items-center gap-3.5 rounded-xl border border-border bg-surface p-4",
				"outline-none transition-colors hover:border-fg/20 hover:bg-surface-hi/40",
				"focus-visible:ring-2 focus-visible:ring-fg/40",
				className,
			)}
		>
			<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-hi text-fg">
				<Icon className="size-5" />
			</span>

			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span data-entry-label className="font-medium text-[14px] text-fg">
					{said.title}
				</span>
				{/* Balanced rather than filled, so a phone does not leave the
				    last character of a Chinese line alone on the next: at 375
				    the iPhone line broke as "...TestFlight 安" over "装。". */}
				<span className="text-pretty text-[12px] text-fg-muted leading-snug">{said.line}</span>
			</span>

			<ChevronRight className="size-4 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5" />
		</a>
	);
}
