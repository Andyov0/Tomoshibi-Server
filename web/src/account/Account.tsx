import { GetTheApp } from "@/components/lobby/GetTheApp";
import { LanguagePicker } from "@/components/room/LanguagePicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { type Placement, placement, remember as rememberPlacement } from "@/live/controls";
import { rememberedDucking, setDucking, subscribeDuck } from "@/live/duck";
import { locale, t as say } from "@/live/i18n";
import { whenSaid } from "@/live/meeting";
import { MAX_SCOPE, normaliseRoomName, validRoomName, validScope } from "@/live/names";
import { actionDone, actionFailed } from "@/live/notices";
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
	const t = useT();
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

	return (
		<main className="mx-auto flex min-h-full max-w-lg flex-col gap-4 bg-bg p-5 text-fg sm:p-6">
			{/*
			 * The way back, first and above everything.
			 *
			 * This is a page somebody arrives at from the front of the site, does
			 * one thing on, and leaves — and until this existed the only way out
			 * was the browser's own back button, which is not where anybody looks
			 * on a page that has its own address. A page with no exit reads as a
			 * place you have been sent rather than one you visited.
			 *
			 * The language beside it, as on every other page that has a header.
			 * This one went without, so somebody handed an account in a language
			 * the browser guessed wrongly had nowhere to correct it short of
			 * joining a call.
			 */}
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
					{me.admin && (
						<a
							href="/admin"
							aria-label={t("Admin console")}
							className={cn(
								"flex items-center gap-1.5 rounded-md border border-tally/30 bg-tally/10 px-2.5 py-1.5",
								"text-[12px] text-fg transition-colors hover:bg-tally/20",
							)}
						>
							<Shield className="size-3.5 text-tally" />
							{/* The shield alone on the narrowest phones, where the
							    three of these together are wider than the screen. */}
							<span className="max-[400px]:hidden">{t("Admin console")}</span>
						</a>
					)}

					<LanguagePicker />
				</div>
			</nav>

			<div className="animate-rise [animation-delay:60ms]">
				<Header me={me} onChanged={setMe} />
			</div>

			{/* The apps, as a card under who they are rather than an icon in
			    the bar above: on a phone that icon had no words beside it,
			    and nothing said it was the way to the apps. The same card the
			    lobby has, so the two pages offer it in one way. */}
			<div className="animate-rise [animation-delay:90ms]">
				<GetTheApp className="rounded-lg" />
			</div>

			<div className="animate-rise [animation-delay:120ms]">
				<Picture me={me} onChanged={setMe} />
			</div>

			<div className="animate-rise [animation-delay:180ms]">
				<Abilities me={me} />
			</div>

			<div className="animate-rise [animation-delay:240ms]">
				<Settings me={me} />
			</div>

			{/* Only for somebody who can use it: an account given standing links,
			    and in a scope to send them into. An administrator belongs to
			    every scope and may type any; anybody else is offered the ones on
			    their account, and an account with none has no rooms to send
			    anybody into. The server asks both questions again. */}
			{holds(me, "invite") && (me.admin || (me.scopes?.length ?? 0) > 0) && (
				<div className="animate-rise [animation-delay:300ms]">
					<GuestLinks me={me} />
				</div>
			)}

			<div className="animate-rise [animation-delay:360ms]">
				<Passphrase />
			</div>

			<p className="animate-rise [animation-delay:420ms] px-1 text-fg-muted text-[11.5px] leading-relaxed">
				{t("Your passphrase is not stored here and cannot be sent to you. If you lose it, an administrator sets a new one.")}
			</p>
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

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();

		if (busy) return;

		setBusy(true);

		try {
			const response = await fetch("/api/account/session", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ name, passphrase }),
			});

			if (!response.ok) throw new Error(t("That name and passphrase do not go together."));

			onIn();
		} catch (err) {
			// The field is cleared for the next attempt, and the notice fades:
			// a refused attempt is something that happened, not something still
			// true.
			actionFailed(err instanceof Error ? err.message : String(err));
			setPassphrase("");
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

				<Button type="submit" variant="primary" size="lg" disabled={busy || !name || !passphrase}>
					{busy ? <Loader2 className="size-4 animate-spin" /> : t("Sign in")}
				</Button>
			</form>
		</main>
	);
}

function Header({ me, onChanged }: { me: Me; onChanged: (me: Me | undefined) => void }) {
	const t = useT();

	return (
		<header className="flex items-center gap-3">
			<Face me={me} />

			<div className="flex min-w-0 flex-col">
				<span className="truncate font-medium text-fg">{me.name}</span>
				{/* The signature, which is the public half of an account and the
				    thing that proves a name in a room. Shown here because this is
				    the one page where somebody has a reason to read their own. */}
				<span className="readout text-fg-muted text-[12px]">{me.trip}</span>
			</div>

			<button
				type="button"
				onClick={async () => {
					await fetch("/api/account/session", {
						method: "DELETE",
						credentials: "same-origin",
					});
					onChanged(undefined);
				}}
				className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-surface-hi hover:text-fg"
			>
				<LogOut className="size-3.5" />
				{t("Sign out")}
			</button>
		</header>
	);
}

function Face({ me }: { me: Me }) {
	if (me.avatar) {
		return <img src={me.avatar} alt="" className="size-12 shrink-0 rounded-full object-cover" />;
	}

	return (
		<span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-surface-hi text-fg-muted">
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
		<section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
			{/* Not "Picture", which is the share menu's word for the picture's
			    quality and is translated as that: this card read 画質 in
			    Japanese and 画面 in Chinese. */}
			<h2 className="font-medium text-fg text-sm">{t("Profile picture")}</h2>
			<p className="text-fg-muted text-[11.5px]">
				{t("Shown beside your name in a call. Scaled down before it is sent.")}
			</p>

			<div className="mt-1 flex gap-2">
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
					{t("Choose a picture")}
				</button>

				{me.avatar && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void send(null)}
						className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-surface-hi hover:text-danger disabled:opacity-40"
					>
						<Trash2 className="size-3.5" />
						{t("Remove")}
					</button>
				)}
			</div>
		</section>
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
		<section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
			<h2 className="font-medium text-fg text-sm">{t("What you can use")}</h2>
			<p className="text-fg-muted text-[11.5px]">{t("Set by whoever runs this deployment.")}</p>

			{held.length > 0 && (
				<ul aria-label={t("What you can use")} className="mt-1 flex flex-wrap gap-1.5">
					{held.map((one) => (
						<Ability key={one} permission={one} />
					))}
				</ul>
			)}

			{withheld.length > 0 && (
				<div className="mt-1 flex flex-col gap-1.5">
					<span className="text-fg-muted text-[11px]">{t("Not opened to this account")}</span>
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
				<dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 border-border border-t pt-3 text-[12px]">
					{scopes.length > 0 && (
						<>
							<dt className="text-fg-muted">{t("Your scopes")}</dt>
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
							<dt className="text-fg-muted">{t("Account created")}</dt>
							<dd className="text-fg">{since}</dd>
						</>
					)}
				</dl>
			)}
		</section>
	);
}

function Ability({ permission, withheld = false }: { permission: Permission; withheld?: boolean }) {
	const t = useT();
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
			<Icon className={cn("size-3.5", withheld ? "text-fg-muted/60" : permission === "emby" ? "text-tally" : "text-fg-muted")} />
			{t(PERMISSION_NAMES[permission])}
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
function Settings({ me }: { me: Me }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const body = useLingering(open);

	return (
		<section className="flex flex-col rounded-lg border border-border bg-surface">
			<button
				type="button"
				aria-expanded={open}
				aria-controls="account-settings"
				onClick={() => setOpen(!open)}
				className="flex items-start gap-3 rounded-lg p-4 text-left outline-none transition-colors hover:bg-surface-hi/40 focus-visible:ring-2 focus-visible:ring-fg/40"
			>
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium text-fg text-sm">{t("Settings")}</span>
					<span className="text-fg-muted text-[11.5px]">
						{t("How your calls start and look, in this browser. Another browser or device keeps its own.")}
					</span>
				</span>
				<ChevronDown
					aria-hidden
					className={cn("mt-0.5 size-4 shrink-0 text-fg-muted transition-transform duration-200", open && "rotate-180")}
				/>
			</button>

			{body.mounted && (
				<div
					id="account-settings"
					className={cn(
						"flex flex-col gap-5 border-border border-t px-4 pt-4 pb-4",
						body.leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<WhenJoining />
					<WhereControls />
					<MusicSettings me={me} />
					<WatchSettings />
				</div>
			)}
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
		<form
			onSubmit={submit}
			className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
		>
			<h2 className="font-medium text-fg text-sm">{t("Passphrase")}</h2>
			<p className="text-fg-muted text-[11.5px]">
				{t("This is how you are recognised, in a call and here. At least eight characters.")}
			</p>

			<div className="mt-1 flex flex-col gap-2">
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

			<div className="mt-1 flex items-center gap-3">
				<button
					type="submit"
					disabled={busy || !current || next.length < 8}
					className={cn(
						"flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px]",
						"hover:bg-surface-hi disabled:opacity-40",
					)}
				>
					{busy && <Loader2 className="size-3.5 animate-spin" />}
					{t("Change it")}
				</button>

				{done && <span className="text-[11.5px] text-fg-muted">{t("Changed.")}</span>}
			</div>
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
		<form onSubmit={make} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
			<h2 className="font-medium text-fg text-sm">{t("Guest links")}</h2>
			<p className="text-fg-muted text-[11.5px]">
				{t("A link lets somebody outside your scope into one of its rooms as a guest. Leave the end empty for a link that works until it is stopped.")}
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

			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<label className="flex flex-col gap-1">
					<span className="text-fg-muted text-[11px]">{t("Works from")}</span>
					<input
						type="datetime-local"
						value={from}
						onChange={(event) => setFrom(event.target.value)}
						className={field}
					/>
				</label>

				<label className="flex flex-col gap-1">
					<span className="text-fg-muted text-[11px]">{t("Works until")}</span>
					<input
						type="datetime-local"
						value={until}
						onChange={(event) => setUntil(event.target.value)}
						className={field}
					/>
				</label>
			</div>

			<div className="mt-1 flex flex-wrap items-center gap-2">
				<button
					type="submit"
					disabled={busy !== undefined || !usable}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-surface-hi disabled:opacity-40"
				>
					{busy === "make" ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
					{t("Make a link")}
				</button>

				<button
					type="button"
					onClick={() => void stop()}
					disabled={busy !== undefined || !usable}
					className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-fg-muted hover:bg-danger/10 hover:text-fg disabled:opacity-40"
				>
					{busy === "stop" ? <Loader2 className="size-3.5 animate-spin" /> : <Link2Off className="size-3.5" />}
					{t("Stop every link to this room working")}
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
							{copied ? <Check className="size-3.5 text-tally" /> : <Copy className="size-3.5" />}
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
