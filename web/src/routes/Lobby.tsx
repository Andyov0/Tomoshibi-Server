import { SiteNotice } from "@/components/lobby/SiteNotice";
import type { NoticeKind } from "@/live/notice";
import { FOLD_MS, Folding } from "@/components/Folding";
import { Schedule } from "@/components/lobby/Schedule";
import { LanguagePicker } from "@/components/room/LanguagePicker";
import { Button } from "@/components/ui/button";
import { useHumanCheck } from "@/components/ui/human-check";
import { useWideScreen } from "@/hooks/useWideScreen";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import type { Me } from "@/live/account";
import { SignInRefused, signIn, signOut } from "@/live/account";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { actionFailed } from "@/live/notices";
import { shutOutFor } from "@/live/lockout";
import { humanCheckSaid } from "@/live/turnstile";
import { keep, recall } from "@/lib/storage";
import { Steady } from "@/components/Steady";
import { CORNER } from "@/components/corner";
import { cn } from "@/lib/utils";
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, LogIn, LogOut, Plus, Shield, UserRound } from "lucide-react";
import { ServerList } from "@/components/room/ServerPicker";
import { meeting } from "@/live/account";
import { GetTheApp } from "@/components/lobby/GetTheApp";
import { ScopedRoomInput } from "@/components/lobby/ScopedRoomInput";
import { type Relay, relays } from "@/live/relays";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

/*
The two screens in front of a call, on a deployment that does not let strangers
open rooms.

The page used to put somebody straight into a room with a generated name, which
is the right thing when anybody may start one: the fastest path to a meeting is
to already be in it. It is the wrong thing when they may not, because then the
first thing that happens is a refusal, and it arrives after they have chosen a
camera and typed a name.

So where opening a room is restricted, the order inverts: say who you are, then
say what you want. Two choices rather than a form, because they are genuinely
different errands — starting a meeting is a decision, joining one is following an
instruction somebody else gave you — and a single box asking for a room name
serves the second and quietly fails the first.

Neither screen appears on a deployment that lets anyone open a room. There the
old page is right and this would be a door in front of an open gate.

Both are one card on an empty screen, which is a harder thing to make look
deliberate than a busy one: there is nothing else to be in proportion to. So the
ground carries a single warm glow behind the card, everything arrives in an
order, and the corner holds only what somebody might actually want from a page
they are passing through.
*/

/**
 * The shell both screens sit in.
 *
 * A grid rather than nested flex boxes, and centred by the grid rather than by
 * the child: the header is placed in its own row instead of being a sibling the
 * content has to make room for, so the card is centred in the window and not in
 * whatever is left over below the header. That distinction is invisible until
 * the header grows a second control, at which point everything below it slides.
 */
/**
 * How much of the fleet is answering, beside the name of the thing.
 *
 * A relay that has stopped answering is invisible from here — the picker simply
 * does not offer it, and a call still happens on one of the others — which is
 * the right behaviour and a poor way to find out. This is where somebody who
 * runs the deployment learns that two of eleven machines are down, at the moment
 * they are looking at the page anyway rather than the week the bill arrives.
 *
 * Both numbers, because either alone says nothing: three answering is excellent
 * out of three and alarming out of eleven. The light is read first and the
 * numbers second, so it carries the judgement — everything answering is one
 * colour, some of it answering is another, and none of it is the third.
 */
export function Fleet() {
	const t = useT();
	const [fleet, setFleet] = useState<{ online: number; total: number }>();

	useEffect(() => {
		let live = true;

		const look = () =>
			void relays().then((offered) => {
				if (live && offered.fleet) setFleet(offered.fleet);
			});

		look();

		// Slowly. This is a reassurance rather than a monitor, and a page that
		// polls every few seconds to redraw the same two digits is a page that
		// keeps a laptop awake for nothing.
		const timer = setInterval(look, 60_000);

		return () => {
			live = false;
			clearInterval(timer);
		};
	}, []);

	// Nothing where there is no fleet. A deployment that holds its own calls
	// has no relays, and the server says so as none of none, which this read
	// as none of them answering: a red light beside the name on every lobby
	// of every single-machine deployment, in the colour kept for leaving and
	// for errors, about machines that do not exist (the health check of
	// 2026-10-29).
	if (!fleet || fleet.total === 0) return null;

	const all = fleet.online === fleet.total;
	const none = fleet.online === 0;

	return (
		<span
			className="animate-rise ml-1.5 flex items-center gap-1.5 border-border border-l pl-2.5 text-[11px] text-fg-muted"
			title={t("Relays answering")}
		>
			<span
				className={cn(
					"size-1.5 rounded-full",
					none ? "bg-danger" : all ? "bg-good" : "bg-tally",
				)}
			/>
			<span className="tabular-nums">
				{fleet.online}/{fleet.total}
			</span>
		</span>
	);
}

/*
 * Scrolls down and not sideways.
 *
 * It was hidden in both directions, which was right when this held two cards and
 * stopped being right the moment a globe was added: on a short window everything
 * below the fold was unreachable, the menu included, which is what "the list will
 * not scroll" turned out to mean. The horizontal half stays — the only thing that
 * ever overflows sideways is the glow behind the page.
 */
function Frame({
	children,
	corner,
	notice,
	wide = false,
}: { children: ReactNode; corner?: ReactNode; notice: NoticeKind; wide?: boolean }) {
	return (
		// One column no wider than the window. Left to size itself, the column
		// took the header's natural width, which on a 320-pixel phone is 348 --
		// and every card below was laid out to that and clipped by the overflow
		// rule, nine pixels of each one's right edge simply missing.
		//
		// Clipped sideways, for the glow behind the page, and not a scroller
		// either way: it grows with what is in it, so the document is what
		// scrolls, and an overflow of auto here scrolled nothing while making
		// this the box anything sticky inside it stuck to. The servers' card,
		// which stays in view beside a meeting being arranged, never stuck.
		<main className="relative grid min-h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] overflow-x-clip">
			{/*
			 * There was a glow here, high and behind everything, the signal
			 * colour fading to nothing. It was the one gradient left on the
			 * night side of the product, and the owner's rule is that there are
			 * none; the page takes its top from the header and its weight from
			 * the cards, as it already did by day.
			 */}
			<header className="z-10 flex items-center justify-between gap-2 p-5 sm:gap-4 sm:p-6">
				<div className="flex min-w-0 items-center gap-2">
					<img src="/favicon.svg" alt="" className="size-5 rounded-[5px]" />
					{/* The mark alone below 360, where three corner buttons at a
					    finger's size and the fleet's count leave no room for the
					    name as well. */}
					<span className="font-semibold text-[13px] tracking-tight max-[360px]:sr-only">Tomoshibi</span>

					{/* Beside the name rather than under it: it is a property of
					    this deployment, not a heading of its own. The rule that
					    sets it apart is its own, so that no fleet leaves no rule. */}
					<Fleet />
				</div>

				<div className="flex items-center gap-2">{corner}</div>
			</header>

			{/* On a wide screen the two blocks sit a little above the middle of
			    the room below the header, where the eye puts the middle: at the
			    top of a tall window they left its lower half empty, which the
			    owner pointed out on a large monitor.

			    Placed by the window's height alone, never by what is in them. They
			    were centred on their own height at first, and everything that
			    changed that height moved the whole lobby: a notice arriving, a
			    language with longer words, and above all the arranging form,
			    whose closing dropped the lobby 92 pixels in a tenth of a second
			    as it came back within the window and was centred again. The
			    owner asked for the interface to be steady. The top is where the
			    middle would be for a lobby of about 30rem, the lobby closed, and
			    stays there; what changes grows and shrinks below it. */}
			<div className={cn("z-10 flex items-start justify-center px-5 pb-16 sm:px-6", wide && "md:pb-6")}>
				{/* Lifted off dead centre, and less so than before: optical centre
				    sits above geometric centre, but a page tall enough to scroll
				    should not begin with a screenful of nothing. */}
				<div
					className={cn(
						"w-full max-w-sm pt-4 sm:pt-8",
						wide && "md:max-w-[54rem] md:pt-[max(1rem,calc((100vh-5rem-30rem)*0.4))]",
					)}
				>
					{/* The notice the management pages publish for this screen:
					    the sign-in page's above the sign-in, the lobby's, for
					    people signed in, above the lobby. */}
					<SiteNotice kind={notice} />
					{children}
				</div>
			</div>
		</main>
	);
}


/** Whether the lobby was last laid out as two blocks, under the old product name like every key. */
const TWO_BLOCKS = "meet-live.lobby.two-blocks";

/** The corner of a page somebody is signed in on. */
function Corner({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
	const t = useT();

	return (
		<>
			{/*
			 * The way to the management pages, for the people who have them.
			 *
			 * Somebody who administers this deployment should not have to remember
			 * an address, and this is the page they are already looking at. Shown
			 * only to them: the button is not what authorises anything — the
			 * management pages ask the administrator list themselves — but a
			 * button everybody can see and nobody else can use is a door that
			 * invites knocking.
			 */}
			{me.admin && (
				<a
					href="/admin"
					className={cn(
						CORNER,
						"border-tally/30 bg-tally/10 text-fg hover:bg-tally/20 active:bg-tally/25",
					)}
				>
					<Shield className="size-3.5 text-tally-ink" />
					<Steady phrase="Admin console" className="hidden sm:inline-grid" />
				</a>
			)}

			<a
				href="/account"
				className={cn(CORNER, "border-border text-fg-muted hover:bg-wash hover:text-fg active:bg-wash-press")}
			>
				{me.avatar ? (
					<img src={me.avatar} alt="" className="size-4 rounded-full object-cover" />
				) : (
					<UserRound className="size-3.5" />
				)}
				<span className="hidden max-w-32 truncate sm:inline">{me.name}</span>
			</a>

			<button
				type="button"
				onClick={async () => {
					await signOut();
					onSignedOut();
				}}
				aria-label={t("Sign out")}
				title={t("Sign out")}
				className={cn(CORNER, "w-8 justify-center border-border px-0 text-fg-muted hover:bg-wash hover:text-fg active:bg-wash-press pointer-coarse:w-11")}
			>
				<LogOut className="size-3.5" />
			</button>

			<LanguagePicker />
		</>
	);
}

/** Say who you are. */
export function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
	const t = useT();
	const [name, setName] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const [shown, setShown] = useState(false);
	const [busy, setBusy] = useState(false);
	// Fading in with the rest of the form.
	const check = useHumanCheck("sign-in", "animate-rise");

	const submit = async (event: FormEvent) => {
		event.preventDefault();

		if (busy || !check.ready) return;

		setBusy(true);

		try {
			onSignedIn(await signIn(name, passphrase, check.token));
		} catch (err) {
			const reason = err instanceof Error ? err.message : undefined;
			const until = err instanceof SignInRefused ? err.until : undefined;
			const human = until ? undefined : humanCheckSaid(reason);

			// In the account page's order (account/Account.tsx): a lockout says
			// how long it has left, since the server answers a caller shut out
			// before it asks anything else; then the human check's sentences;
			// then the guessing budget's, which names no end; and only then the
			// pair not going together. This said the last of them to a caller
			// shut out, who typed the pair again, correctly, into a door shut
			// for half an hour.
			actionFailed(
				until
					? shutOutFor(until)
					: (human ??
							(reason === "rate_limited"
								? t("Too many attempts. Try again in a moment.")
								: t("That name and passphrase do not go together."))),
			);
			// Cleared for the next attempt. A refused attempt is something that
			// happened rather than something still true. The passphrase is kept
			// where only the human check failed: it was never looked at.
			if (!human) setPassphrase("");
			// And a fresh token either way, since the one sent is spent.
			check.reset();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Frame corner={<LanguagePicker />} notice="signin">
			<form onSubmit={submit} className="flex flex-col gap-5">
				<header className="animate-rise flex flex-col gap-2">
					<h1 className="font-semibold text-[22px] tracking-tight">
						<Steady phrase="Sign in" className="justify-items-start" />
					</h1>
					<p className="text-fg-muted text-[13px] leading-relaxed">
						<Steady
							phrase="Meetings here are started by the people who belong here. If somebody sent you a link, open that instead."
							block
						/>
					</p>
				</header>

				{/*
				 * One box holding two fields, rather than two boxes.
				 *
				 * They are one answer — a name is not a credential and a passphrase
				 * without a name is not either — and the same pairing is used on the
				 * join screen, so somebody who has been here before recognises the
				 * shape before reading a word of it.
				 */}
				<div
					className={cn(
						"animate-rise",
						"divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface",
						"transition-[border-color,box-shadow]",
						"focus-within:border-fg/40 focus-within:ring-2 focus-within:ring-fg/25",
					)}
				>
					<label className="relative flex items-center">
						<UserRound className="pointer-events-none absolute left-3.5 size-4 text-fg-muted" />
						<input
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder={t("Name")}
							aria-label={t("Name")}
							autoComplete="username"
							// biome-ignore lint/a11y/noAutofocus: the page exists to be typed into
							autoFocus
							maxLength={32}
							className="h-12 w-full bg-transparent pr-3.5 pl-10 text-fg text-sm outline-none placeholder:text-fg-muted pointer-coarse:text-base"
						/>
					</label>

					<label className="relative flex items-center">
						<KeyRound
							className={cn(
								"pointer-events-none absolute left-3.5 size-4 transition-colors",
								passphrase ? "text-tally-ink" : "text-fg-muted",
							)}
						/>
						<input
							type={shown ? "text" : "password"}
							value={passphrase}
							onChange={(event) => setPassphrase(event.target.value)}
							placeholder={t("Passphrase")}
							aria-label={t("Passphrase")}
							autoComplete="current-password"
							maxLength={200}
							className={cn(
								"h-12 w-full bg-transparent pl-10 text-fg text-sm outline-none placeholder:text-fg-muted pointer-coarse:text-base",
								passphrase ? "pr-11" : "pr-3.5",
							)}
						/>

						{/* Only once there is something to look at. An eye beside an
						    empty field is a control offering to reveal nothing. */}
						{passphrase && (
							<button
								type="button"
								onClick={() => setShown((was) => !was)}
								aria-label={shown ? t("Hide passphrase") : t("Show passphrase")}
								aria-pressed={shown}
								className={cn(
									// Thirty-two, forty-four under a finger: it was twenty-four.
									"pressable absolute right-2 grid size-8 place-items-center rounded-full text-fg-muted outline-none",
									"hover:bg-wash hover:text-fg focus-visible:ring-2 focus-visible:ring-fg/70 pointer-coarse:size-11",
								)}
							>
								{shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
							</button>
						)}
					</label>
				</div>

				{check.widget}

				<Button
					type="submit"
					variant="primary"
					size="lg"
					disabled={busy || !name || !passphrase || !check.ready}
					className="animate-rise"
				>
					{busy ? <Loader2 className="size-4 animate-spin" /> : t("Sign in")}
				</Button>
			</form>
		</Frame>
	);
}

/*
 * A field inside a card: the raised grey, the shared small radius, the
 * button's height beside it. Sixteen pixels under a finger, because Safari on
 * a phone zooms the whole page in on a field set smaller and leaves it zoomed.
 */
const FIELD = cn(
	"h-9 min-w-0 rounded-[10px] border border-border bg-surface-hi px-3 text-sm text-fg",
	"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted",
	"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
	"pointer-coarse:h-11 pointer-coarse:text-base",
);

/** Say what you want. */
export function Lobby({
	me,
	onOpen,
	onSignedOut,
}: {
	me: Me;
	onOpen: (room: string, relay: string) => void;
	onSignedOut: () => void;
}) {
	const t = useT();
	const [typed, setTyped] = useState("");
	const [naming, setNaming] = useState("");
	const [busy, setBusy] = useState<"start" | "join">();

	// Which machine to hold it on, chosen here rather than on the screen after.
	// This is where somebody is deciding what kind of meeting they are about to
	// have, and where it is held is part of that.
	const [servers, setServers] = useState<Relay[]>([]);
	const [serversKnown, setServersKnown] = useState(false);
	const [server, setServer] = useState("");
	// While the schedule card is open it shows the server list itself.
	// Whether a meeting is being arranged, as the press says it, and how long
	// what moves around it is still moving: the cards above fold back over
	// FOLD_MS, and the servers' card keeps the height it holds while the form
	// is open until they have, or it was stretched and shrunk with them.
	// From the very render the press opens it in: the lingering count only
	// starts a render later, and for that one frame the servers' card still
	// followed the cards beside it, already moving, and kept that height.
	const [scheduleOpen, setScheduleOpen] = useState(false);
	const scheduling = useLingering(scheduleOpen, FOLD_MS + 40).mounted || scheduleOpen;


	useEffect(() => {
		void relays().then((offered) => {
			setServers(offered.relays);
			setServersKnown(true);
			keep(TWO_BLOCKS, offered.relays.length > 1 ? "yes" : "no");
		});
	}, []);

	const wanted = normaliseRoomName(typed);
	const opening = normaliseRoomName(naming);

	/**
	 * Take somebody to a name, once it is clear the name is the right kind.
	 *
	 * A meeting that already exists cannot be started and one that does not
	 * cannot be joined, and both mistakes used to be discovered on the next
	 * screen or the one after — a camera preview for a room that is not there,
	 * or a call somebody else is already in. Asked here, where the name was
	 * typed and can still be changed.
	 *
	 * An unknown answer goes through. The check is a courtesy and the join is
	 * the authority; a check that could not be made must not become a refusal.
	 */
	const go = async (kind: "start" | "join", room: string) => {
		if (busy) return;

		setBusy(kind);

		try {
			const live = await meeting(room);

			if (kind === "start" && live === true) {
				actionFailed(t("A meeting is already happening under that name."));
				return;
			}

			if (kind === "join" && live === false) {
				actionFailed(t("No meeting is happening under that name."));
				return;
			}

			onOpen(room, server);
		} finally {
			setBusy(undefined);
		}
	};

	// Two blocks only where there is a second one to show: the servers, where
	// there is more than one to choose between. Until the list has come, as
	// the lobby was last laid out in this browser, and as two where it has not
	// been before, the deployment this was written for having many: decided by
	// the list's arrival alone, the lobby was drawn as one narrow column and
	// then, a second later on a slow line, as two wide ones, the whole page
	// rearranged under somebody already reading it. The servers' card stands
	// in its place meanwhile, its globe empty until the list arrives.
	const [laidOutAs] = useState(() => recall(TWO_BLOCKS) !== "no");
	const twoBlocks = serversKnown ? servers.length > 1 : laidOutAs;
	// Whether the servers are beside the meeting now, rather than under it:
	// the stylesheet places the blocks, but whether arranging a meeting
	// brings in its own list depends on it (Schedule serversBeside).
	const beside = useWideScreen() && twoBlocks;

	// The servers' card's height as the meeting's three cards set it, kept
	// while a meeting is being arranged: the card holds it then, rather than
	// being stretched to the open form or shrinking to a size of its own, so
	// opening and closing the form moves nothing beside it. Left to change, it
	// jumped as the form opened and was dragged out and back as it closed,
	// which the owner found unnatural.
	//
	// Its whole height, border and padding in, as offsetHeight gives it and
	// as a height set on it is read. useMeasure gives what is inside the
	// padding, and the card set to that came out 34 pixels short, its globe
	// shrinking with it, as the form opened.
	const [serversCard, setServersCard] = useState<HTMLElement | null>(null);
	const [serversHeight, setServersHeight] = useState(0);
	useEffect(() => {
		if (!serversCard || scheduling) return;
		const read = () => {
			if (serversCard.offsetHeight > 0) setServersHeight(serversCard.offsetHeight);
		};
		read();
		const observer = new ResizeObserver(read);
		observer.observe(serversCard);
		return () => observer.disconnect();
	}, [serversCard, scheduling]);
	const holdServers = beside && scheduling && serversHeight > 0;

	return (
		<Frame corner={<Corner me={me} onSignedOut={onSignedOut} />} notice="lobby" wide={twoBlocks}>
			{/*
			 * Two blocks, side by side where there is room: the meeting on the
			 * left (starting one, joining one, arranging one) and where it is
			 * held on the right (the servers), under the greeting, with the way
			 * to the apps at the greeting's right. One column, one under the
			 * other, on a phone, and wherever there is one server and so no
			 * second block.
			 *
			 * It was one column everywhere, and with the servers' globe in it
			 * the lobby ran to about a thousand pixels: the owner found the web
			 * version had to be scrolled to be seen whole, and asked for every
			 * part to be laid out again as two blocks on one screen.
			 */}
			<div className="flex flex-col gap-4">
				<div className="flex items-end justify-between gap-4">
					<header className="animate-rise flex min-w-0 flex-col gap-1">
						<h1 className="font-semibold text-[22px] tracking-tight">
							<Steady phrase="Hello, {name}" values={{ name: me.name }} className="justify-items-start" />
						</h1>
						<p className="text-fg-muted text-[13px]">
							<Steady phrase="What would you like to do?" block />
						</p>
					</header>
					{twoBlocks && (
						<GetTheApp compact className="animate-rise hidden md:inline-flex" />
					)}
				</div>

				{/*
				 * One grid, so that the two blocks line up at the top and at the
				 * bottom: the meeting's three cards down the left, and the
				 * servers' card down the right, stretched to their height. The
				 * owner found the two sides at different heights when the right
				 * began with a small label and the left with the greeting; the
				 * greeting is above both now, so each block begins with a card. On
				 * a phone, one column in this order, the app last.
				 */}
				<div
					className={cn(
						"grid grid-cols-[minmax(0,1fr)] gap-4",
						twoBlocks && "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-x-6",
					)}
				>

					{/*
					 * The meeting's block: one column of its own, so that starting
					 * and joining can fold away while a meeting is being arranged and
					 * take the space between them with them. As rows of the grid
					 * they left its gaps behind, and the card being opened sat two
					 * gaps below the top of the servers' card beside it.
					 *
					 * Folded away because the owner asked: with the form open the
					 * two cards above it were something to read past on the way to
					 * it, and on a phone they pushed it down a screen.
					 */}
					<div className="flex min-w-0 flex-col">
						<Folding open={!scheduleOpen}>
							<div className="pb-4">
							{/*
							 * Naming the new meeting, with the generated name as the answer to
							 * leaving it blank rather than as the only answer.
							 *
							 * It used to generate one outright, on the reasoning that naming a
							 * meeting is a decision nobody wants to make in order to have one.
							 * That is true of most meetings and wrong about the ones people
							 * hold every week: a recurring call has a name its people already
							 * know, and being handed "crisp-bough-thrive-4185" instead means
							 * telling everybody a new one each time. So the field is offered
							 * and is not required, which serves both without asking anybody
							 * which they are.
							 */}
							<form
								onSubmit={(event) => {
									event.preventDefault();
									void go("start", validRoomName(opening) ? opening : generateRoomName());
								}}
								className={cn(
									"animate-rise",
									"flex flex-col gap-3 rounded-[18px] border border-border bg-surface p-4",
								)}
							>
								<span className="flex items-center gap-3.5">
									<span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-tally/15 text-tally-ink">
										<Plus className="size-5" />
									</span>

									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="font-medium text-[14px]">{t("Start a meeting")}</span>
										<span className="text-[12px] text-fg-muted leading-snug">
											<Steady phrase="Name it yourself, or leave it blank for one nobody has used." block />
										</span>
									</span>
								</span>

								<div className="flex gap-2">
									<ScopedRoomInput
										value={naming}
										onValueChange={setNaming}
										scopes={me.scopes ?? []}
										admin={me.admin}
										placeholder={t("Room name")}
										aria-label={t("Name for the new room")}
										className={FIELD}
									/>

									<Button
										type="submit"
										variant="primary"
										disabled={busy !== undefined}
										// Never disabled on the field being empty. Blank is an
										// answer here, and a button that greys out until a field
										// is filled says the field is required when it is the
										// opposite.
										className="group gap-1.5"
									>
										{/* The word kept under the spinner, so the button, and
										    the field beside it, keep their width while busy and
										    in every language (Steady). */}
										<span className="relative inline-grid place-items-center">
											<Steady phrase="Start" className={cn(busy === "start" && "invisible")} />
											{busy === "start" && <Loader2 className="absolute size-4 animate-spin" />}
										</span>
										<ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
									</Button>
								</div>
							</form>
							</div>
						</Folding>

						<Folding open={!scheduleOpen}>
							<div className="pb-4">
							<form
								onSubmit={(event) => {
									event.preventDefault();
									if (validRoomName(wanted)) void go("join", wanted);
								}}
								className={cn(
									"animate-rise",
									"flex flex-col gap-3 rounded-[18px] border border-border bg-surface p-4",
								)}
							>
								<span className="flex items-center gap-3.5">
									{/* A way in, rather than an eye: the eye is what the
									    passphrase field uses for showing what was typed, and
									    here it read as watching a meeting rather than joining
									    one. */}
									<span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-surface-hi text-fg-muted">
										<LogIn className="size-5" />
									</span>

									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="font-medium text-[14px]">{t("Join a meeting")}</span>
										<span className="text-[12px] text-fg-muted leading-snug">
											<Steady phrase="The name you were given." block />
										</span>
									</span>
								</span>

								<div className="flex gap-2">
									<ScopedRoomInput
										value={typed}
										onValueChange={setTyped}
										scopes={me.scopes ?? []}
										admin={me.admin}
										placeholder={t("Room name")}
										aria-label={t("Room name")}
										className={FIELD}
									/>

									<Button
										type="submit"
										variant="secondary"
										disabled={!validRoomName(wanted) || busy !== undefined}
									>
										<span className="relative inline-grid place-items-center">
											<Steady phrase="Join" className={cn(busy === "join" && "invisible")} />
											{busy === "join" && <Loader2 className="absolute size-4 animate-spin" />}
										</span>
									</Button>
								</div>
							</form>
							</div>
						</Folding>
						{/*
						 * Where the call will be held, under both choices rather than
						 * inside either: it is the same decision whichever of them somebody
						 * is making, and putting a copy in each card would be asking the
						 * same question twice on one screen.
						 */}
						{/* The list carries its own heading, because it also carries the
						    control for measuring again and the two belong on one line. */}
						<Schedule
							servers={servers}
							server={server}
							onServer={setServer}
							onOpenChange={setScheduleOpen}
							onSignedOut={onSignedOut}
							// Absent from a server older than permissions, where every
							// account could arrange.
							canArrange={me.can?.includes("arrange") ?? true}
							// Beside it on a wide screen the lobby keeps the servers in
							// view, so the form does not bring in a second globe.
							serversBeside={beside}
						/>
					</div>

					{twoBlocks && (beside || !scheduling) && (
						<section
							ref={setServersCard}
							style={holdServers ? { height: serversHeight } : undefined}
							aria-label={t("Server")}
							className={cn(
								"animate-rise rounded-[18px] border border-border bg-surface p-4",
								twoBlocks && "md:col-start-2 md:row-start-1",
								// Sized by the grid and not by what is in it, so the
								// meeting's cards alone set the rows' height and the
								// globe fits itself to them (ServerList fill). While a
								// meeting is being arranged the left runs on for a
								// calendar and a clock, and stretched to that the card
								// was a globe adrift in the middle of a long, empty
								// panel: it holds the height it had, at the top, and
								// stays in view as the form is scrolled, so the machine
								// can be chosen beside the time.
								twoBlocks && (scheduling ? "md:sticky md:top-4 md:self-start" : "md:[contain:size]"),
							)}
						>
							<ServerList
								relays={servers}
								value={server}
								onChange={setServer}
								fill={twoBlocks && (!scheduling || holdServers)}
							/>
						</section>
					)}

					{/*
					 * The apps, last, at the foot of the page on a phone, which the
					 * owner chose (2026-11-02) when the lobby was laid out again as
					 * two blocks. It had been put above the servers once, because on
					 * a phone the foot was a whole screen below the fold; the globe is
					 * smaller now and the gaps tighter. On a wide screen with two
					 * blocks it is at the greeting's right instead. See GetTheApp.
					 */}
					<GetTheApp className={cn("animate-rise", twoBlocks && "md:hidden")} />
				</div>
			</div>
		</Frame>
	);
}
