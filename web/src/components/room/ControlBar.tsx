import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useIdle } from "@/hooks/useIdle";
import { useRoomForRow, useRoomForSide } from "@/hooks/useRoomFor";
import { useDismiss } from "@/hooks/useDismiss";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import type { Placement } from "@/live/controls";
import { retune, runningShare, share, watchRunning } from "@/live/room";
import type { Room } from "livekit-client";
import { Clapperboard, Ellipsis, ListMusic, MessageSquare, Mic, MicOff, Video, VideoOff, Volume2 } from "lucide-react";
import { Leaving } from "./Leaving";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useIslandReserve } from "@/hooks/useIslandReserve";
import { DeviceMenu } from "./DeviceMenu";
import type { Reaction } from "@/live/hands";
import { HandButton, ReactionsButton } from "./HandButton";
import { ShareButton } from "./ShareButton";
import { useLocalState } from "@/hooks/useLocalState";
import { canShareScreen } from "@/live/context";
import { deviceFailed, losslessGaveUp, noSoundShared } from "@/live/notices";
import {
	NoSound,
	losslessUnavailable,
	rememberLossless,
	rememberedLossless,
	sendingLossless,
	startListening,
	stopListening,
} from "@/live/sound";

/**
 * The call controls.
 *
 * Microphone, camera, and screen are three independent switches: sharing does
 * not turn the camera off, which is what lets one person contribute two pictures
 * to the layout.
 */
export function ControlBar({
	room,
	handUp,
	onRaise,
	onReact,
	chatting,
	unread,
	listening,
	hidden,
	onChat,
	onListen,
	music,
	onMusic,
	watch,
	onWatchPanel,
	onLeave,
	host,
	where,
	onPlace,
	onReserve,
}: {
	room: Room;
	/* Raised here and drawn on the tiles, so both come from one place: a
	   reaction is an event and holding it in two components would be two lists
	   that drift. */
	handUp: boolean;
	onRaise: (up: boolean) => void;
	onReact: (what: Reaction) => void;
	chatting: boolean;
	/** Something was said while the panel was closed. */
	unread: boolean;
	/** The sound panel is open. */
	listening: boolean;
	/** Out of the way, because the stage is filling the screen. */
	hidden?: boolean;
	onChat: () => void;
	onListen: () => void;
	/** Whether the music panel is open, has anything in it, and music is playing. */
	music?: { open: boolean; available: boolean; playing: boolean };
	onMusic?: () => void;
	/** Whether the watch-together panel is open, has anything in it, and a video is playing. */
	watch?: { open: boolean; available: boolean; playing: boolean };
	onWatchPanel?: () => void;
	onLeave: () => void;
	/** Whether this person may end the meeting rather than only leave it. */
	host: boolean;
	/** Where these sit, and whether they step aside. See live/controls.ts. */
	where: Placement;
	onPlace: (where: Placement) => void;
	/**
	 * Told how much of the foot of the room these take, so the pictures are laid
	 * out clear of them. See hooks/useIslandReserve.ts.
	 */
	onReserve?: (reserve: number) => void;
}) {
	const t = useT();
	// The music button comes and goes with the music, so it arrives and
	// leaves rather than appearing in the bar between one frame and the next.
	const musicButton = useLingering(music?.available === true, 180);
	const watchButton = useLingering(watch?.available === true, 180);
	const local = useLocalState(room);
	// What the share is actually sending, which the menu shows while it runs:
	// the hint in live/strain.ts can change it without the menu being opened.
	const running = useSyncExternalStore(watchRunning, () => runningShare(room));
	const [busy, setBusy] = useState(false);
	const [lossless, setLossless] = useState(rememberedLossless);

	// Whether the pointer is on these, or somebody is on them with a keyboard.
	//
	// Without it the bar disappears out from under a menu somebody has just
	// opened: nothing here is a quick press, and the device list in particular
	// is read rather than glanced at. Held rather than done in CSS because a
	// hidden bar has been translated off the screen, where :hover never fires
	// again and there is no way back.
	//
	// Focus counts only where the browser would draw a focus ring for it.
	// Focus left behind by a click does not: a dropdown returns focus to its
	// trigger when it closes, and that trigger is in here — so pressing any
	// button once pinned the bar open for the rest of the call, which is a
	// setting that appears to do nothing. Somebody arriving by keyboard is the
	// case this is for, and that is exactly what :focus-visible means.
	const [near, setNear] = useState(false);

	/*
	 * When the bar is allowed to take itself away, and what brings it back.
	 *
	 * Two things ask for it: the setting, and a stage that has taken the whole
	 * screen. They used to be handled differently, and the second one was a
	 * fault: fullscreen set `away` outright, so the controls went and nothing
	 * returned them. Somebody watching a shared screen fullscreen had no way to
	 * mute, to leave, or to stop their own share, and no way to find out that
	 * the escape was a key nobody had told them about. It also made the setting
	 * look broken, because the one place people watch a share for half an hour
	 * is exactly where the setting appeared to do nothing.
	 *
	 * So fullscreen now hides the same way the setting does — out of the way
	 * until the pointer moves, which is what every video player does and what
	 * somebody reaching for the controls already expects.
	 */
	const hiding = where === "idle" || hidden === true;
	const idle = useIdle(hiding && !near);
	// `idle` is false whenever the hook is not watching, so this is the whole of
	// it: a bar in "always" that is not fullscreen never goes anywhere.
	const away = idle;
	// Asked unconditionally and combined after, not `where === "side" && …`.
	// That reads well and is a hook behind a short circuit: the moment somebody
	// changes the setting the hook order changes with it, and React tears the
	// room down rather than moving a button.
	const roomy = useRoomForSide();

	// Down the side only where the window is tall enough to hold a column. See
	// useRoomForSide: at a phone's landscape height the ends of the bar are off
	// the screen and cannot be pressed.
	const side = where === "side" && roomy;

	// One row where it fits, and a second row behind a button where it does
	// not; see useRoomForRow. Asked unconditionally, for the reason above.
	// A column down the side is a row turned on end and has the height for
	// all of them, so it never folds.
	const wide = useRoomForRow();
	const folded = !wide && !side;
	const [more, setMore] = useState(false);
	const moreRow = useLingering(more && folded && !away, 160);
	const island = useRef<HTMLElement>(null);
	const row = useRef<HTMLDivElement>(null);
	useDismiss(more, [island, row], () => setMore(false));

	// A panel opened from the second row closes it, because the panel rises
	// from the foot of the screen to where the row is.
	useEffect(() => {
		if (chatting || listening || music?.open || watch?.open) setMore(false);
	}, [chatting, listening, music?.open, watch?.open]);

	const drawn = island;
	useIslandReserve(drawn, side, onReserve);

	// Every toggle is awaited and guarded, because each one asks the browser for
	// a device and a second click while that prompt is open leaves the button
	// and the device disagreeing about what is on.
	const guard =
		(action: () => Promise<unknown>, kind?: "camera" | "microphone") =>
		async () => {
			if (busy) return;
			setBusy(true);

			try {
				await action();
			} catch (err) {
				// A camera or microphone that would not start is something
				// somebody has to go and deal with, so it says so, and stays
				// until they have. A share has no kind: its only failure worth
				// the name is a cancelled picker, which is an answer, and which
				// the browser reports with the very error a refused camera
				// raises -- so a share that was called off used to be announced
				// as a camera nobody could use.
				if (kind) deviceFailed(kind, err);
				else console.debug("share declined", err);
			} finally {
				setBusy(false);
			}
		};

	/*
	 * The microphone and the camera from the keyboard: Command or Control with
	 * D and E, which is what the Mac app and the larger web meeting services
	 * use, so the hands already know them. Without them the microphone was
	 * a button at the end of the tab order, behind every picture in the room.
	 *
	 * Not while somebody is typing, where D and E are letters; and the
	 * browser's own use of the pair (a bookmark, the address bar) is given up
	 * for the length of a call, as those services give it up.
	 */
	const toggles = useRef({ microphone: () => {}, camera: () => {} });
	toggles.current.microphone = guard(
		() => room.localParticipant.setMicrophoneEnabled(!local.microphone),
		"microphone",
	);
	toggles.current.camera = guard(() => room.localParticipant.setCameraEnabled(!local.camera), "camera");

	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
			const which = event.key.toLowerCase();
			if (which !== "d" && which !== "e") return;

			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;

			event.preventDefault();
			void (which === "d" ? toggles.current.microphone() : toggles.current.camera());
		};

		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, []);

	const shareButton = canShareScreen() && (
		<ShareButton
			sharing={local.screen}
			running={running}
			listening={local.listening}
			lossless={lossless}
			losslessUnavailable={losslessUnavailable(room)}
			sendingLossless={local.listening && sendingLossless(room)}
			onLossless={(on) => {
				setLossless(on);
				rememberLossless(on);
			}}
			onStart={(frameRate, quality) => void guard(() => share(room, true, frameRate, quality))()}
			onAdjust={(frameRate, quality) => void retune(room, frameRate, quality)}
			onStop={() => void guard(() => share(room, false, 30))()}
			onListen={() =>
				void guard(async () => {
					try {
						await startListening(room, lossless, losslessGaveUp);
					} catch (err) {
						// A picker answered with nothing ticked is not a
						// cancelled picker: it needs saying, with the way
						// out. A cancelled one goes on to the guard, which
						// says nothing, as for a screen.
						if (err instanceof NoSound) noSoundShared();
						else throw err;
					}
				})()
			}
			onStopListening={() => void guard(() => stopListening(room))()}
		/>
	);

	const others: ReactNode = (
		<>
			{/* What can be heard, beside what can be said. Not in the device
			    menu, which is about the microphone and camera somebody speaks
			    into — this is about everybody else. */}
			<Toggle on={listening} onLabel={t("Hide sound")} offLabel={t("Show sound")} onClick={onListen}>
				<Volume2 />
			</Toggle>

			{/* Music, beside the sound it is part of: what is playing, the song
			    desk, and each listener's own volume for it. Shown once there is
			    something to show, so a call without music has no extra button. */}
			{musicButton.mounted && onMusic && (
				<Toggle
					on={music?.open === true}
					onLabel={t("Hide music")}
					offLabel={t("Show music")}
					onClick={onMusic}
					className={musicButton.leaving ? "animate-depart" : "animate-arrive"}
				>
					<ListMusic />
					<Dot shown={music?.playing === true && !music.open} pulse />
				</Toggle>
			)}

			{/* Watching together, beside the music and apart from it: the one
			    puts a picture on the stage, the other plays into the sound. */}
			{watchButton.mounted && onWatchPanel && (
				<Toggle
					on={watch?.open === true}
					onLabel={t("Hide watch together")}
					offLabel={t("Show watch together")}
					onClick={onWatchPanel}
					className={watchButton.leaving ? "animate-depart" : "animate-arrive"}
				>
					<Clapperboard />
					<Dot shown={watch?.playing === true && !watch.open} pulse />
				</Toggle>
			)}
		</>
	);

	const busyInRow = (music?.playing === true && !music.open) || (watch?.playing === true && !watch.open);

	return (
		<>
		<footer
			ref={drawn}
			className={cn(
				// An island rather than a bar. A full-width strip with a rule
				// above it divides the window into a room and a chrome, and the
				// chrome then owns a band of height whether or not anything is
				// happening in it. Floating gives the pictures the whole window
				// and puts the controls on the same layer as everything else
				// that appears over them: the panel, the notices, the bubbles.
				// Above the panels, which are later in the document; see Room.
				"absolute z-30 flex gap-1.5",
				"glass rounded-full border p-1.5",
				// Six controls at a finger's size on a 320-pixel phone, with
				// four pixels between them where six would not fit.
				"max-[359px]:gap-1",
				side
					? // Down the right edge, vertically centred. Costs width,
						// which a wide window has and a tall one does not.
						"top-1/2 right-3 -translate-y-1/2 flex-col items-center"
					: cn(
							"-translate-x-1/2 left-1/2 items-center",
							// Clear of the home indicator, which the document asks
							// to draw under and nothing here was reading. Twenty
							// points from the bottom of the screen is underneath it
							// on every phone that has one.
							"bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.5rem))]",
						),
				// Steps aside when the stage takes the screen: somebody who asked
				// for the whole screen asked for the whole screen. And on the
				// same path, when the room has been left alone and the choice is
				// to have these out of the way.
				"transition-[transform,opacity] duration-200",
				away && "pointer-events-none opacity-0",
				away && (side ? "motion-safe:translate-x-24" : "motion-safe:translate-y-24"),
			)}
			data-folded={folded ? "" : undefined}
			onPointerEnter={() => setNear(true)}
			onPointerLeave={() => setNear(false)}
			onFocusCapture={(event) => {
				try {
					if ((event.target as Element).matches(":focus-visible")) setNear(true);
				} catch {
					// A browser without :focus-visible keeps the older behaviour,
					// which is to stay put while anything here has focus.
					setNear(true);
				}
			}}
			onBlurCapture={(event) => {
				// Only when focus has actually left, rather than moved between two
				// buttons inside.
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setNear(false);
			}}
		>
			<Toggle
				device
				on={local.microphone}
				onLabel={t("Mute microphone")}
				offLabel={t("Unmute microphone")}
				onClick={guard(
					() => room.localParticipant.setMicrophoneEnabled(!local.microphone),
					"microphone",
				)}
			>
				{local.microphone ? <Mic /> : <MicOff />}
			</Toggle>

			<Toggle
				device
				on={local.camera}
				onLabel={t("Turn camera off")}
				offLabel={t("Turn camera on")}
				onClick={guard(() => room.localParticipant.setCameraEnabled(!local.camera), "camera")}
			>
				{local.camera ? <Video /> : <VideoOff />}
			</Toggle>

			{/* Beside the camera rather than with the panels: it is a thing said
			    to the room, like speaking, and not a thing opened to be read. On
			    end down the side, and folded on a narrow screen, the reactions
			    are a button of their own; see HandButton. */}
			<HandButton up={handUp} onRaise={onRaise} onReact={onReact} split={!folded && !side} />
			{side && <ReactionsButton onReact={onReact} place="end" />}

			{!folded && shareButton}

			<Toggle
				on={chatting}
				onLabel={t("Hide messages")}
				// The dot, said: a reader has no dot to see.
				offLabel={unread ? `${t("Show messages")} (${t("New messages")})` : t("Show messages")}
				onClick={onChat}
			>
				<MessageSquare />
				{/* Whether, not how many: in a call the first question is the only
				    one anybody asks. */}
				<Dot shown={unread && !chatting} />
			</Toggle>

			{!folded && others}

			{folded ? (
				<span className="relative flex">
					<Button
						variant="secondary"
						size="round"
						aria-label={more ? t("Fewer controls") : t("More controls")}
						aria-expanded={more}
						onClick={() => setMore((was) => !was)}
						className={cn("relative", more && "bg-surface-hi-press")}
					>
						<Ellipsis />
						{/* What is going on in the row while it is folded away: a share
						    running, music or a film playing. */}
						<Dot shown={!more && (local.screen || local.listening || busyInRow)} />
					</Button>
				</span>
			) : (
				<DeviceMenu room={room} where={where} onPlace={onPlace} />
			)}

			{!folded && <span className={cn("bg-border", side ? "my-1 h-px w-5" : "mx-1 h-5 w-px")} />}

			{/* Leaving and, for whoever runs the room, ending it. Together
			    because they are the same intention at two scales — somebody is
			    finished — and apart they meant a host pressed the red button, went
			    home, and left the meeting running behind them. */}
			<Leaving room={room} host={host} onLeave={onLeave} />
		</footer>

		{/*
		 * The island's second row, above the first and in the same material,
		 * rising out of it.
		 *
		 * Everything that is not needed every minute of a call, at the same
		 * finger's size as the row below rather than smaller. It closes on a
		 * press anywhere else, on Escape, and when what it opened is a panel,
		 * which rises to where it is.
		 *
		 * Beside the island rather than inside it, though it is drawn as part
		 * of it. A blurred material inside another blurs only what the outer
		 * one has drawn, so inside the island this row blurred nothing at all
		 * and was a flat grey over the pictures.
		 */}
		{moreRow.mounted && (
			<div
				ref={row}
				className={cn(
					"-translate-x-1/2 absolute left-1/2 z-30 flex gap-1.5 max-[359px]:gap-1",
					// The island's own offset from the foot, its height, and a gap.
					"bottom-[calc(max(1.25rem,calc(env(safe-area-inset-bottom)+0.5rem))+58px+10px)]",
					"glass rounded-full border p-1.5",
					"origin-bottom",
					moreRow.leaving ? "animate-depart" : "animate-arrive",
				)}
			>
				<ReactionsButton onReact={onReact} place="row" />
				{shareButton}
				{others}
				<DeviceMenu room={room} where={where} onPlace={onPlace} />
			</div>
		)}
		</>
	);
}

/**
 * One control, lit or not.
 *
 * Two kinds, and they light differently.
 *
 * A switch for one's own microphone or camera (`device`) is grey while it is
 * on and drawn in the foreground while it is off — the way the platforms' own
 * call screens draw a muted microphone, and for their reason: it is the one
 * state on the row somebody has to read at a glance, since talking into a
 * muted microphone is the commonest mistake a call has. It was drawn as the
 * same grey either way with a dimmer icon, which at arm's length is the same
 * button. Still not red: colouring every closed switch red put four warnings
 * in a row on a bar whose only real one is leaving, and a muted microphone is
 * a choice somebody made, not a fault.
 *
 * A button that opens a panel is drawn pressed — the raised grey a step
 * further towards the foreground — while its panel is open, so that the button
 * that closes the panel is the one that looks held down. It was amber for the
 * messages only, and the sound panel open left its button looking exactly like
 * a closed one. Not amber for any of them: the owner kept the amber for what is
 * happening in the call — a share going out, a hand up, something unread,
 * somebody speaking — and a panel somebody opened is none of those
 * (2026-10-29). Sharing keeps the amber, from a button of its own.
 *
 * Every icon is drawn at full strength. A closed panel's was muted, which made
 * half the row read as disabled.
 */
function Toggle({
	on,
	onLabel,
	offLabel,
	onClick,
	children,
	device,
	className,
}: {
	on: boolean;
	onLabel: string;
	offLabel: string;
	onClick: () => void;
	children: ReactNode;
	device?: boolean;
	className?: string;
}) {
	return (
		<Button
			variant={device && !on ? "off" : "secondary"}
			size="round"
			// The action a press takes, and only that: it carried aria-pressed
			// as well, so a live microphone was read as "Mute microphone,
			// pressed" — the label and the state saying opposite things. The
			// native clients name the action alone.
			aria-label={on ? onLabel : offLabel}
			onClick={onClick}
			className={cn(
				"relative",
				!device && on && "bg-surface-hi-press hover:bg-surface-hi-press",
				className,
			)}
		>
			{children}
		</Button>
	);
}

/**
 * Something new behind a button: a message, a song, a film.
 *
 * Always drawn and scaled to nothing when there is nothing to say, so that it
 * arrives and leaves rather than being there on one frame and not the next.
 */
function Dot({ shown, pulse }: { shown: boolean; pulse?: boolean }) {
	return (
		<span
			aria-hidden
			className={cn(
				"pointer-events-none absolute top-1 right-1 size-2.5 rounded-full border-2 border-surface bg-tally",
				"transition-[transform,opacity] duration-200 ease-[var(--ease-settle)] motion-reduce:transition-none",
				shown ? "scale-100 opacity-100" : "scale-0 opacity-0",
				shown && pulse && "animate-breathe",
			)}
		/>
	);
}
