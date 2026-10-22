import { Invite, PublicLink, TESTFLIGHT } from "@/components/apps/Invite";
import {
	ANDROID_APP,
	type Build,
	Figures,
	I_OS,
	type IOSOffer,
	MAC,
	NOTHING,
	type Offered,
	type Shelf,
	WINDOWS,
	WINDOWS_APP,
	offers,
} from "@/components/apps/shelves";
import { LanguagePicker } from "@/components/room/LanguagePicker";
import { Button, buttonVariants } from "@/components/ui/button";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { type Platform, platform } from "@/live/platform";
import {
	ArrowLeft,
	ChevronDown,
	Download,
	ExternalLink,
	type LucideIcon,
	Monitor,
	Smartphone,
	UserRound,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { SignIn } from "./Account";

/**
 * The native apps, for somebody signed in.
 *
 * Part of the account page's document rather than a page of its own, because it
 * is behind the same door: an app handed to whoever found the address would be
 * handed to everybody, and a TestFlight invitation is a tester counted against
 * the app's ceiling and a mail sent in its name. Somebody who arrives signed out
 * is asked to sign in by the same form, told why in a line of its own.
 *
 * Four platforms. The Mac, Android and Windows apps are each a file this
 * server hands over, and are drawn by one card and one row told which platform
 * they are for (Shelf, below), so that they cannot come to say different things
 * about the same answer: a version, a size, a download, a line on installing
 * it, and the warning the system will show on the way, where it shows one.
 *
 * Windows without a build is still drawn, as a place kept: so that the page did
 * not change shape on the day its app arrived, and so that somebody looking for
 * it learns it is coming rather than that it was forgotten. That card is not a
 * link and not a button, because a press on something that goes nowhere reads
 * as the page being broken. With a build it is the same card as the others.
 *
 * The reader's own platform comes first, where the browser says which it is
 * (live/platform.ts), at full size and with everything its card offers; the
 * rest follow under "Other platforms" as one-line rows, each with its action
 * made small rather than taken away — a download link, an invitation form that
 * opens in place, or the word that it is coming. Smaller rather than hidden,
 * because the guess is a guess: an iPad asking for the desktop site is a Mac
 * until it is not, and somebody choosing an app for a different device than
 * the one they are holding is an ordinary thing to do. Where nothing can be
 * guessed the page is the four cards in their usual order, none promoted.
 *
 * The server says what is offered, and the page draws nothing it was not told:
 * a Mac, Android or Windows build only where one is whole on disk, an invitation form
 * only where App Store Connect has been given a key, and the beta's public link
 * only where there is no key and there is a link. Everything else says it is
 * not available yet, which is the truth, rather than offering a link that fails.
 *
 * What the page shares with the step an invitation opens in a browser — the
 * builds' descriptions, the words around each download, the invitation form —
 * is in components/apps, so the two cannot come to say different things.
 */

export function Apps() {
	const t = useT();
	const [offered, setOffered] = useState<Offered>();
	const [signedOut, setSignedOut] = useState(false);

	// Read once. A layout that moved under somebody because their browser
	// answered differently a second time would be worse than a wrong guess.
	const [guessed] = useState(platform);

	const look = useCallback(async () => {
		try {
			const response = await fetch("/api/apps", { credentials: "same-origin" });

			if (response.status === 401) {
				setSignedOut(true);
				return;
			}

			setSignedOut(false);
			setOffered(response.ok ? ((await response.json()) as Offered) : NOTHING);
		} catch {
			// A server that cannot be reached cannot be asked who is signed in
			// either. The page is drawn with nothing offered, which says so,
			// rather than a sign-in form that would fail for the same reason.
			setSignedOut(false);
			setOffered(NOTHING);
		}
	}, []);

	useEffect(() => {
		void look();
	}, [look]);

	// The tab says where it is, in the page's language, and follows the picker.
	useEffect(() => {
		document.title = `Tomoshibi · ${t("Get the apps")}`;
	}, [t]);

	if (signedOut) {
		return (
			<SignIn
				onIn={look}
				icon={Download}
				title={t("Get the apps")}
				lead={t("Sign in to download Tomoshibi for Mac, Windows, iPhone, iPad and Android.")}
			/>
		);
	}

	if (!offered) return <div className="min-h-full bg-bg" />;

	const phone: PhoneProps = {
		ios: offered.ios,
		onChanged: (ios) => setOffered((was) => (was ? { ...was, ios } : was)),
		onSignedOut: () => setSignedOut(true),
	};

	return (
		<div className="relative min-h-full overflow-x-hidden bg-bg">
			{/*
			 * The lobby's glow, high and behind everything. The page is a short
			 * column on a dark field, which is the lobby's problem as well, and
			 * the same answer gives it a top.
			 */}
			<div
				aria-hidden
				className={cn(
					"pointer-events-none absolute inset-x-0 top-0 h-[45vh]",
					"bg-[radial-gradient(60%_100%_at_50%_0%,var(--color-tally)_0%,transparent_70%)]",
					"opacity-[0.07]",
				)}
			/>

			<main className="relative mx-auto flex max-w-lg flex-col gap-4 p-5 text-fg sm:p-6">
				<nav className="animate-rise flex items-center gap-2">
					<a
						href="/"
						className={cn(
							"flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5",
							"text-[12px] text-fg-muted transition-colors hover:bg-surface-hi hover:text-fg",
						)}
					>
						<ArrowLeft className="size-3.5" />
						{t("Back to meetings")}
					</a>

					<div className="ml-auto flex items-center gap-1">
						<a
							href="/account"
							aria-label={t("Your account")}
							className={cn(
								"flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5",
								"text-[12px] text-fg-muted transition-colors hover:bg-surface-hi hover:text-fg",
							)}
						>
							<UserRound className="size-3.5" />
							<span className="max-[400px]:hidden">{t("Your account")}</span>
						</a>

						<LanguagePicker />
					</div>
				</nav>

				<header className="animate-rise flex flex-col gap-1 pt-2 [animation-delay:60ms]">
					<h1 className="font-semibold text-[22px] tracking-tight">{t("Get the apps")}</h1>
					<p className="text-[13px] text-fg-muted leading-relaxed">
						{t("Tomoshibi on your own devices, for the account you are signed in to here.")}
					</p>
				</header>

				{guessed ? (
					<Promoted guessed={guessed} offered={offered} phone={phone} />
				) : (
					<>
						<div className="animate-rise [animation-delay:120ms]">
							<Downloaded shelf={MAC} build={offered.mac} />
						</div>

						<div className="animate-rise [animation-delay:180ms]">
							<Phone {...phone} />
						</div>

						<div className="animate-rise [animation-delay:240ms]">
							<Downloaded shelf={ANDROID_APP} build={offered.android} />
						</div>

						<div className="animate-rise [animation-delay:300ms]">
							{offers(offered.windows) ? (
								<Downloaded shelf={WINDOWS_APP} build={offered.windows} />
							) : (
								<Soon icon={Monitor} name={WINDOWS} />
							)}
						</div>
					</>
				)}
			</main>
		</div>
	);
}

/** A platform's card: its mark, its name, a line under it, and what it offers. */
function Card({
	icon: Icon,
	name,
	detail,
	live,
	children,
}: {
	icon: LucideIcon;
	name: string;
	detail: ReactNode;
	live: boolean;
	children: ReactNode;
}) {
	return (
		<section aria-label={name} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
			<div className="flex items-center gap-3.5">
				{/* Amber only where there is something to take: the one colour
				    that means something is happening, on the one thing here that
				    is. */}
				<span
					className={cn(
						"flex size-10 shrink-0 items-center justify-center rounded-lg",
						live ? "bg-tally/15 text-tally" : "bg-surface-hi text-fg-muted",
					)}
				>
					<Icon className="size-5" />
				</span>

				<div className="flex min-w-0 flex-col gap-0.5">
					<h2 className="font-medium text-[14px]">{name}</h2>
					<span className="text-[12px] text-fg-muted leading-snug">{detail}</span>
				</div>
			</div>

			{children}
		</section>
	);
}

/** A line saying something is not on offer, in the shape the reserved cards use. */
function NotYet({ children }: { children: ReactNode }) {
	return (
		<p className="animate-arrive rounded-lg border border-border border-dashed px-3 py-2.5 text-[12px] text-fg-muted leading-snug">
			{children}
		</p>
	);
}

/** An app handed over as a file, at full size: the Mac's, Android's, or Windows' once it has a build. */
function Downloaded({ shelf, build }: { shelf: Shelf; build: Build }) {
	const t = useT();
	const available = offers(build);

	return (
		<Card
			icon={shelf.icon}
			name={shelf.name}
			live={available}
			detail={available ? <Figures build={build} /> : t(shelf.meant)}
		>
			{available ? (
				<>
					{/*
					 * An anchor rather than a button that fetches: the browser's own
					 * download is the one that shows progress, resumes, and lands in
					 * the folder somebody expects. The session cookie goes with it
					 * because it is this origin, and the server names the file.
					 */}
					<a href={shelf.href} download className={cn(buttonVariants({ variant: "primary" }), "w-full")}>
						<Download />
						{t(shelf.take)}
					</a>

					<p className="text-[11.5px] text-fg-muted leading-snug">{t(shelf.install)}</p>
					{shelf.caution && <p className="text-[11.5px] text-fg-muted leading-snug">{t(shelf.caution)}</p>}
				</>
			) : (
				<NotYet>{t(shelf.missing)}</NotYet>
			)}
		</Card>
	);
}

/**
 * The iOS app, by TestFlight invitation (components/apps/Invite.tsx has the
 * form and what it does with each answer).
 *
 * Or by the beta's public link, where this deployment cannot invite anybody by
 * address but has one: an account is invited by address so that the testers
 * are people the deployment can name, and where that cannot be done the link
 * is better than a card saying nothing is offered.
 */
interface PhoneProps {
	ios: IOSOffer;
	onChanged: (ios: IOSOffer) => void;
	onSignedOut: () => void;
}

function Phone(props: PhoneProps) {
	const t = useT();
	const { ios } = props;

	return (
		<Card
			icon={Smartphone}
			name={I_OS}
			live={ios.invites ? ios.left > 0 : Boolean(ios.link)}
			detail={t("For iPhone and iPad, through TestFlight.")}
		>
			{ios.invites ? (
				<Invite {...props} />
			) : ios.link ? (
				<PublicLink link={ios.link} />
			) : (
				<NotYet>{t("TestFlight invitations are not set up on this server yet.")}</NotYet>
			)}
		</Card>
	);
}

/**
 * A platform with a place kept for it: Windows, until it has a build. Nothing
 * here can be pressed.
 *
 * Laid out as the cards above it are, mark beside name, because it has the
 * column's width to itself: a tile stretched that wide is a card with its mark
 * floating over nothing.
 */
function Soon({ icon: Icon, name }: { icon: LucideIcon; name: string }) {
	const t = useT();

	return (
		<section
			aria-label={name}
			className="flex items-center gap-3.5 rounded-xl border border-border border-dashed p-4 text-fg-muted"
		>
			<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface/60">
				<Icon className="size-5 opacity-70" />
			</span>

			<div className="flex min-w-0 flex-col gap-0.5">
				<h2 className="font-medium text-[14px] text-fg/80">{name}</h2>
				<span className="silk text-fg-muted/80">{t("Coming soon")}</span>
			</div>
		</section>
	);
}

/**
 * The order the platforms are listed in, wherever none is promoted out of it.
 * Windows last, where it was kept a place before it had an app, so that it is
 * where anybody who looked for it before will look again.
 */
const ORDER: readonly Platform[] = ["mac", "ios", "android", "windows"];

/**
 * The reader's platform at full size, and every other one under it as a row.
 *
 * The rows keep each platform's action and make it small: nothing a card can do
 * becomes unreachable because the guess put another card first.
 */
function Promoted({ guessed, offered, phone }: { guessed: Platform; offered: Offered; phone: PhoneProps }) {
	const t = useT();
	const others = ORDER.filter((one) => one !== guessed);

	return (
		<>
			<div className="animate-rise [animation-delay:120ms]">
				{guessed === "mac" && <Downloaded shelf={MAC} build={offered.mac} />}
				{guessed === "ios" && <Phone {...phone} />}
				{guessed === "android" && <Downloaded shelf={ANDROID_APP} build={offered.android} />}
				{guessed === "windows" &&
					(offers(offered.windows) ? (
						<Downloaded shelf={WINDOWS_APP} build={offered.windows} />
					) : (
						<SoonCard icon={Monitor} name={WINDOWS} />
					))}
			</div>

			<section aria-labelledby="other-platforms" className="animate-rise flex flex-col gap-2 pt-2 [animation-delay:180ms]">
				<h2 id="other-platforms" className="px-1 font-medium text-[11px] text-fg-muted uppercase tracking-wide">
					{t("Other platforms")}
				</h2>

				<ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
					{others.map((one) => (
						<li key={one}>
							{one === "mac" && <DownloadedRow shelf={MAC} build={offered.mac} />}
							{one === "ios" && <PhoneRow {...phone} />}
							{one === "android" && <DownloadedRow shelf={ANDROID_APP} build={offered.android} />}
							{one === "windows" &&
								(offers(offered.windows) ? (
									<DownloadedRow shelf={WINDOWS_APP} build={offered.windows} />
								) : (
									<SoonRow icon={Monitor} name={WINDOWS} />
								))}
						</li>
					))}
				</ul>
			</section>
		</>
	);
}

/**
 * One platform as a row: a small mark, the name, one line, and the action at
 * the end. The mark stays in the muted colour whatever is on offer, so that the
 * card above is the one amber thing on the page.
 */
function Row({
	icon: Icon,
	name,
	line,
	action,
	children,
}: {
	icon: LucideIcon;
	name: string;
	line?: ReactNode;
	action?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div role="group" aria-label={name} className="flex flex-col gap-3 px-4 py-3">
			<div className="flex items-center gap-3">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-hi text-fg-muted">
					<Icon className="size-4" />
				</span>

				<div className="flex min-w-0 flex-1 flex-col">
					<h3 className="font-medium text-[13px]">{name}</h3>
					{line && <span className="text-[11.5px] text-fg-muted leading-snug">{line}</span>}
				</div>

				{action && <div className="shrink-0">{action}</div>}
			</div>

			{children}
		</div>
	);
}

/** An app handed over as a file, as a row: the version, and the same download made small. */
function DownloadedRow({ shelf, build }: { shelf: Shelf; build: Build }) {
	const t = useT();
	const available = offers(build);

	return (
		<Row
			icon={shelf.icon}
			name={shelf.name}
			line={available ? <Figures build={build} /> : t(shelf.missing)}
			action={
				available && (
					<a href={shelf.href} download className={buttonVariants({ variant: "outline", size: "sm" })}>
						<Download />
						{t("Download")}
					</a>
				)
			}
		/>
	);
}

/**
 * iOS, as a row: the invitation form folded away behind a small button, and the
 * same form when it opens.
 *
 * Left open once it has been opened, even when the last invitation used the
 * account's allowance and there is no more to send: what came of it is on the
 * form, and folding it away with the answer inside would hide the one thing
 * somebody needs to read next.
 */
function PhoneRow(props: PhoneProps) {
	const t = useT();
	const { ios } = props;
	const [open, setOpen] = useState(false);
	const body = useLingering(open);
	const offers = ios.invites && ios.left > 0;

	return (
		<Row
			icon={Smartphone}
			name={I_OS}
			line={
				!ios.invites
					? ios.link
						? t("For iPhone and iPad, through TestFlight.")
						: t("TestFlight invitations are not set up on this server yet.")
					: ios.left > 0
						? t("For iPhone and iPad, through TestFlight.")
						: t("This account has invited as many addresses as one account may.")
			}
			action={
				!ios.invites && ios.link ? (
					<a
						href={ios.link}
						target="_blank"
						rel="noreferrer"
						className={buttonVariants({ variant: "outline", size: "sm" })}
					>
						{TESTFLIGHT}
						<ExternalLink />
					</a>
				) : (
					(offers || open) && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							aria-expanded={open}
							aria-controls="invite-in-row"
							onClick={() => setOpen(!open)}
						>
							{t("Invite by email")}
							<ChevronDown className={cn("transition-transform duration-200", open && "rotate-180")} />
						</Button>
					)
				)
			}
		>
			{body.mounted && ios.invites && (
				<div
					id="invite-in-row"
					className={cn("flex flex-col gap-3", body.leaving ? "animate-depart" : "animate-arrive")}
				>
					<Invite {...props} />
				</div>
			)}
		</Row>
	);
}

/** Windows without a build, as a row. Nothing in it can be pressed. */
function SoonRow({ icon, name }: { icon: LucideIcon; name: string }) {
	const t = useT();

	return <Row icon={icon} name={name} action={<span className="silk text-fg-muted/80">{t("Coming soon")}</span>} />;
}

/**
 * Windows without a build, guessed as the reader's platform and so drawn at
 * full size. Still nothing to press; what there is to say is that it is
 * coming, and that meetings do not wait for it.
 */
function SoonCard({ icon, name }: { icon: LucideIcon; name: string }) {
	const t = useT();

	return (
		<Card icon={icon} name={name} live={false} detail={<span className="silk">{t("Coming soon")}</span>}>
			<NotYet>{t("Until then, meetings work in this browser.")}</NotYet>
		</Card>
	);
}

