import { CircleAlert, Megaphone, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FOLD_EASE, FOLD_MS } from "@/components/Folding";
import { SteadyText } from "@/components/Steady";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { deployment } from "@/live/api";
import { LOCALES, type Locale, locale } from "@/live/i18n";
import {
	closedHere,
	closeNotice,
	lastLearned,
	type NoticeKind,
	noticeText,
	type SiteNotice as Notice,
	stillUp,
	useSiteNotice,
} from "@/live/notice";

/** How soon the page asks again when it comes back to the front. */
const SOONEST = 60_000;
let lastAsked = 0;

/**
 * A notice at the top of its screen: the sign-in page's above the sign-in, the
 * lobby's above the lobby, as the apps show theirs (live/notice.ts says why
 * there are two and how each reaches the page).
 *
 * The lobby's is asked for again as the lobby appears, unless the server was
 * asked a moment ago: the server tells it only to a caller signed in, and the
 * answer the page read when it loaded was read before the sign-in that brought
 * somebody here.
 *
 * Asked again when the tab comes back to the front, at most once a minute, as
 * the apps ask when they come to the front: a page left open in a tab would
 * otherwise go on showing a notice taken down, and never show one published
 * since. Gone at its end without asking, by a timer, so a notice that ends
 * while the page is open leaves when it ends.
 */
/** A notice's room opens and closes as everything else that folds does. */
const NOTICE_FOLD_MS = FOLD_MS;

export function SiteNotice({ kind }: { kind: NoticeKind }) {
	const t = useT();
	const notice = useSiteNotice(kind);

	useEffect(() => {
		if (kind !== "lobby" || Date.now() - lastLearned() < 3000) return;
		lastAsked = Date.now();
		void deployment();
	}, [kind]);
	const [closed, setClosed] = useState<string>();
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const back = () => {
			if (document.visibilityState !== "visible" || Date.now() - lastAsked < SOONEST) return;
			lastAsked = Date.now();
			void deployment();
		};
		document.addEventListener("visibilitychange", back);
		return () => document.removeEventListener("visibilitychange", back);
	}, []);

	const until = notice?.until;
	useEffect(() => {
		if (!until) return;
		const end = Date.parse(until);
		if (Number.isNaN(end)) return;
		// A timer cannot wait longer than about 24.8 days; one that would is
		// set again when it fires.
		const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(end - Date.now(), 0) + 50, 2 ** 31 - 1));
		return () => clearTimeout(timer);
	}, [until]);

	const words = notice ? noticeText(notice, locale()) : undefined;
	const open = Boolean(notice && words && stillUp(notice, now) && closed !== notice.id && !closedHere(kind, notice.id));
	const { mounted, leaving } = useLingering(open, NOTICE_FOLD_MS);

	// A notice already up when the screen is first drawn is simply there; one
	// that arrives later, or leaves, opens and closes its own room, so the page
	// below moves down and back up rather than jumping by its height in one
	// frame, which the owner saw as the page hopping.
	const growing = useRef(!open);
	if (!mounted) growing.current = true;
	// Clipped only while its room opens or closes: at rest the clip would cut
	// off the card's shadow.
	const [settled, setSettled] = useState(open);
	useEffect(() => {
		if (!mounted || leaving) {
			setSettled(false);
			return;
		}
		const timer = setTimeout(() => setSettled(true), NOTICE_FOLD_MS);
		return () => clearTimeout(timer);
	}, [mounted, leaving]);

	// What was last shown, so that a notice taken down or closed leaves with
	// its own words rather than blinking empty on the way out.
	const shown = useRef<{ notice: Notice; words: string }>(undefined);
	if (open && notice && words) shown.current = { notice, words };
	if (!mounted || !shown.current) return null;

	const { notice: drawn } = shown.current;
	const allSaid = Object.fromEntries(
		LOCALES.map((language) => [language, noticeText(drawn, language)]).filter(([, words]) => words !== undefined),
	) as Partial<Record<Locale, string>>;
	const warning = drawn.level === "warning";

	/*
	 * Drawn as the apps draw it (LobbyNoticeCard.swift), so that one notice
	 * looks the same wherever it is read: a round badge in the person's colour
	 * with a megaphone for something to know, and in the colour and symbol the
	 * product says a problem in for a warning; the words; a round close; on a
	 * card that floats a little above the page. The owner found the first one
	 * here ugly: a grey info sign on a flat strip, nothing like the apps'.
	 */
	return (
		<div
			className={cn(
				"grid motion-reduce:transition-none!",
				leaving ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
				growing.current && "starting:grid-rows-[0fr]",
			)}
			style={{ transition: `grid-template-rows ${NOTICE_FOLD_MS}ms ${FOLD_EASE}` }}
		>
			<div className={cn("min-h-0", settled && !leaving ? "overflow-visible" : "overflow-hidden")}>
				<section
					role="status"
					aria-label={kind === "lobby" ? t("Lobby notice") : t("Sign-in page notice")}
					className={cn(
						"mb-4 flex items-start gap-3 rounded-[20px] border bg-surface py-3 pr-2.5 pl-3.5",
						"shadow-[0_8px_24px_-8px_rgb(0_0_0/0.18)]",
						leaving ? "animate-notice-out" : "animate-notice-in",
						warning ? "border-danger/45" : "border-border",
					)}
				>
					<span
						aria-hidden
						className={cn(
							"grid size-[30px] shrink-0 place-items-center rounded-full",
							warning ? "bg-danger/18 text-danger-ink" : "bg-tally/18 text-tally-ink",
						)}
					>
						{warning ? <CircleAlert className="size-4" strokeWidth={2.4} /> : <Megaphone className="size-3.5" strokeWidth={2.4} />}
					</span>

					{/* Balanced, so a phone does not leave the last character of a
					    Chinese line alone on the next: at 375 the notice broke as
					    "...正在寻找替代方" over "案". */}
					<p className="flex min-h-[30px] min-w-0 flex-1 items-center whitespace-pre-line break-words text-pretty text-[13.5px] text-fg leading-snug">
						{/* In every language it was written in, at the size of the
					    longest, so that changing the language does not change
					    the notice's height and move the page below it (Steady). */}
					<SteadyText texts={allSaid} block />
					</p>

					<button
						type="button"
						onClick={() => {
							closeNotice(kind, drawn.id);
							setClosed(drawn.id);
						}}
						aria-label={t("Dismiss")}
						className={cn(
							"pressable mt-0.5 grid size-[26px] shrink-0 place-items-center rounded-full bg-surface-hi text-fg-muted outline-none",
							"hover:bg-wash hover:text-fg focus-visible:ring-2 focus-visible:ring-fg/70 pointer-coarse:size-8",
						)}
					>
						<X className="size-3.5" strokeWidth={2.4} />
					</button>
				</section>
			</div>
		</div>
	);
}
