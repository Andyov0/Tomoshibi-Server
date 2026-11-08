import { FOLD_MS, Unfolding } from "@/components/Folding";
import { WhenField, readLocal } from "@/components/WhenField";
import { Steady } from "@/components/Steady";
import { CORNER } from "@/components/corner";
import { GetTheApp } from "@/components/lobby/GetTheApp";
import { LanguagePicker } from "@/components/room/LanguagePicker";
import { Button } from "@/components/ui/button";
import { useHumanCheck } from "@/components/ui/human-check";
import { Input } from "@/components/ui/input";
import { useLingering } from "@/hooks/useLingering";
import { useWideScreen } from "@/hooks/useWideScreen";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { type Placement, placement, remember as rememberPlacement } from "@/live/controls";
import { rememberedDucking, setDucking, subscribeDuck } from "@/live/duck";
import { locale, t as say } from "@/live/i18n";
import { lockedUntil, shutOutFor } from "@/live/lockout";
import { whenSaid } from "@/live/meeting";
import { MAX_SCOPE, normaliseRoomName, validRoomName, validScope } from "@/live/names";
import { actionDone, actionFailed } from "@/live/notices";
import { humanCheckSaid, reasonOf } from "@/live/turnstile";
import {
	type MusicQuality,
	WATCH_QUALITIES,
	type WatchQuality,
	blurWanted,
	deviceChoice,
	forgetDeviceChoice,
	rememberBlur,
	rememberDevices,
	rememberMusicQuality,
	rememberWatchQuality,
	rememberedDevices,
	rememberedMusicQuality,
	watchQuality,
} from "@/live/preferences";
import { DEFAULTS, PERMISSIONS, PERMISSION_NAMES, type Permission } from "@/manage/grants";
import {
	ArrowLeft,
	CalendarClock,
	Camera,
	Check,
	ChevronDown,
	Clapperboard,
	Copy,
	DoorOpen,
	Film,
	Link2,
	Link2Off,
	Loader2,
	LogOut,
	type LucideIcon,
	Music,
	Shield,
	Trash2,
	UserRound,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Somebody's own account: who they are here, what they may use, how their calls
 * start, their picture, their passphrase, and the links they may make into their
 * scopes' rooms.
 *
 * This page used to say it held a passphrase, a picture and links and nothing
 * else, and that the restraint was the design. The argument for it still holds
 * and still draws the line; what moved is what falls on this side of it.
 * Everything that belongs to the deployment — the relays, the rooms, who else
 * may be here, who may use what — belongs to whoever runs it, and a page that
 * grew a second column for some people and not others would be one mistake away
 * from showing the wrong person the wrong thing. Nothing here changes any of
 * that, for anybody, and nothing here shows anybody else.
 *
 * Two things came across it. What an account may use stopped being the same for
 * everybody, and somebody whose music button has gone deserves to be able to
 * find out why without asking — so the page reads it back to them, from the
 * same answer that tells it who they are. It is read-only and it is only theirs.
 * And the choices that shape a call — which devices start on, where the
 * controls sit, how sharp a film may get — could only be made from inside one,
 * at the moment they were wrong. They are this browser's rather than the
 * account's (see live/preferences.ts for why), so the page writes them where the
 * call reads them, and the server never sees them.
 *
 * The links are the one thing here that reaches past the account, and they are
 * here because they are the account's: being in a scope is what lets somebody
 * let a guest into its rooms, and the person doing it is usually not in a call
 * at the time — they are sending next Tuesday's client a link today.
 *
 * The passphrase is not stored anywhere and cannot be recovered. That is worth
 * saying on the page, because the first thing anybody does when they forget one
 * is look for the button that sends it to them, and there is none to find: an
 * administrator sets a new one instead.
 */
interface Me {
	name: string;
	trip: string;
	avatar?: string;
	created?: string;
	/** Whether they also run the deployment, so the way there can be offered. */
	admin?: boolean;
	/** The groups they belong to, whose rooms they may send links into. */
	scopes?: string[];
	/**
	 * What they may use, so the page can say so and not offer what would be
	 * refused. Like the two above it authorises nothing: every endpoint it
	 * names asks the store again. Absent only from a server older than
	 * permissions, which gave everybody what an account now starts with.
	 */
	can?: string[];
}

/** Whether they hold a permission, by what the server said. */
function holds(me: Me, permission: Permission): boolean {
	return me.can ? me.can.includes(permission) : DEFAULTS[permission];
}

export function Account() {
	const [me, setMe] = useState<Me>();
	const [asking, setAsking] = useState(true);

	const identify = useCallback(async () => {
		try {
			const response = await fetch("/api/account/me", { credentials: "same-origin" });
			setMe(response.ok ? ((await response.json()) as Me) : undefined);
		} catch {
			setMe(undefined);
		} finally {
			setAsking(false);
		}
	}, []);

	useEffect(() => {
		void identify();
	}, [identify]);

	if (asking) return <div className="min-h-full bg-bg" />;
	if (!me) return <SignIn onIn={identify} />;

	return <Signed me={me} onChanged={setMe} />;
}

/**
 * The page for somebody signed in, laid out as the lobby is.
 *
 * It was one column 464 pixels wide, nine cards from the way back to the note
 * under the passphrase, 1186 pixels tall at every width: a laptop scrolled
 * through it, and a large monitor left most of itself empty either side. The
 * owner asked for it to be laid out again, as the lobby had been, in two
 * blocks on one screen: who they are on the left (the account, what it may
 * use, its passphrase), and this browser and the people they let in on the
 * right (the apps, the settings, the guest links). One column on a phone, in
 * the order the visits come for: the account and its picture, the passphrase,
 * then the rest, the apps last as in the lobby.
 *
 * The two blocks line up at the top and the bottom, which the owner asked of
 * the lobby: the last card of the shorter block takes up what is left, and
 * keeps what it holds at its top with its button at its foot.
 */
function Signed({ me, onChanged }: { me: Me; onChanged: (me: Me | undefined) => void }) {
	const t = useT();
	const links = holds(me, "invite") && (me.admin || (me.scopes?.length ?? 0) > 0);

	// The settings unfold within the right block and lengthen it. The left
	// block holds the height it had meanwhile, at the top, rather than its
	// last card being stretched to the open settings and back as they close,
	// which is what the owner saw in the lobby and asked not to see again.
	const [settingsOpen, setSettingsOpen] = useState(false);
	const settling = useLingering(settingsOpen, FOLD_MS + 40).mounted || settingsOpen;
	const wide = useWideScreen();
	const [left, setLeft] = useState<HTMLElement | null>(null);
	const [leftHeight, setLeftHeight] = useState(0);
	useEffect(() => {
		if (!left || settling) return;
		const read = () => {
			if (left.offsetHeight > 0) setLeftHeight(left.offsetHeight);
		};
		read();
		const observer = new ResizeObserver(read);
		observer.observe(left);
		return () => observer.disconnect();
	}, [left, settling]);
	const holding = wide && settling && leftHeight > 0;

	// A block of its own on a wide screen; on a phone nothing, so that its
	// cards are one column with the other block's, in the order each gives.
	const block = "contents md:flex md:min-w-0 md:flex-col md:gap-4";
	const fills = "md:flex md:flex-1 md:flex-col";

	const passphrase = (
		<div className={cn("animate-rise order-2 md:order-none", fills)}>
			<Passphrase />
		</div>
	);

	return (
		<main className="relative grid min-h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] overflow-x-clip bg-bg text-fg">
			{/*
			 * The header the lobby has, across the page: the way back first, as
			 * it always was here, since this is a page somebody arrives at, does
			 * one thing on and leaves; and the console, signing out and the
			 * language in the corner, the same buttons in the same places as on
			 * the lobby. They were small outlined links inside the column.
			 */}
			<header className="animate-rise z-10 flex items-center justify-between gap-2 p-5 sm:gap-4 sm:p-6">
				<div className="flex min-w-0 items-center gap-3">
					<a href="/" className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-fg/70">
						<img src="/favicon.svg" alt="" className="size-5 rounded-[5px]" />
						<span className="font-semibold text-[13px] tracking-tight max-[420px]:sr-only">Tomoshibi</span>
					</a>

					<a
						href="/"
						className={cn(CORNER, "border-border text-fg-muted hover:bg-wash hover:text-fg active:bg-wash-press")}
					>
						<ArrowLeft className="size-3.5" />
						<Steady phrase="Back to meetings" />
					</a>
				</div>

				<div className="flex items-center gap-2">
					{me.admin && (
						<a
							href="/admin"
							aria-label={t("Admin console")}
							className={cn(CORNER, "border-tally/30 bg-tally/10 text-fg hover:bg-tally/20 active:bg-tally/25")}
						>
							<Shield className="size-3.5 text-tally-ink" />
							<Steady phrase="Admin console" className="hidden sm:inline-grid" />
						</a>
					)}

					<button
						type="button"
						onClick={async () => {
							await fetch("/api/account/session", { method: "DELETE", credentials: "same-origin" });
							onChanged(undefined);
						}}
						aria-label={t("Sign out")}
						title={t("Sign out")}
						className={cn(
							CORNER,
							"w-8 justify-center border-border px-0 text-fg-muted hover:bg-wash hover:text-fg active:bg-wash-press pointer-coarse:w-11",
						)}
					>
						<LogOut className="size-3.5" />
					</button>

					<LanguagePicker />
				</div>
			</header>

			{/* Placed by the window's height and not by what is in it, as the
			    lobby is (Lobby Frame says why): the settings unfolding, or a
			    link being made, grow the page below its top and never move it. */}
			<div className="z-10 flex items-start justify-center px-5 pb-16 sm:px-6 md:pb-6">
				<div className="w-full max-w-lg pt-1 md:max-w-[54rem] md:pt-[max(1rem,calc((100vh-5rem-36rem)*0.4))]">
					<div className="flex flex-col gap-4 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-x-6">
						<div
							ref={setLeft}
							style={holding ? { height: leftHeight } : undefined}
							className={cn(block, holding && "md:sticky md:top-4 md:self-start")}
						>
							<div className="animate-rise order-1 md:order-none">
								<Identity me={me} onChanged={(changed) => onChanged(changed)} />
							</div>

							<div className={cn("animate-rise order-3 md:order-none", !links && fills)}>
								<Abilities me={me} />
							</div>

							{links && passphrase}
						</div>

						<div className={block}>
							{/* The same card the lobby has, so the two pages offer
							    the apps in one way; last on a phone, as there. */}
							<div className="animate-rise order-6 md:order-none">
								<GetTheApp />
							</div>

							<div className="animate-rise order-4 md:order-none">
								<Settings me={me} onOpenChange={setSettingsOpen} />
							</div>

							{/* Only for somebody who can use it: an account given
							    standing links, and in a scope to send them into. An
							    administrator belongs to every scope and may type
							    any; anybody else is offered the ones on their
							    account, and an account with none has no rooms to
							    send anybody into. The server asks both questions
							    again. Without them the passphrase is the last card
							    here, so the two blocks stay near one height. */}
							{links ? (
								<div className={cn("animate-rise order-5 md:order-none", fills)}>
									<GuestLinks me={me} />
								</div>
							) : (
								passphrase
							)}
						</div>
					</div>
				</div>
			</div>
		</main>
	);
}

/**
 * Asking somebody signed out to sign in, for this page and for the download
 * page, which is the same document and the same session.
 *
 * The heading and the line under it are the caller's, because somebody who
 * followed a link to the apps should be told why they are being asked, in the
 * place they are being asked; everything else is one form, so the two pages
 * cannot come to sign people in differently.
 */
export function SignIn({
	onIn,
	title,
	lead,
	icon: Icon = UserRound,
}: {
	onIn: () => void;
	title?: string;
	lead?: string;
	icon?: LucideIcon;
}) {
	const t = useT();
	const [name, setName] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const [busy, setBusy] = useState(false);
	const check = useHumanCheck("sign-in");

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();

		if (busy || !check.ready) return;

		setBusy(true);

		try {
			const response = await fetch("/api/account/session", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify(
					check.token ? { name, passphrase, turnstile: check.token } : { name, passphrase },
				),
			});

			if (!response.ok) {
				const refused = await signInRefused(response);

				// The passphrase is kept where only the human check failed: it
				// was never looked at, and clearing it would be asking for it
				// again for nothing.
				if (!refused.human) setPassphrase("");

				throw new Error(refused.said);
			}

			onIn();
		} catch (err) {
			// The notice fades: a refused attempt is something that happened,
			// not something still true. And the human check starts again, since
			// the token just sent is spent whatever the answer was.
			actionFailed(err instanceof Error ? err.message : String(err));
			check.reset();
		} finally {
			setBusy(false);
		}
	};

	return (
		<main className="relative grid min-h-full place-items-center bg-bg p-6 text-fg">
			{/* Before signing in as well as after: somebody handed an account in
			    a language the browser guessed wrongly meets this form first. */}
			<div className="animate-rise absolute top-4 right-4">
				<LanguagePicker />
			</div>

			<form onSubmit={submit} className="animate-rise flex w-full max-w-sm flex-col gap-4">
				<header className="flex flex-col items-center gap-2 text-center">
					<Icon className="size-8 text-fg-muted" />
					<h1 className="font-semibold text-xl tracking-tight">{title ?? t("Your account")}</h1>
					<p className="text-fg-muted text-sm">{lead ?? t("Sign in to change your passphrase or picture.")}</p>
				</header>

				<Input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder={t("Name")}
					aria-label={t("Name")}
					autoComplete="username"
					// biome-ignore lint/a11y/noAutofocus: the page exists to be typed into
					autoFocus
					maxLength={32}
				/>

				<Input
					type="password"
					value={passphrase}
					onChange={(event) => setPassphrase(event.target.value)}
					placeholder={t("Passphrase")}
					aria-label={t("Passphrase")}
					autoComplete="current-password"
					maxLength={200}
				/>

				{check.widget}

				<Button type="submit" variant="primary" size="lg" disabled={busy || !name || !passphrase || !check.ready}>
					{busy ? <Loader2 className="size-4 animate-spin" /> : t("Sign in")}
				</Button>
			</form>
		</main>
	);
}

/**
 * What a refused sign-in says, and whether the human check is what refused it.
 *
 * A lockout says how long it has left, and is read first: the server answers a
 * caller shut out before it asks anything else, the human check included, so
 * a lockout is the whole of what is true about that attempt. It is also read
 * from a copy of the body (lockedUntil), and the reason below from the body
 * itself, which can be read once; the other way round, the lockout's end
 * would never be found. Then the human check's three refusals, in its own
 * sentences, the one case where the passphrase was never looked at. A
 * guessing budget's own refusal, which names no end, says to wait a moment;
 * it used to say the name and passphrase did not go together, which sent
 * somebody who had typed them correctly to type them again. Anything else is
 * the pair not going together, which is all this page has ever said about a
 * wrong name or a wrong passphrase, and all it should: saying which would be
 * telling a stranger which names exist.
 */
async function signInRefused(response: Response): Promise<{ said: string; human: boolean }> {
	const until = await lockedUntil(response);
	if (until) return { said: shutOutFor(until), human: false };

	const human = humanCheckSaid(await reasonOf(response));
	if (human) return { said: human, human: true };

	if (response.status === 429) return { said: say("Too many attempts. Try again in a moment."), human: false };

	return { said: say("That name and passphrase do not go together."), human: false };
}

/**
 * Who they are, and the picture they are shown with: one card, where it was
 * the name in a header and the picture in a card of its own two cards further
 * down, so that the picture beside the name and the way to change it were
 * apart. Signing out is in the corner of the page, as on the lobby.
 */
function Identity({ me, onChanged }: { me: Me; onChanged: (me: Me) => void }) {
	return (
		<section className="flex h-full flex-col gap-3 rounded-[18px] border border-border bg-surface p-4">
			<div className="flex items-center gap-3.5">
				<Face me={me} />

				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate font-medium text-[15px] text-fg">{me.name}</span>
					{/* The signature, which is the public half of an account and
					    the thing that proves a name in a room. Shown here because
					    this is the one page where somebody has a reason to read
					    their own. */}
					<span className="readout text-fg-muted text-[12px]">{me.trip}</span>
				</div>
			</div>

			<Picture me={me} onChanged={onChanged} />
		</section>
	);
}

function Face({ me }: { me: Me }) {
	if (me.avatar) {
		return <img src={me.avatar} alt="" className="size-14 shrink-0 rounded-full object-cover" />;
	}

	return (
		<span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-surface-hi text-[18px] text-fg-muted">
			{me.name.slice(0, 1).toUpperCase()}
		</span>
	);
}

/**
 * Choosing a picture.
 *
 * Scaled and re-encoded here rather than sent as it was chosen. A photograph off
 * a phone is several megabytes of a thing that will be drawn at forty-eight
 * pixels, and uploading it whole would mean holding it, serving it, and backing
 * it up forever for a picture nobody will ever see at that size.
 */
function Picture({ me, onChanged }: { me: Me; onChanged: (me: Me) => void }) {
	const t = useT();
	const file = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);

	const send = async (image: string | null) => {
		setBusy(true);

		try {
			const response = await fetch("/api/account/avatar", {
				method: image ? "PUT" : "DELETE",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: image ? JSON.stringify({ image }) : undefined,
			});

			if (!response.ok) throw new Error(t("That picture could not be used."));

			// Re-read rather than patched, and with a fresh query so the browser
			// does not show the picture it already had under the same address.
			const updated = (await response.json()) as Me;
			onChanged({ ...updated, avatar: updated.avatar ? `${updated.avatar}?${Date.now()}` : undefined });
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2 border-border border-t pt-3">
			{/* Not "Picture", which is the share menu's word for the picture's
			    quality and is translated as that: this card read 画質 in
			    Japanese and 画面 in Chinese. */}
			{/* For a screen reader only: the picture is beside it, and the
			    heading over a single button was most of the card's height. */}
			<h2 className="sr-only">{t("Profile picture")}</h2>

			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<div className="flex gap-2">
					<input
						ref={file}
						type="file"
						accept="image/*"
						className="hidden"
						onChange={async (event) => {
							const chosen = event.target.files?.[0];
							event.target.value = "";

							if (!chosen) return;

							try {
								await send(await shrink(chosen));
							} catch {
								actionFailed(t("That picture could not be used."));
							}
						}}
					/>

					<button
						type="button"
						disabled={busy}
						onClick={() => file.current?.click()}
						className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi disabled:opacity-40"
					>
						{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
						<Steady phrase="Choose a picture" />
					</button>

					{me.avatar && (
						<button
							type="button"
							disabled={busy}
							onClick={() => void send(null)}
							className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-surface-hi hover:text-danger-ink disabled:opacity-40"
						>
							<Trash2 className="size-3.5" />
							<Steady phrase="Remove" />
						</button>
					)}
				</div>

				<p className="min-w-0 flex-1 basis-48 text-fg-muted text-[11.5px] leading-snug">
					<Steady phrase="Shown beside your name in a call. Scaled down before it is sent." block />
				</p>
			</div>
		</div>
	);
}

/** The icon beside each permission, chosen to match the button it opens in a call. */
const PERMISSION_ICONS: Record<Permission, LucideIcon> = {
	watch: Clapperboard,
	emby: Film,
	music: Music,
	arrange: CalendarClock,
	invite: Link2,
	open: DoorOpen,
};

/**
 * What this account may use, read back to the person holding it.
 *
 * Read-only, and from the same answer that says who they are, which is a
 * courtesy and not an authority: every feature it names asks again on its own.
 * The names are the ones the management pages tick, so that "an administrator
 * gave me Music" and what this page says are the same word.
 *
 * What they were not given is listed too, apart, because a button that is
 * missing in a call reads as a fault until somebody can see it was a decision.
 * Except Emby. It is the one permission that spends the deployment's money and
 * is given to people one at a time, and a page listing it to everybody who does
 * not have it would be an advertisement for asking.
 */
function Abilities({ me }: { me: Me }) {
	const t = useT();
	const held = PERMISSIONS.filter((one) => holds(me, one));
	const withheld = PERMISSIONS.filter((one) => one !== "emby" && !holds(me, one));
	const scopes = me.scopes ?? [];
	const since = me.created ? dateSaid(me.created) : "";

	return (
		<section className="flex h-full flex-col gap-2 rounded-[18px] border border-border bg-surface p-4">
			<h2 className="font-medium text-fg text-sm">{t("What you can use")}</h2>
			<p className="text-fg-muted text-[11.5px]"><Steady phrase="Set by whoever runs this deployment." block /></p>

			{held.length > 0 && (
				<ul aria-label={t("What you can use")} className="mt-1 flex flex-wrap gap-1.5">
					{held.map((one) => (
						<Ability key={one} permission={one} />
					))}
				</ul>
			)}

			{withheld.length > 0 && (
				<div className="mt-1 flex flex-col gap-1.5">
					<span className="text-fg-muted text-[11px]"><Steady phrase="Not opened to this account" /></span>
					<ul aria-label={t("Not opened to this account")} className="flex flex-wrap gap-1.5">
						{withheld.map((one) => (
							<Ability key={one} permission={one} withheld />
						))}
					</ul>
				</div>
			)}

			{/* The account's own facts, which the server always sent and this
			    page never showed: the scopes only appeared as the choices in
			    the link form below, and not at all to somebody who may not make
			    links. */}
			{(scopes.length > 0 || since) && (
				<dl className="mt-auto grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 border-border border-t pt-3 text-[12px]">
					{scopes.length > 0 && (
						<>
							<dt className="text-fg-muted"><Steady phrase="Your scopes" className="justify-items-start" /></dt>
							<dd className="flex flex-wrap gap-1">
								{scopes.map((scope) => (
									<span key={scope} className="readout rounded bg-surface-hi px-1.5 py-0.5 text-[11px]">
										@{scope}
									</span>
								))}
							</dd>
						</>
					)}

					{since && (
						<>
							<dt className="text-fg-muted"><Steady phrase="Account created" className="justify-items-start" /></dt>
							<dd className="text-fg">{since}</dd>
						</>
					)}
				</dl>
			)}
		</section>
	);
}

function Ability({ permission, withheld = false }: { permission: Permission; withheld?: boolean }) {
	const Icon = PERMISSION_ICONS[permission];

	return (
		<li
			className={cn(
				"flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]",
				withheld
					? "border-border border-dashed text-fg-muted"
					: permission === "emby"
						? "border-tally/40 bg-tally/10 text-fg"
						: "border-border bg-surface-hi text-fg",
			)}
		>
			<Icon className={cn("size-3.5", withheld ? "text-fg-muted/60" : permission === "emby" ? "text-tally-ink" : "text-fg-muted")} />
			<Steady phrase={PERMISSION_NAMES[permission]} />
		</li>
	);
}

/** A day, in the reader's language, or nothing for something that is not one. */
function dateSaid(at: string): string {
	const when = new Date(at);
	if (Number.isNaN(when.getTime())) return "";

	return when.toLocaleDateString(locale(), { year: "numeric", month: "long", day: "numeric" });
}

/**
 * How this browser's calls start and look.
 *
 * Folded away until opened. Most visits to this page are for the passphrase or
 * the picture, and five groups of switches between the top of the page and the
 * passphrase form put it below the fold on a phone for everybody, to save a
 * press for somebody who comes here to change a setting once.
 *
 * Every switch writes as it is pressed. These are the same keys the call reads,
 * and a save button would be a second place for the page and the call to
 * disagree. Nothing is sent anywhere: see live/preferences.ts.
 */
function Settings({ me, onOpenChange }: { me: Me; onOpenChange?: (open: boolean) => void }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	useEffect(() => onOpenChange?.(open), [open, onOpenChange]);

	return (
		<section className="flex flex-col rounded-[18px] border border-border bg-surface">
			<button
				type="button"
				aria-expanded={open}
				aria-controls="account-settings"
				onClick={() => setOpen(!open)}
				className={cn(
					"flex items-start gap-3 rounded-[18px] p-4 text-left outline-none transition-colors hover:bg-surface-hi/40 focus-visible:ring-2 focus-visible:ring-fg/40",
					open && "rounded-b-none",
				)}
			>
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium text-fg text-sm">{t("Settings")}</span>
					<span className="text-fg-muted text-[11.5px]">
						<Steady phrase="How your calls start and look, in this browser. Another browser or device keeps its own." block />
					</span>
				</span>
				<ChevronDown
					aria-hidden
					className={cn("mt-0.5 size-4 shrink-0 text-fg-muted transition-transform duration-200", open && "rotate-180")}
				/>
			</button>

			{/* Unfolding from the card's head, as the lobby's arranging form
			    does, rather than appearing whole below it. */}
			<Unfolding open={open}>
				<div id="account-settings" className="flex flex-col gap-5 border-border border-t px-4 pt-4 pb-4">
					<WhenJoining />
					<WhereControls />
					<MusicSettings me={me} />
					<WatchSettings />
				</div>
			</Unfolding>
		</section>
	);
}

function WhenJoining() {
	const t = useT();
	const [devices, setDevices] = useState(rememberedDevices);
	const [blurring, setBlurring] = useState(blurWanted);
	const [picked, setPicked] = useState(() => Object.keys(deviceChoice()).length > 0);
	const forgettable = useLingering(picked);

	const change = (next: typeof devices) => {
		setDevices(next);
		rememberDevices(next);
	};

	return (
		<Group label={t("When you join")}>
			<Tick checked={devices.microphone} onChange={(on) => change({ ...devices, microphone: on })}>
				{t("Start with the microphone on")}
			</Tick>
			<Tick checked={devices.camera} onChange={(on) => change({ ...devices, camera: on })}>
				{t("Start with the camera on")}
			</Tick>
			<Tick
				checked={blurring}
				onChange={(on) => {
					setBlurring(on);
					rememberBlur(on);
				}}
			>
				{t("Blur my background")}
			</Tick>

			{/* Only while there is something to forget. The devices are picked in
			    a call, where they are listed by name; here there is nothing to
			    pick them from without asking for the camera, so the page offers
			    only the way back to the browser's own defaults. */}
			{forgettable.mounted && (
				<div
					className={cn(
						"mt-1 flex items-center gap-3 rounded-md bg-surface-hi px-3 py-2",
						forgettable.leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<p className="min-w-0 flex-1 text-fg-muted text-[11.5px] leading-snug">
						{t("Calls start on the microphone, camera and speakers you last picked in one, while they are plugged in.")}
					</p>
					<button
						type="button"
						onClick={() => {
							forgetDeviceChoice();
							setPicked(false);
						}}
						className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:bg-surface hover:text-fg"
					>
						{t("Forget")}
					</button>
				</div>
			)}
		</Group>
	);
}

function WhereControls() {
	const t = useT();
	const [where, setWhere] = useState<Placement>(placement);

	return (
		<Group label={t("Controls")}>
			<Options<Placement>
				label={t("Controls")}
				value={where}
				options={[
					["always", t("Always shown")],
					["idle", t("Hide when nothing is happening")],
					["side", t("At the side")],
				]}
				onChange={(next) => {
					setWhere(next);
					rememberPlacement(next);
				}}
			/>
		</Group>
	);
}

/**
 * Music in a call.
 *
 * Lowering it under speech is the listener's choice, and somebody who may not
 * open the library still hears whatever another person plays, so it is offered
 * to everybody. The library's quality is only ever used by somebody fetching
 * from it, and is offered only to them.
 */
function MusicSettings({ me }: { me: Me }) {
	const t = useT();
	const ducks = useSyncExternalStore(subscribeDuck, rememberedDucking, rememberedDucking);
	const [quality, setQuality] = useState<MusicQuality>(rememberedMusicQuality);
	const large = useLingering(quality === "best");

	return (
		<Group label={t("Music")}>
			<Tick checked={ducks} onChange={setDucking}>
				{t("Lower the music while anybody talks")}
			</Tick>

			{holds(me, "music") && (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-fg-muted text-[11.5px]">{t("Quality")}</span>
						<Options<MusicQuality>
							label={t("Quality")}
							value={quality}
							options={[
								["lossless", t("Lossless")],
								["best", t("Highest")],
							]}
							onChange={(next) => {
								setQuality(next);
								rememberMusicQuality(next);
							}}
						/>
					</div>

					{large.mounted && (
						<p
							className={cn(
								"text-fg-muted text-[11px]",
								large.leaving ? "animate-depart" : "animate-arrive",
							)}
						>
							{t("Hi-Res and masters are large, and take longer to start.")}
						</p>
					)}
				</>
			)}
		</Group>
	);
}

/**
 * How sharp a video watched together may get, here.
 *
 * Offered to everybody, whether or not they may start a showing: it is about
 * what this screen fetches, and everybody in the room is a viewer.
 */
function WatchSettings() {
	const t = useT();
	const [quality, setQuality] = useState<WatchQuality>(watchQuality);
	const capped = useLingering(quality !== "auto");

	const said: Record<WatchQuality, string> = {
		auto: t("Automatic"),
		"1080p": t("1080p"),
		"720p": t("720p"),
	};

	return (
		<Group label={t("Watch together")}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-fg-muted text-[11.5px]">{t("Picture quality")}</span>
				<Options<WatchQuality>
					label={t("Picture quality")}
					value={quality}
					options={WATCH_QUALITIES.map((one) => [one, said[one]] as const)}
					onChange={(next) => {
						setQuality(next);
						rememberWatchQuality(next);
					}}
				/>
			</div>

			{capped.mounted && (
				<p className={cn("text-fg-muted text-[11px]", capped.leaving ? "animate-depart" : "animate-arrive")}>
					{t("Where a video comes in several qualities, it is never fetched sharper than this here. It applies from the next video you open.")}
				</p>
			)}
		</Group>
	);
}

/** A heading and what is under it, as one group for a screen reader. */
function Group({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div role="group" aria-label={label} className="flex flex-col gap-2">
			<h3 className="font-medium text-[11px] text-fg-muted uppercase tracking-wide">{label}</h3>
			{children}
		</div>
	);
}

function Tick({
	checked,
	onChange,
	children,
}: { checked: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
	return (
		<label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-fg leading-snug">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				className="mt-0.5 size-3.5 shrink-0 accent-tally"
			/>
			{children}
		</label>
	);
}

/** One of a few, pressed rather than picked from a list, as in the music panel. */
function Options<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: readonly (readonly [T, string])[];
	onChange: (next: T) => void;
}) {
	return (
		<div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
			{options.map(([which, said]) => (
				<button
					key={which}
					type="button"
					aria-pressed={value === which}
					onClick={() => onChange(which)}
					className={cn(
						"rounded-md border px-2.5 py-1 text-[12px] transition-colors",
						value === which
							? "border-tally/50 bg-tally/15 text-fg"
							: "border-border text-fg-muted hover:bg-surface-hi hover:text-fg",
					)}
				>
					{said}
				</button>
			))}
		</div>
	);
}

function Passphrase() {
	const t = useT();
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();

		if (busy) return;

		setBusy(true);

		try {
			const response = await fetch("/api/account/passphrase", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ current, next }),
			});

			if (!response.ok) {
				const reason = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(explain(reason.error));
			}

			setCurrent("");
			setNext("");
			setDone(true);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={submit} className="flex h-full flex-col gap-2 rounded-[18px] border border-border bg-surface p-4">
			<h2 className="font-medium text-fg text-sm">{t("Passphrase")}</h2>
			<p className="text-fg-muted text-[11.5px]">
				<Steady phrase="This is how you are recognised, in a call and here. At least eight characters." block />
			</p>

			{/* Side by side where there is room for both, which is a line less
			    on the account page's left block. */}
			<div className="mt-1 grid gap-2 sm:grid-cols-2">
				<Input
					type="password"
					value={current}
					onChange={(event) => setCurrent(event.target.value)}
					placeholder={t("Current passphrase")}
					aria-label={t("Current passphrase")}
					autoComplete="current-password"
				/>

				<Input
					type="password"
					value={next}
					onChange={(event) => setNext(event.target.value)}
					placeholder={t("New passphrase")}
					aria-label={t("New passphrase")}
					autoComplete="new-password"
				/>
			</div>

			{/* At the foot, so that where this card is the one stretched to the
			    other block's height, the space opens above the button rather
			    than below it. */}
			<div className="mt-auto flex items-center gap-3 pt-1">
				<button
					type="submit"
					disabled={busy || !current || next.length < 8}
					className={cn(
						"flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px]",
						"hover:bg-surface-hi disabled:opacity-40",
					)}
				>
					{busy && <Loader2 className="size-3.5 animate-spin" />}
					<Steady phrase="Change it" />
				</button>

				{done && <span className="text-[11.5px] text-fg-muted">{t("Changed.")}</span>}
			</div>

			{/* Under the form it is about, inside its card; it was a line of its
			    own at the foot of the page. */}
			<p className="text-fg-muted text-[11.5px] leading-relaxed">
				<Steady phrase="Your passphrase is not stored here and cannot be sent to you. If you lose it, an administrator sets a new one." block />
			</p>
		</form>
	);
}

/**
 * Making a link that lets somebody outside a scope into one of its rooms.
 *
 * Three things to say, all optional: the name the guest will wear, when the link
 * starts working, and when it stops. Leaving the end empty is a link that works
 * until somebody stops it, which is what a client who comes every week wants
 * and what a single call does not — so the line under the result says which
 * one was made, in the reader's clock.
 *
 * The times are typed into the browser's own picker and sent as instants. A
 * time with no zone is a time in a zone somebody guessed, and the guest the
 * link is for may be in another one.
 *
 * Stopping is here as well as making, for the same reason the links are: ending
 * a meeting does not take its links with it, so keeping somebody out of the
 * next one is something a member does from here, possibly days later. It stops
 * every link to the room, whoever made it, which is what the server does and
 * what the button says.
 */
function GuestLinks({ me }: { me: Me }) {
	const t = useT();
	const mine = me.scopes ?? [];

	const [typed, setTyped] = useState("");
	const [scope, setScope] = useState(mine[0] ?? "");
	const [name, setName] = useState("");
	const [from, setFrom] = useState("");
	const [until, setUntil] = useState("");
	const [busy, setBusy] = useState<"make" | "stop">();
	const [made, setMade] = useState<{ link: string; name?: string; from?: string; until?: string }>();
	const [copied, setCopied] = useState(false);

	// The room as the server will read it. An @ typed into the room half is
	// folded away rather than allowed to start a second scope: the scope is
	// chosen beside it, and a name that split two ways would be refused.
	const local = normaliseRoomName(typed.replace(/@/g, "-"));
	const full = `${local}@${scope}`;
	const usable = validRoomName(full) && validScope(scope);

	const path = `/api/rooms/${encodeURIComponent(full)}/invites`;

	const make = async (event: React.FormEvent) => {
		event.preventDefault();

		if (busy || !usable) return;

		setBusy("make");

		try {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({
					// Asked for by name. Without it the server makes the ordinary
					// kind, which goes when the meeting ends, as a link made in a
					// call does.
					standing: true,
					name: name.trim(),
					// The browser's picker gives a wall-clock time with no zone,
					// and Date reads that as this machine's. Sent as an instant.
					from: from ? new Date(from).toISOString() : "",
					until: until ? new Date(until).toISOString() : "",
				}),
			});

			if (!response.ok) {
				const reason = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(explainLink(reason.error));
			}

			const said = (await response.json()) as { token: string; name?: string; from?: string; expires?: string };

			// The join page, wherever this deployment serves it, with the link's
			// token where the join reads it and the room where the page does.
			const url = new URL("/", window.location.href);
			url.search = `?invite=${encodeURIComponent(said.token)}`;
			url.hash = `#/${full}`;

			setMade({ link: url.toString(), name: said.name, from: said.from, until: said.expires });

			// Copied as well as shown, as the panel in a call does: whoever made
			// it is about to paste it somewhere.
			//
			// Not waited for. A browser can leave a clipboard write unanswered
			// while the page is not focused, and the form stayed busy behind it
			// with the link already on screen — which a headless run showed as a
			// spinner on a button whose work was done.
			void navigator.clipboard.writeText(url.toString()).then(
				() => setCopied(true),
				() => setCopied(false),
			);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(undefined);
		}
	};

	const stop = async () => {
		if (busy || !usable) return;

		setBusy("stop");

		try {
			const response = await fetch(path, { method: "DELETE", credentials: "same-origin" });

			if (!response.ok) {
				const reason = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(explainLink(reason.error));
			}

			const said = (await response.json().catch(() => ({}))) as { revoked?: number };
			const gone = typeof said.revoked === "number" ? said.revoked : 0;

			setMade(undefined);
			actionDone(
				gone === 1 ? t("One link stopped working.") : t("{count} links stopped working.", { count: String(gone) }),
			);
		} catch (err) {
			actionFailed(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(undefined);
		}
	};

	const field = "rounded-md border border-border bg-surface-hi px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-fg/40";

	return (
		<form onSubmit={make} className="flex h-full flex-col gap-2 rounded-[18px] border border-border bg-surface p-4">
			<h2 className="font-medium text-fg text-sm">{t("Guest links")}</h2>
			<p className="text-fg-muted text-[11.5px]">
				<Steady phrase="A link lets somebody outside your scope into one of its rooms as a guest. Leave the end empty for a link that works until it is stopped." block />
			</p>

			<div className="mt-1 flex items-center gap-1.5">
				<input
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
					placeholder={t("Room name")}
					aria-label={t("Room name")}
					className={cn(field, "readout min-w-0 flex-1")}
				/>

				<span className="readout text-fg-muted text-[12.5px]">@</span>

				{/* Typed by an administrator, who belongs to every scope; chosen by
				    anybody else from the ones on their account, and simply named
				    where there is only one. */}
				{me.admin ? (
					<input
						value={scope}
						onChange={(event) => setScope(event.target.value.toLowerCase().trim())}
						placeholder={t("Scope")}
						aria-label={t("Scope")}
						list="my-scopes"
						maxLength={MAX_SCOPE}
						className={cn(field, "readout w-32")}
					/>
				) : mine.length > 1 ? (
					<select
						value={scope}
						onChange={(event) => setScope(event.target.value)}
						aria-label={t("Scope")}
						className={cn(field, "readout")}
					>
						{mine.map((one) => (
							<option key={one} value={one}>
								{one}
							</option>
						))}
					</select>
				) : (
					<span className="readout text-fg text-[12.5px]">{scope}</span>
				)}

				<datalist id="my-scopes">
					{mine.map((one) => (
						<option key={one} value={one} />
					))}
				</datalist>
			</div>

			<input
				value={name}
				onChange={(event) => setName(event.target.value)}
				placeholder={t("Their name, if the link is for one person")}
				aria-label={t("Their name, if the link is for one person")}
				maxLength={40}
				className={field}
			/>

			{/* The lobby's calendar and clock, opened over the page (WhenField),
			    where they were the platform's date-and-time fields. The end
			    offers no day before the start. */}
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<div className="flex min-w-0 flex-col gap-1">
					<span className="text-fg-muted text-[11px]">{t("Works from")}</span>
					<WhenField
						value={from}
						onChange={setFrom}
						label={t("Works from")}
						none={t("From now")}
						className={cn(field, "h-[34px]")}
					/>
				</div>

				<div className="flex min-w-0 flex-col gap-1">
					<span className="text-fg-muted text-[11px]">{t("Works until")}</span>
					<WhenField
						value={until}
						onChange={setUntil}
						label={t("Works until")}
						none={t("Until it is stopped")}
						earliest={readLocal(from)}
						future
						className={cn(field, "h-[34px]")}
					/>
				</div>
			</div>

			{/* At the foot, for the reason the passphrase's button is. */}
			<div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
				<button
					type="submit"
					disabled={busy !== undefined || !usable}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi disabled:opacity-40"
				>
					{busy === "make" ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
					<Steady phrase="Make a link" />
				</button>

				<button
					type="button"
					onClick={() => void stop()}
					disabled={busy !== undefined || !usable}
					className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-danger/10 hover:text-fg disabled:opacity-40"
				>
					{busy === "stop" ? <Loader2 className="size-3.5 animate-spin" /> : <Link2Off className="size-3.5" />}
					<Steady phrase="Stop every link to this room working" />
				</button>
			</div>

			{made && (
				<div className="mt-1 flex flex-col gap-1.5">
					<div className="flex items-start gap-1.5">
						<p className="readout min-w-0 flex-1 break-all rounded-md bg-surface-hi px-2 py-1.5 text-[11px] text-fg-muted">
							{made.link}
						</p>

						<button
							type="button"
							onClick={() =>
								void navigator.clipboard.writeText(made.link).then(
									() => setCopied(true),
									() => setCopied(false),
								)
							}
							aria-label={copied ? t("Link copied") : t("Copy link")}
							className="rounded-md border border-border p-1.5 text-fg-muted hover:bg-surface-hi hover:text-fg"
						>
							{copied ? <Check className="size-3.5 text-tally-ink" /> : <Copy className="size-3.5" />}
						</button>
					</div>

					<p className="text-fg-muted text-[11.5px] leading-snug">
						{made.until
							? made.from
								? t("This link works from {from} until {until}.", {
										from: whenSaid(made.from),
										until: whenSaid(made.until),
									})
								: t("This link works until {until}.", { until: whenSaid(made.until) })
							: made.from
								? t("This link works from {from} until somebody stops it.", { from: whenSaid(made.from) })
								: t("This link works until somebody stops it.")}{" "}
						{made.name && t("Whoever uses it joins as {name}.", { name: made.name })}
					</p>
				</div>
			)}
		</form>
	);
}

/*
 * The two below are said at the moment a press fails rather than drawn, so they
 * read the language as it is then through the plain translator. Everything
 * drawn on this page subscribes instead (useT), which is what makes the
 * language picker above take effect without a reload.
 */

/** What a link could not be made for, in the reader's language. */
function explainLink(reason: string | undefined): string {
	switch (reason) {
		case "not_yours":
			return say("You can make links only into rooms of your own scopes.");
		case "name_too_long":
			return say("That name is too long.");
		case "bad_time":
			return say("That window cannot be used. It has to end after it starts, and after now.");
		case "invalid_room":
			return say("Room names can only use lowercase letters, numbers and dashes.");
		case "rate_limited":
			return say("Too many attempts. Try again in a moment.");
		// Guest links taken away while this page was open, which offered the
		// form by what it was told when it loaded.
		case "not_allowed":
			return say("Guest links have not been opened to you.");
		default:
			return say("That link could not be made. Try again.");
	}
}

/** The server sends a code; the sentence belongs here, in the reader's language. */
function explain(reason: string | undefined): string {
	switch (reason) {
		case "not_yours":
			return say("That is not your current passphrase.");
		case "passphrase_too_short":
			return say("At least eight characters.");
		case "passphrase_unchanged":
			return say("That is the passphrase you already have.");
		case "passphrase_in_use":
			return say("Somebody else already uses that passphrase. Choose another.");
		default:
			return say("That could not be changed. Try again.");
	}
}

/**
 * Scale a chosen image down to something worth storing.
 *
 * Two hundred and fifty-six pixels square, cropped to the middle, and encoded
 * as JPEG at a quality nobody will notice at the size it is drawn. A photograph
 * off a phone arrives as several megabytes; what leaves here is a few tens of
 * kilobytes, which is the difference between a database somebody can copy and
 * one they cannot.
 */
async function shrink(file: File): Promise<string> {
	const bitmap = await createImageBitmap(file);

	const side = Math.min(bitmap.width, bitmap.height);
	const canvas = document.createElement("canvas");
	canvas.width = 256;
	canvas.height = 256;

	const context = canvas.getContext("2d");
	if (!context) throw new Error("no canvas");

	context.drawImage(
		bitmap,
		(bitmap.width - side) / 2,
		(bitmap.height - side) / 2,
		side,
		side,
		0,
		0,
		256,
		256,
	);

	bitmap.close();

	return canvas.toDataURL("image/jpeg", 0.82);
}
