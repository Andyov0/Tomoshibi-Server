import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useIdle } from "@/hooks/useIdle";
import { useRoomForSide } from "@/hooks/useRoomFor";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import type { Placement } from "@/live/controls";
import { retune, runningShare, share, watchRunning } from "@/live/room";
import type { Room } from "livekit-client";
import { Clapperboard, ListMusic, MessageSquare, Mic, MicOff, Video, VideoOff, Volume2 } from "lucide-react";
import { Leaving } from "./Leaving";
import { useRef, useState, useSyncExternalStore } from "react";
import { useIslandReserve } from "@/hooks/useIslandReserve";
import { DeviceMenu } from "./DeviceMenu";
import type { Reaction } from "@/live/hands";
import { HandButton } from "./HandButton";
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

	const drawn = useRef<HTMLElement>(null);
	useIslandReserve(drawn, side, onReserve);

	// How many buttons the bar carries past the five every phone has, which is
	// what its narrow steps are measured against; see the classes below. From
	// what is drawn, the share included wherever the browser offers one, and a
	// button on its way out still counted until it has gone.
	const extra =
		(canShareScreen() ? 1 : 0) +
		(musicButton.mounted && onMusic ? 1 : 0) +
		(watchButton.mounted && onWatchPanel ? 1 : 0);

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

	return (
		<footer
			ref={drawn}
			className={cn(
				// An island rather than a bar. A full-width strip with a rule
				// above it divides the window into a room and a chrome, and the
				// chrome then owns a band of height whether or not anything is
				// happening in it. Floating gives the pictures the whole window
				// and puts the controls on the same layer as everything else
				// that appears over them: the panel, the notices, the bubbles.
				"absolute z-20 flex gap-1.5",
				"rounded-full border border-border bg-surface/90 p-1.5 shadow-2xl backdrop-blur-md",
				/*
				 * Narrower on a narrow phone, in two steps, because at full size the
				 * bar is 368 pixels and a 320-pixel phone could not hold it: both ends
				 * hung off the screen, the hang-up button with them, and the page
				 * was pushed wider than the display so the browser zoomed it all out.
				 * A 375-pixel phone held it with three pixels to spare.
				 *
				 * Below 390 only the spacing tightens, which is enough there. Below
				 * 372, which takes in the common 360-pixel Android width as well as
				 * 320, the buttons come down to 34 pixels and the divider goes -- a
				 * smaller target than is comfortable, chosen over a control that is
				 * not on the screen at all. The sizes are reached from here rather
				 * than through each button so that every other place those buttons
				 * appear keeps its size.
				 */
				"max-[390px]:gap-1 max-[390px]:p-1",
				"max-[372px]:[&_.size-10]:size-[34px] max-[372px]:[&_.size-11]:size-[38px]",
				"max-[372px]:[&_.rounded-r-full]:h-[34px] max-[372px]:[&_.rounded-r-full]:pr-1.5 max-[372px]:[&_.rounded-r-full]:pl-0.5",
				"max-[372px]:[&>span.w-px]:hidden",
				/*
				 * Every button past the five a phone always has, counted rather than
				 * named: the screen share, the music and watching together are 46
				 * pixels each at full size, and the steps below are taken a width
				 * sooner for each one there is.
				 *
				 * They were named, and the share was left out of the count. Each step
				 * was measured "on a phone's set of buttons, without the screen share
				 * no phone browser offers" -- true of a phone, and not of the browsers
				 * that do offer it at the same width: a desktop window narrowed to a
				 * phone's size, and a phone emulated in one. There the bar carried
				 * the share as well, 414 pixels with nothing else, and at 375 hung ten
				 * pixels off each side with the page scrolling sideways under it; at
				 * 320 four. Nothing had been added to the bar since the narrow-phone
				 * fix of 10-08 -- built from that commit, it overflowed the same --
				 * the steps had simply been worked out for one button fewer. And the
				 * music rules matched any marked button while the watch rules
				 * matched only music and watch together, so a share beside either
				 * fell between them.
				 *
				 * One extra: below 430 the spacing tightens, below 410 the buttons
				 * come to 34, below 345 to 32 with the gaps nearly closed. Two: the
				 * same from 476 and 454, 32 below 384, and 28 below 350. Three, 506
				 * pixels at full size: from 522 and 500, 32 below 440, 28 below 384
				 * and no gaps below 350 -- small targets, and every one on the screen.
				 * Worked out so the bar leaves at least eight pixels either side at
				 * every width, and measured at 320, 360, 375, 390 and 414 with every
				 * count. Exact counts rather than "at least", so each group is whole
				 * on its own and a later step never depends on an earlier one still
				 * matching.
				 */
				"data-[extra=1]:max-[430px]:gap-1 data-[extra=1]:max-[430px]:p-1",
				"data-[extra=1]:max-[410px]:[&_.size-10]:size-[34px] data-[extra=1]:max-[410px]:[&_.size-11]:size-[38px]",
				"data-[extra=1]:max-[410px]:[&_.rounded-r-full]:h-[34px] data-[extra=1]:max-[410px]:[&_.rounded-r-full]:pr-1.5 data-[extra=1]:max-[410px]:[&_.rounded-r-full]:pl-0.5",
				"data-[extra=1]:max-[410px]:[&>span.w-px]:hidden",
				"data-[extra=1]:max-[345px]:gap-0.5",
				"data-[extra=1]:max-[345px]:[&_.size-10]:size-8 data-[extra=1]:max-[345px]:[&_.size-11]:size-9",
				"data-[extra=1]:max-[345px]:[&_.rounded-r-full]:h-8",
				"data-[extra=2]:max-[476px]:gap-1 data-[extra=2]:max-[476px]:p-1",
				"data-[extra=2]:max-[454px]:[&_.size-10]:size-[34px] data-[extra=2]:max-[454px]:[&_.size-11]:size-[38px]",
				"data-[extra=2]:max-[454px]:[&_.rounded-r-full]:h-[34px] data-[extra=2]:max-[454px]:[&_.rounded-r-full]:pr-1.5 data-[extra=2]:max-[454px]:[&_.rounded-r-full]:pl-0.5",
				"data-[extra=2]:max-[454px]:[&>span.w-px]:hidden",
				"data-[extra=2]:max-[384px]:gap-0.5 data-[extra=2]:max-[384px]:[&_.size-10]:size-8 data-[extra=2]:max-[384px]:[&_.size-11]:size-9",
				"data-[extra=2]:max-[384px]:[&_.rounded-r-full]:h-8",
				"data-[extra=2]:max-[350px]:p-0.5 data-[extra=2]:max-[350px]:[&_.size-10]:size-7 data-[extra=2]:max-[350px]:[&_.size-11]:size-8",
				"data-[extra=2]:max-[350px]:[&_.rounded-r-full]:h-7",
				"data-[extra=3]:max-[522px]:gap-1 data-[extra=3]:max-[522px]:p-1",
				"data-[extra=3]:max-[500px]:[&_.size-10]:size-[34px] data-[extra=3]:max-[500px]:[&_.size-11]:size-[38px]",
				"data-[extra=3]:max-[500px]:[&_.rounded-r-full]:h-[34px] data-[extra=3]:max-[500px]:[&_.rounded-r-full]:pr-1.5 data-[extra=3]:max-[500px]:[&_.rounded-r-full]:pl-0.5",
				"data-[extra=3]:max-[500px]:[&>span.w-px]:hidden",
				"data-[extra=3]:max-[440px]:gap-0.5 data-[extra=3]:max-[440px]:[&_.size-10]:size-8 data-[extra=3]:max-[440px]:[&_.size-11]:size-9",
				"data-[extra=3]:max-[440px]:[&_.rounded-r-full]:h-8",
				"data-[extra=3]:max-[384px]:p-0.5 data-[extra=3]:max-[384px]:[&_.size-10]:size-7 data-[extra=3]:max-[384px]:[&_.size-11]:size-8",
				"data-[extra=3]:max-[384px]:[&_.rounded-r-full]:h-7",
				"data-[extra=3]:max-[350px]:gap-0",
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
				away && (side ? "translate-x-24" : "translate-y-24"),
			)}
			data-extra={extra}
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
				on={local.camera}
				onLabel={t("Turn camera off")}
				offLabel={t("Turn camera on")}
				onClick={guard(() => room.localParticipant.setCameraEnabled(!local.camera), "camera")}
			>
				{local.camera ? <Video /> : <VideoOff />}
			</Toggle>

			{/* Beside the camera rather than with the panels: it is a thing said
			    to the room, like speaking, and not a thing opened to be read. */}
			<HandButton up={handUp} onRaise={onRaise} onReact={onReact} />

			{canShareScreen() && (
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
			)}

			<Toggle
				on={chatting}
				onLabel={t("Hide messages")}
				offLabel={t("Show messages")}
				signal
				onClick={onChat}
			>
				<MessageSquare />
				{/* Whether, not how many: in a call the first question is the only
				    one anybody asks. */}
				{unread && !chatting && (
					<span className="absolute top-0.5 right-0.5 size-2 rounded-full border-2 border-surface bg-tally" />
				)}
			</Toggle>

			{/* What can be heard, beside what can be said. Not in the device
			    menu above, which is about the microphone and camera somebody
			    speaks into — this is about everybody else. */}
			<Toggle
				on={listening}
				onLabel={t("Hide sound")}
				offLabel={t("Show sound")}
				onClick={onListen}
			>
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
					{music?.playing && !music.open && (
						<span className="absolute top-0.5 right-0.5 size-2 animate-pulse rounded-full border-2 border-surface bg-tally" />
					)}
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
					{watch?.playing && !watch.open && (
						<span className="absolute top-0.5 right-0.5 size-2 animate-pulse rounded-full border-2 border-surface bg-tally" />
					)}
				</Toggle>
			)}

			<DeviceMenu room={room} where={where} onPlace={onPlace} />

			<span className={cn("bg-border", side ? "my-1 h-px w-5" : "mx-1 h-5 w-px")} />

			{/* Leaving and, for whoever runs the room, ending it. Together
			    because they are the same intention at two scales — somebody is
			    finished — and apart they meant a host pressed the red button, went
			    home, and left the meeting running behind them. */}
			<Leaving room={room} host={host} onLeave={onLeave} />
		</footer>
	);
}

/**
 * One control, lit or not.
 *
 * Off is drawn as unlit rather than as an alarm. Colouring every closed switch
 * red put four warnings in a row on a bar whose only real one is leaving, and a
 * warning that is always on stops being a warning. A muted microphone is a
 * choice somebody made, not a fault.
 *
 * `signal` marks a control where being on is itself worth announcing — an open
 * panel with something unread in it — and it takes the one colour that means
 * something is happening. Sharing takes that colour too, from a button of its
 * own: it carries a choice as well as a state, and a switch cannot ask a
 * question on its way on.
 */
function Toggle({
	on,
	onLabel,
	offLabel,
	onClick,
	children,
	signal,
	className,
}: {
	on: boolean;
	onLabel: string;
	offLabel: string;
	onClick: () => void;
	children: React.ReactNode;
	signal?: boolean;
	className?: string;
}) {
	return (
		<Button
			variant={on && signal ? "default" : "secondary"}
			size="round"
			aria-label={on ? onLabel : offLabel}
			aria-pressed={on}
			onClick={onClick}
			className={cn("relative", !on && "text-fg-muted", className)}
		>
			{children}
		</Button>
	);
}
