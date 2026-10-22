import { Audible } from "@/components/room/Audible";
import { ChatPanel } from "@/components/room/ChatPanel";
import { ControlBar } from "@/components/room/ControlBar";
import { Reacting } from "@/components/room/Reacting";
import { useHands, useReactions } from "@/live/hands";
import { EmptyRoom } from "@/components/room/EmptyRoom";
import { PictureMenu } from "@/components/room/PictureMenu";
import { Plane } from "@/components/room/Plane";
import { Hosting } from "@/components/room/HostPanel";
import { Watchers } from "@/components/room/Watchers";
import { RoomMenu } from "@/components/room/RoomMenu";
import { Signal } from "@/components/room/Signal";
import { useConnectionQuality } from "@/live/connection";
import { ShareCard } from "@/components/room/ShareCard";
import { ShareStrain } from "@/components/room/ShareStrain";
import { useShareStrain } from "@/live/strain";
import { SoundPanel } from "@/components/room/SoundPanel";
import { MusicPanel } from "@/components/room/MusicPanel";
import { WatchPanel } from "@/components/room/WatchPanel";
import { Tile } from "@/components/room/Tile";
import { WatchScreen } from "@/components/room/WatchScreen";
import { refusal } from "@/components/room/WatchTab";
import { t as say } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import { closeTheatre, hearShows, seenShow, subscribeShow } from "@/live/watch";
import { watchReady } from "@/live/watch-api";
import { useLingering } from "@/hooks/useLingering";
import { type Library, libraries as askLibraries } from "@/live/music";
import { mainland } from "@/live/relays";
import { closeDesk, deskState, hearDesks, subscribeDesk } from "@/live/jukebox";
import { isMusic } from "@/live/sound";
import { SaidInCorner } from "@/components/room/Said";
import { StageControls } from "@/components/room/StageControls";
import { SurfaceTile } from "@/components/room/SurfaceTile";
import { useChat } from "@/hooks/useChat";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useHearing } from "@/hooks/useHearing";
import { useMeasure } from "@/hooks/useMeasure";
import { usePagination } from "@/hooks/usePagination";
import { usePin } from "@/hooks/usePin";
import { useConnection, useRoster } from "@/hooks/useRoomState";
import { useSpeakingOrder } from "@/hooks/useSpeakingOrder";
import { useT } from "@/hooks/useT";
import { watch } from "@/live/notices";
import { impersonating } from "@/live/name";
import {
	ALONE_TOGETHER,
	ISLAND,
	TILES_PER_PAGE,
	clearOf,
	planClose,
	planFocus,
	planGrid,
	stripCapacity,
} from "@/live/plan";
import { silenced, soundOf } from "@/live/hearing";
import { type Surface, label, owner, surfaces } from "@/live/surface";
import { type Standing, useStanding } from "@/live/host";
import { useWatchers, useWatching } from "@/live/watching";
import { ConnectionState, type Room as LiveRoom } from "livekit-client";
import { useRoomForSide } from "@/hooks/useRoomFor";
import { placement, remember as rememberPlacement } from "@/live/controls";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export interface RoomProps {
	room: LiveRoom;
	/** What the machine holding this call is called, as the picker named it. */
	relay?: string;
	/** The machine holding the meeting, where the call is being forwarded to it. */
	carrying?: string;
	/** The region of the relay this browser chose, where known; see live/api.ts and live/relays.ts, mainland. */
	entry?: string;
	onLeave: () => void;
}

/*
 * How far above the bottom of the screen something has to sit to be clear of
 * the controls.
 *
 * The island's own offset, plus its height, plus a gap — spelled out rather
 * than rounded to a class, because the offset is a safe-area expression and a
 * phone with a home indicator moves the whole island up by a third of an inch.
 * plan.ts holds the same idea as ISLAND for the picture grid, measured from the
 * bar where it is drawn; this is the same arithmetic for the things drawn over
 * it, in CSS, and index.css repeats it for the notices.
 */
const CLEAR_OF_CONTROLS = "bottom-[calc(max(1.25rem,env(safe-area-inset-bottom)+0.5rem)+4rem)]";

/** The same room with the controls out of the way at the bottom. */
const NOTHING_TO_CLEAR = "bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.5rem))]";

/*
 * Where the share-strain card's lane ends while a panel is open beside it.
 *
 * From sm up a panel is a card at the right of the room, at the same z-20 and
 * drawn after the strain card, so over it: at 768 wide with Messages open the
 * chat card covered the whole of Switch and left only "Not now" to press, and
 * the wider panels did the same up to about 1050. So the card is centred in
 * what the panel leaves rather than under it — the panel's width plus the
 * right-3 it sits at, with the lane's own px-3 as the gap between them. Below
 * sm a panel is a sheet up the bottom edge, and covers the card as it covers
 * everything else in that half of the room until it is closed; lifted over the
 * sheet instead, the card would sit on the box somebody is typing in.
 *
 * Spelled out per panel, because the classes have to appear whole for the
 * stylesheet to have them.
 */
const BESIDE_PANEL = {
	messages: "sm:right-[17.25rem]", // ChatPanel, w-66
	sound: "sm:right-[18.75rem]", // SoundPanel, w-72
	wide: "sm:right-[20.75rem]", // MusicPanel and WatchPanel, w-80
} as const;

export function Room({ room, relay, carrying, entry, onLeave }: RoomProps) {
	// Both here, because both are drawn in two places: the bar sends them and
	// the tiles show them. A reaction is an event, so holding it in each would
	// be two lists that drift apart; a hand is state on the roster, and reading
	// it twice would work and would still be two things to keep agreeing.
	const hands = useHands(room);
	const reactions = useReactions(room);

	// One at a time, because both float over the same corner and the second
	// would simply be drawn on top of the first.
	const [panel, setPanel] = useState<"messages" | "sound" | "music" | "watch">();

	// Whether this deployment has a music library this person may play from:
	// asked once, and absent -- no menu item, no panel -- wherever the answer
	// is no, which is most deployments and everybody not signed in.
	const [library, setLibrary] = useState<Library[]>();
	useEffect(() => {
		let live = true;
		void askLibraries().then((found) => {
			if (live) setLibrary(found);
		});
		return () => {
			live = false;
		};
	}, []);

	// The song desk: heard from whoever runs one, and closed with the call by
	// whoever runs it here. In an encrypted call it is nobody's to hear; see
	// live/jukebox.ts.
	useEffect(() => hearDesks(room, room.options.e2ee === undefined), [room]);
	useEffect(() => () => void closeDesk(room), [room]);
	const desk = useSyncExternalStore(subscribeDesk, () => deskState(room));
	const roster = useRoster(room);

	// Watching together: asked once whether this person can start it, heard
	// from whoever runs it, and closed with the call by whoever runs it here.
	const [canWatch, setCanWatch] = useState(false);
	useEffect(() => {
		let live = true;
		// Not in an encrypted call, where the show says and hears nothing: an
		// offer there led to a panel that could only say so.
		if (room.options.e2ee !== undefined) return;
		void watchReady().then((ready) => {
			if (live) setCanWatch(ready);
		});
		return () => {
			live = false;
		};
	}, []);
	useEffect(() => hearShows(room, (why) => actionFailed(say(refusal(why)))), [room]);
	useEffect(() => () => closeTheatre(room), [room]);
	const show = useSyncExternalStore(subscribeShow, () => seenShow(room));
	const openWatch = () => setPanel("watch");
	// Music somebody is playing whose desk this page has not heard of yet --
	// an encrypted call, where desks say nothing -- still wants a volume.
	const playingMusic = roster.some((one) => [...one.trackPublications.values()].some((publication) => isMusic(publication)));

	// Where the controls sit. Held here rather than read where they are drawn,
	// because what is drawn around them depends on it: a card that clears the
	// bottom of the screen has nothing to clear when they are down the side.
	const [where, setWhere] = useState(placement);

	// What the rest of the room has to work around. The same condition the bar
	// itself uses, because a panel that moves aside for a bar that stayed at the
	// bottom is a gap for nothing.
	//
	// The hook is called on its own line rather than after a short circuit: put
	// behind one, it stops being called the moment the setting is anything else,
	// and a hook that comes and goes takes the room down with it.
	const roomy = useRoomForSide();
	const aside = where === "side" && roomy;

	// How much of the foot of the room the controls take, as drawn; the bar
	// measures itself and says. See hooks/useIslandReserve.ts and ISLAND.
	const [island, setIsland] = useState(ISLAND);
	const chat = useChat(room, panel === "messages");
	const screen = useFullscreen<HTMLDivElement>();

	const chatting = panel === "messages";
	const listening = panel === "sound";

	// Arrivals, departures, and somebody taking the stage with a share.
	useEffect(() => watch(room), [room]);

	/*
	 * Said on the document, because the one thing that needs to know is a
	 * stylesheet. Notices sit along the bottom edge of a hand-held screen and so
	 * do these controls, and the notices have to clear them — which is a fact
	 * about this screen rather than about any component either of them can see.
	 */
	useEffect(() => {
		document.body.dataset.island = "";

		return () => {
			delete document.body.dataset.island;
		};
	}, []);

	const openChat = useCallback(() => {
		setPanel("messages");
		chat.markRead();
	}, [chat.markRead]);

	// Whether this browser runs the room. Asked once here and handed to both the
	// console in the corner and the leave button, because two callers asking
	// separately is two requests answering the same question and two answers
	// that can disagree for a few seconds after a handover.
	const standing = useStanding(room);

	return (
		/*
		 * The element that goes fullscreen, and it has to be this one.
		 *
		 * The ref used to sit on the div holding the pictures, several levels
		 * down inside Stage, which meant fullscreen showed the pictures and
		 * nothing else — the control island and the messages in the corner are
		 * both drawn outside it, and an element that is not inside the fullscreen
		 * element cannot be painted over it at all.
		 *
		 * That made two fixes inert at once. The controls were given the idle
		 * rule for fullscreen so that a pointer would bring them back, and they
		 * could not come back because they were not there; and moving every
		 * message to the corner took the last thing that showed a message during
		 * a fullscreen share, because the bubble it replaced had been on a tile,
		 * and tiles are inside.
		 *
		 * So the fullscreen element is the room: pictures, controls and corner
		 * together, which is also what somebody pressing it is asking for.
		 */
		<div ref={screen.ref} className="relative h-full">
			<Stage
				room={room}
				hands={hands}
				reactions={reactions}
				relay={relay}
				carrying={carrying}
				entry={entry}
				standing={standing}
				chat={chat}
				chatting={chatting}
				listening={listening}
				screen={screen}
				onClosePanel={() => setPanel(undefined)}
				onOpenSound={() => setPanel("sound")}
				music={panel === "music"}
				watchPanel={panel === "watch"}
				library={library}
				watchReady={canWatch}
				watching={show?.show.holder}
				onOpenWatch={openWatch}
				aside={aside}
				island={island}
			/>
			<ControlBar
				room={room}
				handUp={hands.mine}
				onRaise={hands.raise}
				onReact={reactions.react}
				chatting={chatting}
				unread={chat.unread}
				listening={listening}
				hidden={screen.active}
				onChat={() => (chatting ? setPanel(undefined) : openChat())}
				onListen={() => setPanel(listening ? undefined : "sound")}
				music={{
					open: panel === "music",
					// Everybody has a reason to open it once there is music --
					// to turn it down, or ask for a song -- and somebody who can
					// reach the library has one before there is.
					// And while the panel is open, so the button that opened it
					// is there to close it after the music has stopped.
					available: library !== undefined || desk !== undefined || playingMusic || panel === "music",
					playing: desk?.now !== undefined || playingMusic,
				}}
				onMusic={() => setPanel(panel === "music" ? undefined : "music")}
				watch={{
					open: panel === "watch",
					// Offered to whoever can start a show, and to everybody once
					// there is one -- to see what is on and add to it -- and while
					// its panel is open, so the button is there to close it.
					available: canWatch || show !== undefined || panel === "watch",
					playing: show?.show.playing === true,
				}}
				onWatchPanel={() => setPanel(panel === "watch" ? undefined : "watch")}
				onLeave={onLeave}
				host={standing.yours}
				where={where}
				onPlace={(chosen) => {
					setWhere(chosen);
					rememberPlacement(chosen);
				}}
				onReserve={setIsland}
			/>
			{/* Outside the stage on purpose: what people can hear must not depend
			    on what the layout happens to be drawing. */}
			<Audible room={room} />
		</div>
	);
}

function Stage({
	room,
	hands,
	reactions,
	chat,
	chatting,
	listening,
	screen,
	relay,
	carrying,
	entry,
	standing,
	aside,
	island,
	onClosePanel,
	onOpenSound,
	music,
	watchPanel,
	library,
	watchReady,
	watching,
	onOpenWatch,
}: {
	room: LiveRoom;
	/* Passed in rather than read again here. A reaction is an event held in a
	   list, and a second copy of that list in a second component is two lists
	   that drift — the bar sends them and this draws them, so there is one. */
	hands: ReturnType<typeof useHands>;
	reactions: ReturnType<typeof useReactions>;
	relay?: string;
	carrying?: string;
	entry?: string;
	standing: Standing;
	/** The controls are down the side, so nothing has to clear the bottom. */
	aside: boolean;
	/** How much of the foot of the room the controls take; see ISLAND. */
	island: number;
	chat: ReturnType<typeof useChat>;
	chatting: boolean;
	listening: boolean;
	screen: ReturnType<typeof useFullscreen<HTMLDivElement>>;
	onClosePanel: () => void;
	onOpenSound: () => void;
	/** The music panel is open. */
	music: boolean;
	/** The watch-together panel is open. */
	watchPanel: boolean;
	library?: Library[];
	/** Whether this person can start watching a video together. */
	watchReady: boolean;
	/** Who runs the show being watched together, if one is. */
	watching?: string;
	onOpenWatch: () => void;
}) {
	const t = useT();
	const heard = useHearing();
	const participants = useRoster(room);
	// Kept on screen for its exit, rather than gone the frame it is closed.
	const musicPanel = useLingering(music, 160);
	const watchingPanel = useLingering(watchPanel, 160);
	const state = useConnection(room);

	// Measured in the browser rather than reported by the server, because the
	// question it answers is about this end of the call.
	const connection = useConnectionQuality(room);
	const [measure, size] = useMeasure();

	// Whoever has spoken recently comes forward, but only once there are more
	// people than fit on a page. Below that the order holds still, since a grid
	// that rearranges itself when somebody speaks is worse than one that does
	// not.
	const crowded = participants.length > TILES_PER_PAGE;
	const ordered = useSpeakingOrder(participants, crowded);

	const all = surfaces(ordered, room.localParticipant.identity, watching);
	const { pinned, toggle, pin } = usePin(all);

	// Taking the last picture off the stage leaves nothing to fill the screen
	// with. The element holding it is the same one in either arrangement now, so
	// it no longer leaves on its own when the stage empties — and a screen still
	// filled by a grid nobody asked to see is one somebody has to press Escape to
	// get out of.
	const { exit } = screen;
	useEffect(() => {
		if (!pinned) exit();
	}, [pinned, exit]);

	// Worked out here rather than inside a tile, because the question is about
	// the room: whether anybody unsigned is wearing a name somebody else signed.
	// A tile can only see itself.
	const roster = participants.map((p) => ({ name: p.name ?? "", identity: p.identity }));
	const suspect = new Set(roster.filter((p) => impersonating(p, roster)).map((p) => p.identity));

	// Our own camera never pages away. Losing sight of your own picture because
	// the room got busy is disorienting, and it costs nothing since it renders
	// from the local capture.
	const self = all.find((surface) => surface.local && surface.kind === "camera");
	const mine = self && self.id !== pinned?.id ? [self] : [];
	const rest = all.filter((surface) => surface !== self && surface.id !== pinned?.id);

	// The filmstrip holds what the width allows; the grid holds a fixed nine.
	// Either way our own picture takes one of the places rather than being added
	// beyond them.
	const capacity = pinned ? stripCapacity(size) : TILES_PER_PAGE;
	const paged = usePagination(rest, Math.max(1, capacity - mine.length));
	const shown = [...mine, ...paged.items].map((surface) => surface.id);

	// Two people is not a grid of two, and on a phone the grid of two was
	// measured at fifty-six per cent of the screen. One person fills it and the
	// other is a card, which is what a telephone has always done.
	//
	// Named rather than asserted: the condition below and the picture it needs
	// are then one thing a reader can see is true, instead of two that have to
	// be checked against each other.
	const alone = all.length <= ALONE_TOGETHER ? rest[0] : undefined;



	const plan = pinned
		? planFocus(size, pinned.id, screen.active ? [] : shown, { fullscreen: screen.active, island })
		: alone
			? planClose(size, alone.id, self ? [self.id] : [], island)
			: planGrid(size, shown, island);

	// Somebody sharing their screen is two pictures. Whichever is not on the
	// stage is what the switch on the stage offers, and finding it here is the
	// only place that knows both the pin and the whole roster.
	const counterpart =
		pinned && pinned.kind !== "watch"
		? all.find(
				// Not the video watched together, which belongs to whoever runs
				// it but is not another picture of them.
				(surface) =>
					surface.id !== pinned.id && surface.kind !== "watch" && owner(surface).identity === owner(pinned).identity,
			)
		: undefined;

	// Whose share is on this screen, said out loud so the person sharing can be
	// told who is looking. The media server tells a publisher nothing about who
	// subscribed, so the only source for that list is the people watching.
	//
	// Only a share that is actually on the stage counts. A share sitting in the
	// strip as a card is a thing somebody has not opened, and counting it would
	// make the list say twelve people are watching a picture nobody has looked
	// at.
	const watched =
		pinned && pinned.kind === "screen" && !pinned.local ? owner(pinned).identity : undefined;

	useWatching(room, watched);


	// And, when we are the one sharing, everybody who says so.
	const sharing = all.some((surface) => surface.kind === "screen" && surface.local);
	const watchers = useWatchers(room, sharing);

	// Whether the line can carry that share. Read from this browser's own
	// sender, so it is only ever said to the person sharing. Held for its exit,
	// with the last thing it said, so it leaves rather than vanishing.
	const strain = useShareStrain(room, sharing);
	const strainCard = useLingering(strain.hint !== undefined, 180);
	const said = useRef(strain.hint);
	if (strain.hint) said.current = strain.hint;

	// Where the filmstrip begins, where there is one: the card goes above it
	// rather than above the controls, which is on top of it. See clearOf.
	const aboveStrip = pinned && !screen.active ? clearOf(plan, shown, size) : undefined;


	/**
	 * One picture, in whichever of its two forms suits where it is.
	 *
	 * Built for every surface in the room, not only the ones on screen: the plan
	 * decides where each goes, and a picture that is nowhere is simply moved out
	 * of sight. Rendering only what is visible is what used to make putting
	 * somebody on the stage cost a black screen.
	 */
	const tile = (surface: Surface) => {
		const onStage = surface.id === pinned?.id;

		// Our own pictures are never marked: nobody hears themselves, so there
		// is no setting behind the mark and it would be a symbol with no cause.
		// The video watched together is played here, not heard from anybody:
		// its volume is the player's own.
		if (surface.kind === "watch") {
			return (
				<Tile
					label={label(surface)}
					// On the stage its controls carry the title, and the name
					// sat on top of the play button.
					unlabelled={onStage}
					selected={onStage}
					onSelect={() => toggle(surface)}
					onExpand={onStage ? screen.toggle : undefined}
					overlay={
						onStage && (
							<StageControls
								other={undefined}
								onSwitch={pin}
								fullscreen={screen.active}
								onFullscreen={screen.toggle}
								fullscreenSupported={screen.supported}
							/>
						)
					}
				>
					<WatchScreen room={room} onStage={onStage} onOpenPanel={onOpenWatch} mainland={mainland(entry)} />
				</Tile>
			);
		}

		const quiet =
			!surface.local && silenced(heard(owner(surface).identity, soundOf(surface.kind)));

		if (surface.kind === "screen" && !onStage) {
			return (
				<ShareCard
					label={owner(surface).name || owner(surface).identity}
					silenced={quiet}
					onOpen={() => pin(surface)}
				/>
			);
		}

		return (
			<SurfaceTile
				surface={surface}
				unverified={suspect.has(owner(surface).identity)}
				silenced={quiet}
				selected={onStage}
				overlay={
					<>
						{/* Whose hand is up and what they just reacted with, drawn
						    from the same two places the bar sends them from. */}
						<Reacting
							hand={hands.raised.includes(owner(surface).identity)}
							reactions={reactions.shown
								.filter((one) => one.from === owner(surface).identity)
								.map((one) => one.what)}
						/>

						{onStage && (
							<StageControls
								other={counterpart}
								onSwitch={pin}
								fullscreen={screen.active}
								onFullscreen={screen.toggle}
								fullscreenSupported={screen.supported}
							/>
						)}
					</>
				}
				onSelect={() => toggle(surface)}
				onExpand={onStage ? screen.toggle : undefined}
			/>
		);
	};

	return (
		<main
			className={cn(
				"relative h-full",
				/*
				 * A lane for the controls, and the reason nothing else has to
				 * know about them.
				 *
				 * Everything that floats at the right of a room is positioned
				 * against this element: the paging arrows, the reaction bubbles,
				 * the messages card, the sound panel, the list of who has a share
				 * open. All five were written to sit at right-3, none of them
				 * knew the controls could be moved there, and choosing the side
				 * put the bar through every one of them — the messages card
				 * covered the lower half of it, leaving included, as soon as
				 * anybody said anything.
				 *
				 * Threading a flag into five components would fix it five times
				 * and leave the sixth to be written wrong. A margin here narrows
				 * the box they are all measured against, so the lane belongs to
				 * the bar and nothing inside can reach into it — including the
				 * pictures, which is right: a room with a strip of controls down
				 * the side is a narrower room.
				 */
				aside && "mr-[5.75rem]",
			)}
		>
			{/* Top left, out of the way of the room's own name in the middle and of
			    anything a menu opens on the right. Pointer events off on the frame so
			    it never eats a click meant for a picture underneath. */}
			{state === ConnectionState.Connected && (
				<div className="pointer-events-none absolute top-3 left-3 z-10">
					<Signal reading={connection} relay={relay} carrying={carrying} />
				</div>
			)}

			{/* The element that fills the screen. It holds the pictures and nothing
			    else, so a fullscreen stage is a stage rather than a room with its
			    chrome still attached. */}
			<RoomMenu>
				<div className="h-full w-full bg-bg">
					<Plane
					measure={measure}
					plan={plan}
					page={paged.page}
					pages={paged.pages}
					onNext={paged.next}
					onPrevious={paged.previous}
					tiles={all.map((surface) => ({
						id: surface.id,
						node:
							surface.kind === "watch" ? (
								<div className="size-full animate-arrive">{tile(surface)}</div>
							) : (
							<PictureMenu
								surface={surface}
								onStage={surface.id === pinned?.id}
								fullscreen={screen.active}
								fullscreenSupported={screen.supported}
								onToggleStage={() => toggle(surface)}
								onFullscreen={screen.toggle}
								onOpenSound={onOpenSound}
							>
								<div className="size-full animate-arrive">{tile(surface)}</div>
							</PictureMenu>
							),
					}))}
					/>
				</div>
			</RoomMenu>

			{/*
			  * The console for whoever runs this room, opposite the connection
			  * reading rather than beside it: one says how the call is going and
			  * the other does something about the people in it, and a row of two
			  * unrelated controls is a row somebody has to read to use either.
			  *
			  * Draws nothing at all for anybody who does not run the room, which
			  * is most people in most calls.
			  */}
			{state === ConnectionState.Connected && (
				<div className="pointer-events-none absolute top-3 right-3 z-20 flex justify-end">
					<Hosting room={room} standing={standing} />
				</div>
			)}

			{/*
			  * Who has our share open.
			  *
			  * Only while we are the one sharing, and to the right of the
			  * pictures rather than over them: a share is something being
			  * pointed at, and a panel across a corner of it covers whatever was
			  * there. Kept clear of the control bar at the bottom and of the
			  * connection reading at the top, both of which sit in the corners
			  * this would otherwise want.
			  */}
			{sharing && (
				<div className="pointer-events-none absolute top-16 right-3 bottom-24 flex items-start">
					<Watchers watchers={watchers} />
				</div>
			)}

			{/*
			  * That our share is more than our line carries, with one setting
			  * that would fit.
			  *
			  * Above the controls, beside the button that owns the setting, and
			  * clear of them the way the empty-room card is — and above the
			  * filmstrip as well where there is one, which begins where the
			  * controls end and which this used to cover whole, so nobody in it
			  * could be pressed. Never over the middle of the screen: the person
			  * reading it is presenting, and what is in front of them is what
			  * everybody else is looking at. Over the foot of the stage is the
			  * least of it, and the stage is their own share.
			  */}
			{strainCard.mounted && said.current && (
				<div
					className={cn(
						"pointer-events-none absolute inset-x-0 z-20 flex justify-center px-3",
						// Moved aside with the panel, and up and down with the
						// strip, rather than jumping, both ways.
						"transition-[right,bottom] duration-200 ease-out",
						aboveStrip === undefined && (aside ? NOTHING_TO_CLEAR : CLEAR_OF_CONTROLS),
						chatting
							? BESIDE_PANEL.messages
							: listening
								? BESIDE_PANEL.sound
								: musicPanel.mounted || watchingPanel.mounted
									? BESIDE_PANEL.wide
									: undefined,
					)}
					style={aboveStrip === undefined ? undefined : { bottom: aboveStrip }}
				>
					<ShareStrain
						hint={said.current}
						leaving={strainCard.leaving}
						busy={strain.busy}
						onSwitch={() => void strain.accept()}
						onDismiss={strain.decline}
					/>
				</div>
			)}

			{/* Placed over the grid rather than instead of it, so the self view
			    stays where it will be when somebody arrives.

			    Clear of the controls, which it was not. This card was written
			    when the controls were a footer the page laid out around; they
			    became a floating island later and this was not moved, so for
			    every release since, the one screen where somebody most needs the
			    link — alone in a room, waiting — had its button covered whole and
			    unpressable. It was never a phone problem; it was every screen. */}
			{rest.length === 0 && !pinned && state === ConnectionState.Connected && (
				<div
					className={cn(
						"pointer-events-none absolute inset-x-0 flex justify-center",
						aside ? NOTHING_TO_CLEAR : CLEAR_OF_CONTROLS,
					)}
				>
					<div className="pointer-events-auto">
						<EmptyRoom room={room} host={standing.yours} />
					</div>
				</div>
			)}

			{chatting && (
				<ChatPanel
					said={chat.all}
					onSay={chat.send}
					sending={chat.sending}
					offline={state !== ConnectionState.Connected}
					onClose={onClosePanel}
				/>
			)}

			{listening && <SoundPanel room={room} onClose={onClosePanel} />}

			{musicPanel.mounted && (
				<MusicPanel room={room} libraries={library} leaving={musicPanel.leaving} onClose={onClosePanel} />
			)}

			{watchingPanel.mounted && (
				<WatchPanel room={room} ready={watchReady} leaving={watchingPanel.leaving} onClose={onClosePanel} />
			)}

			{/* Everything said, for everybody. Not only for somebody with no tile
			    to borrow: a bubble on one tile in a grid is missed by a reader who
			    is looking at the shared screen, which is when a message matters
			    most. See Said.tsx. */}
			<SaidInCorner said={chat.arriving} />

			{state !== ConnectionState.Connected && (
				<div className="-translate-x-1/2 pointer-events-none absolute top-3 left-1/2 rounded-full bg-surface-hi px-3 py-1 text-fg-muted text-xs shadow">
					{state === ConnectionState.Reconnecting ? t("Reconnecting…") : t("Connecting…")}
				</div>
			)}
		</main>
	);
}
