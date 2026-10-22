import { Invite, PublicLink } from "@/components/apps/Invite";
import { ANDROID_APP, Figures, MAC, type Offered, WINDOWS_APP } from "@/components/apps/shelves";
import { Button, buttonVariants } from "@/components/ui/button";
import { Phrased, useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import {
	type Offer,
	type Opened,
	appLink,
	asksAtOnce,
	download,
	downloadHref,
	downloadsByItself,
	launch,
	offerFor,
} from "@/live/landing";
import type { Platform } from "@/live/platform";
import { AppWindow, ArrowUpRight, Download, Loader2, Monitor, MoreHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Page } from "./PreJoin";

/**
 * The step in front of the join screen that offers the app. live/landing.ts
 * carries the argument for when it is shown and what it does; this is how it
 * looks and how it moves.
 *
 * One column in the join screen's frame — the same header, the same licence
 * at the foot — so that "Join in the browser" lands somewhere that is plainly
 * the same place one step on. The room the link is for, then what is happening
 * with the app, then the browser. Each state of the middle part replaces the
 * last by leaving and arriving, and the whole column leaves before the join
 * screen arrives, because a step that vanished between two frames would read
 * as the page having reloaded.
 */

/**
 * How long the app has to take over before it is taken not to have.
 *
 * Two seconds, which is what other meeting services wait too. An app that is
 * there takes the window within a fraction of that; a question from the
 * browser takes longer to answer, and is answered with the download already
 * under way, which costs somebody who has the app a file they did not need
 * rather than costing everybody without it a wait.
 */
const TAKES_OVER_WITHIN_MS = 2000;

/** How long a part of the page takes to leave. animate-depart's own length. */
const LEAVES_IN_MS = 180;

type Phase = "opening" | "opened" | "offer" | "in-app";

export interface LandingProps {
	/** The link the page was opened with. */
	link: Opened;
	/** The room it is for, as the address or the invitation names it. */
	room: string;
	/** What the server offers whoever holds the link. */
	offered: Offered;
	device: Platform;
	/** Whether the device is an iPad, for naming the app it is offered. */
	ipad: boolean;
	/** Inside an app's own browser, which opens no app and downloads nothing. */
	inApp: boolean;
	/** On to the join screen in this browser. */
	onBrowser: () => void;
}

export function Landing({ link, room, offered, device, ipad, inApp, onBrowser }: LandingProps) {
	const t = useT();

	// The iOS offer as the invitation form leaves it, which changes as
	// addresses are invited, or when the session behind the form turns out to
	// have ended.
	const [ios, setIOS] = useState(offered.ios);

	// Decided by the caller as well, which does not show this where there is
	// nothing to offer; asked again here so that a wrong caller draws the
	// browser alone rather than an offer of nothing.
	const offer = offerFor(device, { ...offered, ios });

	const [phase, setPhase] = useState<Phase>(() =>
		inApp ? "in-app" : asksAtOnce(device, inApp) && offer ? "opening" : "offer",
	);

	// Whether the download has been started for them, which is said.
	const [started, setStarted] = useState(false);
	const [leaving, setLeaving] = useState(false);

	const target = appLink(link, room);
	const path =
		offer?.kind === "android" ? ANDROID_APP.href : offer?.kind === "windows" ? WINDOWS_APP.href : MAC.href;
	const href = downloadHref(path, link);

	// Whatever is watching for the app, so that a second press or leaving the
	// page stops the first watch rather than letting two decide.
	const watching = useRef<() => void>(undefined);

	/*
	 * The offer, and on a Mac the download with it, once.
	 *
	 * Once because a second automatic download is a second file in somebody's
	 * downloads for one press; "Download again" is there for whoever wants it.
	 * Held in a ref as well as on screen, and the watch on the app stopped
	 * here: pressing "I don't have the app" inside the first two seconds left
	 * that watch running with a copy of this from before the press, and when
	 * the two seconds ran out it downloaded the app a second time, which
	 * Landing.test.tsx caught.
	 */
	const begun = useRef(false);

	const toOffer = useCallback(() => {
		watching.current?.();
		setPhase("offer");

		if (downloadsByItself(offer?.kind) && !begun.current) {
			begun.current = true;
			download(href);
			setStarted(true);
		}
	}, [offer?.kind, href]);

	/*
	 * Ask the app to open the link, and watch whether it does.
	 *
	 * Taken over is the page losing the screen: hidden, which is what a phone
	 * does when another app comes to the front, or the window losing focus,
	 * which is what a computer does. Focus is only asked of a page that had it
	 * to begin with — one opened behind another tab never had it to lose, and
	 * would otherwise read as taken over every time.
	 */
	const tryTheApp = useCallback(
		(otherwise: () => void) => {
			watching.current?.();

			const hadFocus = document.hasFocus();
			let left = false;

			const blurred = () => {
				left = true;
			};
			const hidden = () => {
				if (document.visibilityState === "hidden") left = true;
			};

			window.addEventListener("blur", blurred);
			document.addEventListener("visibilitychange", hidden);

			const stop = () => {
				clearTimeout(timer);
				window.removeEventListener("blur", blurred);
				document.removeEventListener("visibilitychange", hidden);
				if (watching.current === stop) watching.current = undefined;
			};

			const timer = setTimeout(() => {
				stop();

				const here = !left && document.visibilityState === "visible" && (!hadFocus || document.hasFocus());

				if (here) otherwise();
				else setPhase("opened");
			}, TAKES_OVER_WITHIN_MS);

			watching.current = stop;
			launch(target);
		},
		[target],
	);

	// On arrival, where the app is asked at once (see live/landing.ts for
	// where it is not). Once: a re-render must not ask again.
	const asked = useRef(false);
	useEffect(() => {
		if (asked.current || phase !== "opening") return;
		asked.current = true;

		tryTheApp(toOffer);
	}, [phase, tryTheApp, toOffer]);

	useEffect(() => () => watching.current?.(), []);

	const browser = () => {
		if (leaving) return;

		watching.current?.();
		setLeaving(true);
		setTimeout(onBrowser, LEAVES_IN_MS);
	};

	// The press that opens the app again, from any state but the first: after
	// installing it, or after it did not open. Staying where it is when the app
	// does not take over, since what is on screen is already the way on.
	const again = () => tryTheApp(() => {});

	const swap = useSwap(phase);

	const plain = phase === "in-app" || offer?.kind === "windows-soon" || offer === undefined;

	return (
		<Page>
			<div
				className={cn(
					"flex w-full max-w-md flex-col items-center gap-7 text-center",
					leaving ? "animate-depart" : "animate-rise",
				)}
			>
				<div className="flex flex-col items-center gap-4">
					{/*
					 * The app's own mark, large, in the place the camera
					 * preview has on the screen after this: the one thing the
					 * page is about. The glow is the lobby's, from underneath.
					 */}
					<div className="relative">
						<div
							aria-hidden
							className="-inset-6 absolute rounded-full bg-[radial-gradient(closest-side,var(--color-tally)_0%,transparent_100%)] opacity-[0.16]"
						/>
						<img src="/favicon.svg" alt="" className="relative size-16 rounded-[18px] shadow-2xl" />
					</div>

					<p className="text-[13px] text-fg-muted leading-snug">
						<Phrased
							phrase="You were invited to {room}."
							values={{ room: <span className="readout text-fg">{room}</span> }}
						/>
					</p>
				</div>

				<div
					key={swap.shown}
					className={cn("flex w-full flex-col items-center gap-3", swap.leaving ? "animate-depart" : "animate-arrive")}
				>
					{swap.shown === "opening" && (
						<State
							icon={<Loader2 className="size-5 animate-spin" />}
							title={t("Opening Tomoshibi…")}
							line={t("If your browser asks whether to open Tomoshibi, allow it.")}
						>
							<Actions>
								{/* Asked again, and offered at the end of this watch as at the
								    end of the first, which the press has replaced. */}
								<Button type="button" variant="primary" onClick={() => tryTheApp(toOffer)}>
									<AppWindow />
									{t("Open Tomoshibi")}
								</Button>
								<Button type="button" variant="ghost" onClick={toOffer}>
									{t("I don't have the app")}
								</Button>
							</Actions>
						</State>
					)}

					{swap.shown === "opened" && (
						<State
							icon={<AppWindow className="size-5" />}
							title={t("Continue in the Tomoshibi app.")}
							line={t("If it did not open, get the app, or join in the browser below.")}
						>
							<Actions>
								<Button type="button" variant="primary" onClick={again}>
									{t("Open Tomoshibi")}
								</Button>
								{offer && (
									<Button type="button" variant="ghost" onClick={toOffer}>
										{t("Get the app")}
									</Button>
								)}
							</Actions>
						</State>
					)}

					{swap.shown === "offer" && offer && (
						<Offering offer={offer} offered={offered} ipad={ipad} href={href} started={started} again={again}>
							{offer.kind === "ios-invite" && (
								<div className="flex w-full flex-col gap-2.5 text-left">
									{/* A session that ended under the form leaves somebody who
									    cannot be invited by address; the offer then becomes the
									    public link, or nothing, as it would have been for them. */}
									<Invite ios={ios} onChanged={setIOS} onSignedOut={() => setIOS({ ...ios, invites: false })} />
								</div>
							)}
						</Offering>
					)}

					{swap.shown === "in-app" && (
						<State
							icon={<MoreHorizontal className="size-5" />}
							title={t("Open this page in your browser")}
							line={t("The browser inside this app cannot open Tomoshibi or download it. Tap ⋯ at the top right, then choose to open the page in your browser.")}
						/>
					)}
				</div>

				{/*
				 * Always here, under everything, and never behind a step: the
				 * page is an offer. The main action where there is nothing else
				 * to do — inside an app's browser, or on a computer whose app is
				 * still to come.
				 */}
				<div className="flex w-full flex-col gap-2 border-border border-t pt-6">
					<Button type="button" variant={plain ? "primary" : "outline"} size="lg" className="w-full" onClick={browser}>
						{t("Join in the browser")}
					</Button>
				</div>
			</div>
		</Page>
	);
}

/** One state of the middle of the page: a mark, a heading, a line, and what to press. */
function State({ icon, title, line, children }: { icon: ReactNode; title: string; line?: ReactNode; children?: ReactNode }) {
	return (
		<>
			<span className="flex size-10 items-center justify-center rounded-full bg-surface-hi text-fg">{icon}</span>
			<h1 className="text-balance font-semibold text-[19px] tracking-tight">{title}</h1>
			{line && <p className="max-w-sm text-pretty text-[13px] text-fg-muted leading-relaxed">{line}</p>}
			{children}
		</>
	);
}

/** Buttons side by side where they fit, one above the other where they do not. */
function Actions({ children }: { children: ReactNode }) {
	return <div className="mt-1 flex w-full flex-col items-stretch gap-2 min-[400px]:flex-row min-[400px]:justify-center">{children}</div>;
}

/**
 * The app for this device, as the server offered it.
 *
 * The Mac's has started downloading by the time this is drawn and says so,
 * with the way to start it again; a phone's is a button, and so is Windows',
 * for the reasons given in live/landing.ts. Every one ends with the way back into the app once it is
 * installed, because the link has to reach the app for the app to open the
 * meeting, and coming back to this page and pressing is how it gets there.
 */
function Offering({
	offer,
	offered,
	ipad,
	href,
	started,
	again,
	children,
}: {
	offer: Offer;
	offered: Offered;
	ipad: boolean;
	href: string;
	started: boolean;
	again: () => void;
	children?: ReactNode;
}) {
	const t = useT();

	const reopen = (
		<div className="flex w-full flex-col items-center gap-2 pt-1">
			<Button type="button" variant="secondary" className="w-full" onClick={again}>
				<AppWindow />
				{t("Open Tomoshibi")}
			</Button>
			<p className="text-pretty text-[11.5px] text-fg-muted leading-snug">{t("Once it is installed, press Open Tomoshibi to join in the app.")}</p>
		</div>
	);

	switch (offer.kind) {
		case "mac":
			return (
				<State icon={<MAC.icon className="size-5" />} title={t("Get the Mac app")} line={<Figures build={offered.mac} />}>
					{started && (
						<div
							role="status"
							className="animate-arrive flex w-full items-center gap-2.5 rounded-lg bg-surface px-3 py-2.5 text-left"
						>
							<Download className="size-4 shrink-0 text-tally" />
							<p className="min-w-0 text-[12.5px] text-fg leading-snug">{t("Your download has started.")}</p>
						</div>
					)}

					<p className="text-pretty text-[12px] text-fg-muted leading-snug">{t(MAC.install)}</p>

					{/* A real link, so that it is also what a press on it would have
					    been: the browser's own download, named by the server. */}
					<a href={href} download className={cn(buttonVariants({ variant: started ? "ghost" : "primary" }), "w-full")}>
						<Download />
						{started ? t("Download again") : t(MAC.take)}
					</a>

					{reopen}
				</State>
			);

		case "android":
			return (
				<State
					icon={<ANDROID_APP.icon className="size-5" />}
					title={t("Get the Android app")}
					line={<Figures build={offered.android} />}
				>
					<a href={href} download className={cn(buttonVariants({ variant: "primary", size: "lg" }), "w-full")}>
						<Download />
						{t(ANDROID_APP.take)}
					</a>

					<p className="text-pretty text-[11.5px] text-fg-muted leading-snug">{t(ANDROID_APP.install)}</p>
					{ANDROID_APP.caution && (
						<p className="text-pretty text-[11.5px] text-fg-muted leading-snug">{t(ANDROID_APP.caution)}</p>
					)}

					{reopen}
				</State>
			);

		case "ios-link":
			return (
				<State
					icon={<ArrowUpRight className="size-5" />}
					title={ipad ? t("Get the iPad app") : t("Get the iPhone app")}
					line={t("For iPhone and iPad, through TestFlight.")}
				>
					<PublicLink link={offer.link} prominent />
					{reopen}
				</State>
			);

		case "ios-invite":
			return (
				<State
					icon={<ArrowUpRight className="size-5" />}
					title={ipad ? t("Get the iPad app") : t("Get the iPhone app")}
					line={t("For iPhone and iPad, through TestFlight.")}
				>
					{children}
					{reopen}
				</State>
			);

		case "windows":
			return (
				<State
					icon={<WINDOWS_APP.icon className="size-5" />}
					title={t("Get the Windows app")}
					line={<Figures build={offered.windows} />}
				>
					<a href={href} download className={cn(buttonVariants({ variant: "primary" }), "w-full")}>
						<Download />
						{t(WINDOWS_APP.take)}
					</a>

					{/* Both warnings said before the press that leads to them, so
					    that each reads as the step it was said to be. */}
					<p className="text-pretty text-[11.5px] text-fg-muted leading-snug">{t(WINDOWS_APP.install)}</p>
					{WINDOWS_APP.caution && (
						<p className="text-pretty text-[11.5px] text-fg-muted leading-snug">{t(WINDOWS_APP.caution)}</p>
					)}

					{reopen}
				</State>
			);

		case "windows-soon":
			return (
				<State
					icon={<Monitor className="size-5" />}
					title={t("The Windows app is coming soon.")}
					line={t("Until then, meetings work in this browser.")}
				/>
			);
	}
}

/**
 * The state on screen, and whether it is on its way out: a change of state is
 * the old one leaving and then the new one arriving, rather than one replaced
 * by the other between two frames.
 */
function useSwap<T>(value: T): { shown: T; leaving: boolean } {
	const [shown, setShown] = useState(value);
	const [leaving, setLeaving] = useState(false);

	useEffect(() => {
		if (Object.is(value, shown)) return;

		setLeaving(true);

		const timer = setTimeout(() => {
			setShown(value);
			setLeaving(false);
		}, LEAVES_IN_MS);

		return () => clearTimeout(timer);
	}, [value, shown]);

	return { shown, leaving };
}
