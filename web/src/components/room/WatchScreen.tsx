import { Button } from "@/components/ui/button";
import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { useVideoInfo } from "@/hooks/useVideoInfo";
import { keep, recall } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { clock } from "@/live/music";
import { capping, watchQuality } from "@/live/preferences";
import {
	CLOSE_ENOUGH,
	type Seen,
	type Video,
	command,
	correction,
	expected,
	myTheatre,
	seenShow,
	subscribeShow,
} from "@/live/watch";
import { whenUnlocked } from "@/live/speakers";
import { type Resolved, askAgain, relayOnly } from "@/live/watch-api";
import { BUFFERING, ENDED, PLAYING, type YouTubePlayer, youtubeApi } from "@/live/youtube";
import type { Room } from "livekit-client";
import { Clapperboard, CloudOff, ListVideo, Loader2, Pause, Play, SkipForward, Volume2, VolumeX } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * The video everybody is watching, as this browser plays it.
 *
 * Each viewer plays the video themselves and keeps to the show's timeline; see
 * live/watch.ts. Where it plays from is decided here, by trying: the place the
 * video is, and if that fails -- an error, or a player that has still not
 * begun STALL_MS after it should have -- the same video relayed by the
 * deployment. YouTube is the one source whose addresses nobody else can use,
 * so it plays through YouTube's own player where YouTube can be reached and
 * through the relay otherwise.
 *
 * On a deployment that relays nothing there is no second place: a viewer
 * whose connection cannot reach the video is told so, and the player goes on
 * trying, since a connection that was slow rather than shut may yet get there.
 *
 * The controls drive the show, not this player: pressing pause asks the show
 * to pause, and everybody pauses. This player also does it at once, so the
 * press is felt without waiting for the show's answer to come back.
 */

/**
 * A player that has not begun to play this long after it should have is given
 * the relay. The same as the show's own wait for its holder (STARTING_MS): a
 * longer one was measured as twelve seconds of a spinner for a viewer whose
 * connection to the video's own servers was slow.
 */
export const STALL_MS = 8000;

/**
 * At most one jump in this long. A jump over the internet takes a while to land,
 * and YouTube's player goes on reporting where it was until it has: held to the
 * show every quarter second, it was asked to jump again and again.
 */
const SEEK_GAP_MS = 1500;

/** YouTube's player's errors for a video whose owner allows it on no other site. */
const EMBEDDING_REFUSED = [101, 150];

/** Why a video does not play for this viewer, where nothing is relayed. */
type Lost = "network" | "refused" | "failed";

/** How long YouTube's player is given to begin after being asked, before the browser is taken to have refused. */
const YOUTUBE_REFUSED_MS = 1500;

/** How often the player is held to the show. */
const KEEP_MS = 250;

/**
 * How many times a relay-only video that stopped partway is started again by
 * itself before the viewer is asked to. hls.js gives up on a piece only after
 * retrying it for about half a minute, so each of these is that long again: a
 * relay that has not come back in a minute and a half is said to have stopped,
 * with a press to try once more, rather than left as a spinner nobody explains.
 */
const RESUMES = 2;

/** Where a relay-only video that had been playing stands, once its relay stopped. */
type Halted = "resuming" | "stopped";

const VOLUME_KEY = "meet-live.watch-volume";

export function rememberedVolume(): number {
	// Nothing kept is null, which Number makes nought: see monitorVolume.
	const raw = recall(VOLUME_KEY);
	const kept = Number(raw);
	return raw != null && raw !== "" && Number.isFinite(kept) && kept >= 0 && kept <= 1 ? kept : 1;
}

/** One way of playing: a video element, or YouTube's player. */
interface Handle {
	time(): number;
	playing(): boolean;
	ready(): boolean;
	play(): Promise<void>;
	pause(): void;
	seek(to: number): void;
	rate(rate: number): void;
	currentRate(): number;
	volume(level: number): void;
	mute(on: boolean): void;
	/** Whether this one can run a little fast or slow; YouTube's cannot by small amounts. */
	nudges: boolean;
	youtube: boolean;
}

export function WatchScreen({
	room,
	onStage,
	onOpenPanel,
	mainland = false,
}: {
	room: Room;
	onStage: boolean;
	onOpenPanel: () => void;
	/** This call came in through a relay in mainland China; see Player. */
	mainland?: boolean;
}) {
	const t = useT();
	const seen = useSyncExternalStore(subscribeShow, () => seenShow(room));
	const video = seen?.show.now;
	const info = useVideoInfo(video?.ticket);

	// On the stage, a press on the video is for the video: it does not take it
	// off the stage, as a press on a picture does. Off it, the tile is a card,
	// and a press anywhere brings it up.
	const contain = (event: { stopPropagation(): void }) => {
		if (onStage) event.stopPropagation();
	};

	if (!seen || !video) {
		return (
			<div className="absolute inset-0 grid place-items-center bg-black" onClick={contain}>
				<div className="flex flex-col items-center gap-3 px-4 text-center text-fg-muted">
					<Clapperboard className="size-8" />
					<p className="text-sm">{t("Nothing is playing. Paste a video link to watch together.")}</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={(event) => {
							event.stopPropagation();
							onOpenPanel();
						}}
					>
						{t("Add a video")}
					</Button>
				</div>
			</div>
		);
	}

	if (info === undefined || typeof info === "string") {
		return (
			<div className="absolute inset-0 grid place-items-center bg-black text-white/70" onClick={contain}>
				{info !== undefined ? (
					<div className="flex flex-col items-center gap-3 px-4 text-center animate-fade-in">
						<p className="text-sm">
							{/* Not "try again" for a video that plays only through a
							    relay the server will not run for it: a bangumi
							    episode with the switch turned off, a film whose
							    grant was withdrawn. No retry plays either. */}
							{info === "unavailable"
								? t("That video cannot be played here.")
								: t("The video could not be read. Try again.")}
						</p>
						<Button
							variant="secondary"
							size="sm"
							onClick={(event) => {
								event.stopPropagation();
								command(room, { t: "skip", key: video.key });
							}}
						>
							{t("Next video")}
						</Button>
					</div>
				) : (
					<Loader2 className="size-6 animate-spin" />
				)}
			</div>
		);
	}

	// Keyed by the video, so the next one starts from a player of its own.
	return (
		<div className="absolute inset-0" onClick={contain}>
			<Player
				key={video.key}
				room={room}
				video={video}
				info={info}
				seen={seen}
				mainland={mainland}
				onOpenPanel={onOpenPanel}
			/>
		</div>
	);
}

function Player({
	room,
	video,
	info,
	seen,
	mainland,
	onOpenPanel,
}: {
	room: Room;
	video: Video;
	info: Resolved;
	seen: Seen;
	mainland: boolean;
	onOpenPanel: () => void;
}) {
	const t = useT();
	/*
	 * Straight to the relay, for a YouTube video and a viewer who came in
	 * through a relay in mainland China, where the server relays it at all.
	 *
	 * YouTube is the one source tried by waiting for it to fail: its player
	 * script either arrives or it does not, and from the mainland it does not,
	 * so every such viewer sat at a black tile for up to LOAD_MS, every video,
	 * before being given the relay they were always going to be given. Which
	 * relay a call came in through is the one honest thing a page knows about
	 * where its viewer is (the join says its region), and a mainland one says
	 * YouTube is not there.
	 *
	 * The relay then stands exactly as one fallen back to does: it is not a
	 * relay chosen for its quality, so it is held to the tile's size and is not
	 * abandoned for YouTube if it stalls — which from here would be the same
	 * wait again, and a restart of the relay after it. Only where the answer
	 * carried a relay: a ticket the server said it will not relay (X-Watch-Relay:
	 * off) has none, and its viewer goes on trying YouTube, which is all there
	 * is.
	 */
	const straightToRelay = mainland && info.play.kind === "youtube" && info.proxy !== undefined;
	const [relayed, setRelayed] = useState(info.relay || straightToRelay);
	const [blocked, setBlocked] = useState(false);
	/**
	 * Not playing for this viewer from where it is, with no relay to fall back
	 * on: their connection does not get there, or the site answered and would
	 * not play it -- its owner allows it on no other site, or it is gone --
	 * which no connection cures.
	 */
	const [unreachable, setUnreachable] = useState<false | Lost>(false);
	const sorry = useLingering(unreachable !== false, 160);
	/** What was said, kept while it leaves. */
	const said = useRef<Lost>("network");
	if (unreachable) said.current = unreachable;
	/** For the loop below, which outlives a render: a refused player is not asked again. */
	const refused = useRef(false);
	refused.current = unreachable === "refused" || unreachable === "failed";
	/** For a video that starts on the relay: whether the copy from where it is has been tried. */
	const triedDirect = useRef(false);
	const [volume, setVolumeState] = useState(rememberedVolume);
	const [muted, setMuted] = useState(false);
	const [now, setNow] = useState(0);
	const [scrubbing, setScrubbing] = useState<number>();
	const [waiting, setWaiting] = useState(true);

	const handle = useRef<Handle | undefined>(undefined);
	const latest = useRef(seen);
	latest.current = seen;
	/** Once this player has played at all, a later stall is buffering, not a source that does not work. */
	const played = useRef(false);
	/*
	 * A relay-only video whose relay stopped after it had played: hls.js gives
	 * up on a fatal error and loads nothing more, so the picture stood at its
	 * last frame for good, with nothing said, while the show went on. For a
	 * bangumi episode the relay is the only way it plays at all, and what
	 * stops it is the switch turned off partway, or the relay failing to
	 * renew Bilibili's addresses for longer than hls.js keeps retrying.
	 */
	const [halted, setHalted] = useState<false | Halted>(false);
	/*
	 * Said apart. While it is being started again the picture may still be
	 * playing from what was loaded before -- hls.js gives up half a minute
	 * after the relay does, with up to thirty seconds ahead of it -- so that
	 * is a note at the top, not a curtain over a moving picture. Stopped, it is
	 * a minute and a half later, the picture has long since stood still, and
	 * the press is the only way on.
	 */
	const resuming = useLingering(halted === "resuming", 160);
	const haltedFor = useLingering(halted === "stopped", 160);
	/** Times started again since it last played; see RESUMES. */
	const resumed = useRef(0);
	/** Starts the relay loading again, for the press once it has stopped. */
	const restart = useRef<(() => void) | undefined>(undefined);

	const videoElement = useRef<HTMLVideoElement>(null);
	const youtubeHost = useRef<HTMLDivElement>(null);

	const playsAsYoutube = info.play.kind === "youtube" && !relayed;
	// The relay, unless this is playing from where the video is: a relay-only
	// source -- a media server's film, a bangumi episode -- has nowhere else to
	// play from. Held to the player's size below like any relay this page did
	// not choose for its quality (info.relay is never set on one).
	const source =
		relayed || info.play.kind === "youtube" || relayOnly(info.play)
			? info.proxy
			: (info.play as { kind: "file" | "hls"; url: string });

	/** Where the video is has failed this viewer: the relay, or where there is none, saying so. */
	const giveUp = (why: Lost = "network") =>
		// The site's answer stands: a stall after it is that answer, not the connection.
		info.proxy ? setRelayed(true) : setUnreachable((was) => (was && was !== "network" ? was : why));

	// A video element, for a file or an HLS playlist, from where it is or relayed.
	useEffect(() => {
		if (playsAsYoutube || !source) return;
		const element = videoElement.current;
		if (!element) return;

		let stopped = false;
		let gaveUp = false;
		let destroy = () => {};
		// Given the relay once, and only while it has never played: a stall
		// after that is buffering, which the relay would not cure. Measured
		// before: any seek more than twelve seconds in moved a working direct
		// source onto the relay for good.
		const failed = (why: string) => {
			if (stopped || played.current) return;
			if (!relayed) {
				// Said once: with no relay, a stall goes on being one every second.
				if (gaveUp) return;
				gaveUp = !info.proxy;
				console.warn("watch: playing from where the video is failed", why, element.error?.code);
				giveUp();
			} else if (info.relay && !relayOnly(info.play) && !triedDirect.current) {
				// The relay was the first choice and failed: the lower quality
				// from where the video is, rather than nothing.
				console.warn("watch: the relay failed, playing from where the video is", why, element.error?.code);
				triedDirect.current = true;
				setRelayed(false);
			}
		};
		const errored = () => failed("error");
		const began = () => {
			played.current = true;
			resumed.current = 0;
			setUnreachable(false);
			setHalted(false);
		};
		const playable = () => myTheatre(room)?.ready(video.key);
		// Here, with the element it belongs to: a holder whose YouTube fell
		// back to the relay has an element only from then on, and an ending
		// it never heard left the whole room at the last frame.
		const ended = () => myTheatre(room)?.ended(video.key);

		element.addEventListener("error", errored);
		element.addEventListener("playing", began);
		element.addEventListener("canplay", playable);
		element.addEventListener("ended", ended);

		if (source.kind === "hls") {
			// hls.js wherever it can run, and the browser's own HLS only where it
			// cannot, which is iOS. Not the other way round: Chrome now says it
			// can play HLS itself, and given YouTube's playlist -- the picture
			// and the sound as separate renditions -- it sat at the first frame
			// with no error at all.
			void import("hls.js").then(({ default: Hls }) => {
				if (stopped) return;
				if (!Hls.isSupported()) {
					if (element.canPlayType("application/vnd.apple.mpegurl")) element.src = source.url;
					else failed("no HLS");
					return;
				}
				// Held to the size it is shown at, for a relay this page fell back
				// to: a film at four times the pixels the tile has is the
				// deployment's bandwidth spent on nothing anybody sees. Not for
				// one that starts on the relay because its better qualities come
				// no other way: there the deployment chose the quality, and the
				// connection alone decides how much of it -- 4K where it is.
				const hls = new Hls({ capLevelToPlayerSize: !info.relay, maxBufferLength: 30 });

				// And held to this viewer's own ceiling, where they set one on
				// their account page: a phone on a metered line has no use for
				// the 4K a fast connection would otherwise be given.
				//
				// Enforced on every change to the player's ceiling rather than
				// set once, because the size cap above is not set once either:
				// it rewrites the ceiling whenever the tile is resized, and going
				// full screen would otherwise lift it straight past the viewer's.
				// Only ever lowered (see capping), so the tile's smaller ceiling
				// still wins when it is the smaller one. Read when the video is
				// opened, so a change on the account page applies from the next.
				const ceiling = watchQuality();
				if (ceiling !== "auto") {
					const hold = () => {
						const next = capping(hls.autoLevelCapping, hls.levels, ceiling);
						if (next !== hls.autoLevelCapping) hls.autoLevelCapping = next;
					};
					hls.on(Hls.Events.MANIFEST_PARSED, hold);
					hls.on(Hls.Events.LEVELS_UPDATED, hold);
					hls.on(Hls.Events.MAX_AUTO_LEVEL_UPDATED, hold);
				}
				/*
				 * A relay-only video that stopped after it had played (see
				 * halted): the server is asked about the ticket again first,
				 * since the switch turned off or a grant withdrawn is no fault
				 * a retry cures -- told so, askAgain has the screen say the
				 * video cannot be played here, and this player is gone. Otherwise
				 * hls.js is set going again from where it stood, RESUMES times,
				 * and then the viewer is told it stopped and given a press.
				 * A fatal media error is recovered rather than reloaded, which is
				 * hls.js's own remedy for a decoder that choked.
				 */
				// One asking at a time: a second fatal error while the server is
				// being asked is the same stop, not another try.
				let asking = false;
				const resume = async (media: boolean) => {
					if (asking) return;
					asking = true;
					setHalted("resuming");
					const now = await askAgain(video.ticket);
					asking = false;
					if (stopped || now === "unavailable") return;
					if (resumed.current >= RESUMES) {
						setHalted("stopped");
						return;
					}
					resumed.current += 1;
					if (media) hls.recoverMediaError();
					else hls.startLoad();
				};
				restart.current = () => {
					resumed.current = 0;
					setHalted("resuming");
					hls.startLoad();
				};
				hls.on(Hls.Events.ERROR, (_event, data) => {
					// Said, without the address: what failed and how is what
					// anybody looking into a video that would not play needs.
					if (data.fatal) {
						console.warn("watch: the playlist failed", data.type, data.details, data.response?.code);
						if (played.current && relayOnly(info.play)) void resume(data.type === Hls.ErrorTypes.MEDIA_ERROR);
						else failed("playlist");
					}
				});
				hls.loadSource(source.url);
				hls.attachMedia(element);
				destroy = () => {
					restart.current = undefined;
					hls.destroy();
				};
			});
		} else {
			element.src = source.url;
		}

		handle.current = {
			nudges: true,
			youtube: false,
			time: () => element.currentTime,
			playing: () => !element.paused && !element.ended,
			ready: () => element.readyState >= 1,
			play: () => element.play(),
			pause: () => element.pause(),
			seek: (to) => {
				element.currentTime = to;
			},
			rate: (rate) => {
				if (element.playbackRate !== rate) element.playbackRate = rate;
			},
			currentRate: () => element.playbackRate,
			volume: (level) => {
				element.volume = level;
			},
			// muted rather than volume: on iOS a video's volume is the
			// hardware's and cannot be set from a page at all.
			mute: (on) => {
				element.muted = on;
			},
		};

		const started = Date.now();
		const stall = setInterval(() => {
			if (stopped || played.current || (relayed && !info.relay) || (relayed && triedDirect.current)) return;
			if (latest.current.show.playing && element.readyState < 3 && Date.now() - started > STALL_MS) failed("stalled");
		}, 1000);

		return () => {
			stopped = true;
			clearInterval(stall);
			element.removeEventListener("error", errored);
			element.removeEventListener("playing", began);
			element.removeEventListener("canplay", playable);
			element.removeEventListener("ended", ended);
			destroy();
			element.removeAttribute("src");
			element.load();
			handle.current = undefined;
		};
	}, [playsAsYoutube, source?.kind, source?.url, relayed, room, video.key, info.relay]);

	// YouTube's own player, where YouTube can be reached; the relay where it cannot.
	useEffect(() => {
		if (!playsAsYoutube || !info.play.id) return;
		const host = youtubeHost.current;
		if (!host) return;

		let stopped = false;
		let player: YouTubePlayer | undefined;
		let isReady = false;
		const mount = document.createElement("div");
		host.append(mount);
		const started = Date.now();

		youtubeApi().then(
			(api) => {
				if (stopped) return;
				player = new api.Player(mount, {
					videoId: info.play.id as string,
					width: "100%",
					height: "100%",
					playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
					events: {
						onReady: () => {
							isReady = true;
							handle.current = {
								nudges: false,
								youtube: true,
								time: () => player?.getCurrentTime() ?? 0,
								playing: () => player?.getPlayerState() === PLAYING || player?.getPlayerState() === BUFFERING,
								ready: () => isReady,
								// Asked through a message to another origin, which answers
								// nothing either way: whether the browser let it play is
								// read off the player a moment later; see keep.
								play: async () => player?.playVideo(),
								pause: () => player?.pauseVideo(),
								seek: (to) => player?.seekTo(to, true),
								rate: () => {},
								currentRate: () => 1,
								volume: (level) => player?.setVolume(Math.round(level * 100)),
								mute: (on) => (on ? player?.mute() : player?.unMute()),
							};
							myTheatre(room)?.ready(video.key);
						},
						onStateChange: (event) => {
							if (event.data === PLAYING) {
								played.current = true;
								setBlocked(false);
								setUnreachable(false);
							}
							if (event.data === ENDED) myTheatre(room)?.ended(video.key);
						},
						// Embedding refused, or the video unavailable here: the relay,
						// or where there is none, which of the two it was.
						onError: (event) => {
							console.warn("watch: YouTube's player refused the video", event.data);
							if (!stopped) giveUp(EMBEDDING_REFUSED.includes(event.data) ? "refused" : "failed");
						},
					},
				});
			},
			// The API's script never arrived: the usual way YouTube is
			// unreachable, and the quick one. youtubeApi gives up the moment
			// the script fails to load, or after LOAD_MS where the connection
			// hangs instead, which is what a viewer in mainland China meets;
			// either is before the STALL_MS below, which is for a player that
			// loaded and then never became ready.
			() => {
				if (!stopped) giveUp();
			},
		);

		// The API arrived but the player never became ready: the relay. A
		// player that is ready and refused a press is the browser's doing,
		// and is waited on; see blocked.
		const stall = setInterval(() => {
			if (stopped || played.current || !latest.current.show.playing) return;
			if (Date.now() - started > STALL_MS && !isReady) giveUp();
		}, 1000);

		return () => {
			stopped = true;
			clearInterval(stall);
			player?.destroy();
			mount.remove();
			handle.current = undefined;
		};
	}, [playsAsYoutube, info.play.id, video.key, room]);

	// Held to the show, a few times a second.
	const asked = useRef(0);
	const jumped = useRef(0);
	useEffect(() => {
		const jump = (player: Handle, to: number) => {
			if (Date.now() - jumped.current < SEEK_GAP_MS) return;
			jumped.current = Date.now();
			player.seek(to);
		};

		const keep = () => {
			const player = handle.current;
			const show = latest.current;
			if (!player?.ready() || refused.current) {
				setWaiting(true);
				// Where everybody is, for a viewer with nothing playing here.
				if (!video.live) setNow(expected(show));
				return;
			}
			setWaiting(false);

			const want = expected(show);
			const playing = show.show.playing;
			if (playing && !player.playing()) {
				// Started from where the show is, rather than from where this
				// player stood and then chased: measured, starting on the next
				// tick put every player about 0.4 s behind and five per cent fast
				// for the next eight seconds.
				if (!video.live && Math.abs(player.time() - want) > CLOSE_ENOUGH) jump(player, want);
				if (!asked.current) asked.current = Date.now();
				player.play().then(
					() => {
						if (!player.youtube) setBlocked(false);
					},
					// Refused by the browser for want of a press: one press will
					// do. Only that refusal: a source that will not play is not
					// cured by a press, and asking for one sent somebody pressing
					// at a video that could never start.
					(err: unknown) => {
						if (err instanceof DOMException && err.name === "NotAllowedError") setBlocked(true);
					},
				);
				// YouTube's answer is its state, not the promise: asked and still
				// not playing a moment later is refused. iOS refuses every play
				// not started by a press inside YouTube's own frame.
				if (player.youtube && Date.now() - asked.current > YOUTUBE_REFUSED_MS) setBlocked(true);
			} else if (!playing && player.playing()) {
				player.pause();
			}
			if (player.playing() || !playing) asked.current = 0;

			// Something live has no moment to agree on; only playing or not.
			if (!video.live) {
				const fix = correction(player.time(), want, playing, player.currentRate());
				if (fix.seek !== undefined) jump(player, fix.seek);
				else if (!player.nudges && playing && Math.abs(player.time() - want) > 1) jump(player, want);
				if (player.nudges) player.rate(fix.rate);
			}

			setNow(player.time());
		};

		const timer = setInterval(keep, KEEP_MS);
		keep();
		return () => clearInterval(timer);
	}, [video.live]);

	// Volume, this viewer's own.
	useEffect(() => {
		handle.current?.volume(volume);
		handle.current?.mute(muted);
	});

	// A refused video starts at any press on the page, as the call's sound does
	// (live/speakers.ts), rather than only at the one on its own overlay: a
	// call the page came back to by itself put a new video on screen that
	// nobody had pressed anything for. Not YouTube's, which iOS starts only
	// from a press inside its own frame.
	useEffect(() => {
		if (!blocked || playsAsYoutube) return;

		return whenUnlocked(() => {
			void handle.current?.play().then(
				() => setBlocked(false),
				() => {},
			);
		});
	}, [blocked, playsAsYoutube]);

	const playing = seen.show.playing;
	const shown = scrubbing ?? now;
	const length = video.duration || info.duration;

	const toggle = () => {
		// At once here, so the press is felt; the show's answer brings everybody else.
		if (playing) handle.current?.pause();
		else
			void handle.current?.play().catch((err: unknown) => {
				if (err instanceof DOMException && err.name === "NotAllowedError") setBlocked(true);
			});
		command(room, { t: playing ? "pause" : "play" });
	};

	const seekTo = (to: number) => {
		jumped.current = Date.now();
		handle.current?.seek(to);
		command(room, { t: "seek", to });
		setScrubbing(undefined);
	};

	const site = siteOf(info.link);

	// A refused YouTube player is started by a press on the player itself: one
	// on anything of this page's is not a press inside YouTube's frame, and iOS
	// lets only that start it. So the frame takes presses while it is refused.
	const tapYoutube = blocked && playsAsYoutube;

	return (
		<div className="group absolute inset-0 bg-black">
			{playsAsYoutube ? (
				// The iframe otherwise takes no presses: the controls below drive
				// the show, and YouTube's own would drive only this one player.
				<div
					ref={youtubeHost}
					className={cn("absolute inset-0 [&_iframe]:size-full", !tapYoutube && "[&_iframe]:pointer-events-none")}
				/>
			) : (
				<video ref={videoElement} playsInline className="absolute inset-0 size-full object-contain" />
			)}

			{waiting && !unreachable && halted !== "stopped" && (
				<div className="pointer-events-none absolute inset-0 grid place-items-center">
					<Loader2 className="size-6 animate-spin text-white/70" />
				</div>
			)}

			{sorry.mounted && (
				<div
					className={cn(
						"pointer-events-none absolute inset-0 grid place-items-center bg-black/85 px-4 text-center",
						sorry.leaving ? "animate-fade-out" : "animate-fade-in",
					)}
				>
					<div className="flex max-w-72 flex-col items-center gap-2 text-white">
						<CloudOff className="size-6 text-white/70" />
						<p className="text-sm">{t("This video does not reach you")}</p>
						<p className="text-white/60 text-xs">
							{/* Not "everybody else goes on watching" for what the site
							    refused: what it refuses here, it refuses everybody. */}
							{said.current === "refused" && site
								? t("It plays only on {site} itself.", { site })
								: said.current === "failed" && site
									? t("{site} would not play it here.", { site })
									: site
									? t("Your connection cannot reach {site}. Everybody else goes on watching.", { site })
									: t("Your connection cannot reach where it is. Everybody else goes on watching.")}
						</p>
						{/^https?:\/\//.test(info.link) && (
							<a
								href={info.link}
								target="_blank"
								rel="noopener noreferrer"
								onClick={(event) => event.stopPropagation()}
								className="pointer-events-auto text-white/80 text-xs underline underline-offset-2 hover:text-white"
							>
								{t("Open the link")}
							</a>
						)}
					</div>
				</div>
			)}

			{resuming.mounted && (
				<div
					className={cn(
						"pointer-events-none absolute inset-x-0 top-3 grid place-items-center",
						resuming.leaving ? "animate-fade-out" : "animate-fade-in",
					)}
				>
					<span className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm text-white">
						<Loader2 className="size-4 animate-spin" />
						{t("Reconnecting…")}
					</span>
				</div>
			)}

			{/* The curtain under the controls, and what it says above them: the
			    tile is often a strip of the screen not two hundred pixels tall,
			    where the controls -- there to the pointer even while they are
			    not shown -- cover its middle, and took the press meant for
			    "Try again". Everywhere else on the tile a press still reaches
			    the controls, so "Next video" is there for whoever would rather. */}
			{haltedFor.mounted && (
				<div
					className={cn(
						"pointer-events-none absolute inset-0 bg-black/85",
						haltedFor.leaving ? "animate-fade-out" : "animate-fade-in",
					)}
				/>
			)}
			{haltedFor.mounted && (
				<div
					className={cn(
						"pointer-events-none absolute inset-0 z-10 grid place-items-center px-4 text-center",
						haltedFor.leaving ? "animate-fade-out" : "animate-fade-in",
					)}
				>
					<div className="flex max-w-72 flex-col items-center gap-3 text-white">
						<CloudOff className="size-6 text-white/70" />
						<p className="text-sm">{t("The video stopped coming through.")}</p>
						<Button
							variant="secondary"
							size="sm"
							className="pointer-events-auto"
							onClick={(event) => {
								event.stopPropagation();
								restart.current?.();
							}}
						>
							{t("Try again")}
						</Button>
					</div>
				</div>
			)}

			{blocked &&
				!unreachable &&
				(tapYoutube ? (
					<div className="pointer-events-none absolute inset-x-0 top-3 grid place-items-center">
						<span className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm text-white">
							<Play className="size-4" />
							{t("Tap the video to join")}
						</span>
					</div>
				) : (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							void handle.current?.play().then(() => setBlocked(false));
						}}
						className="absolute inset-0 grid place-items-center bg-black/50 text-sm text-white"
					>
						<span className="flex items-center gap-2 rounded-full bg-white/15 px-4 py-2">
							<Play className="size-4" />
							{t("Press to join the video")}
						</span>
					</button>
				))}

			<div
				className={cn(
					"absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-3 pt-8 pb-2",
					"opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100",
					!playing && "opacity-100",
				)}
				// Presses and keys here are the controls', not the tile's: the
				// tile takes Enter and Space for itself, and a control that cannot
				// be worked from the keyboard is one some people cannot work.
				onClick={(event) => event.stopPropagation()}
				onDoubleClick={(event) => event.stopPropagation()}
				onKeyDown={(event) => event.stopPropagation()}
			>
				<div className="flex min-w-0 items-baseline gap-2 text-white">
					<span className="truncate font-medium text-[13px]">{info.title}</span>
					<span className="shrink-0 text-[11px] text-white/60">
						{[t("Added by {name}", { name: video.by }), relayed ? t("Relayed") : undefined].filter(Boolean).join(" · ")}
					</span>
				</div>

				{length > 0 && !video.live && (
					<input
						type="range"
						min={0}
						max={length}
						step={0.5}
						value={Math.min(shown, length)}
						aria-label={t("Position in the video")}
						onChange={(event) => setScrubbing(event.target.valueAsNumber)}
						onPointerUp={(event) => seekTo((event.target as HTMLInputElement).valueAsNumber)}
						onKeyUp={(event) => seekTo((event.target as HTMLInputElement).valueAsNumber)}
						className="w-full cursor-pointer accent-white"
					/>
				)}

				<div className="flex items-center gap-1 text-white">
					<Control label={playing ? t("Pause for everybody") : t("Play for everybody")} onClick={toggle}>
						{playing ? <Pause className="size-4" /> : <Play className="size-4" />}
					</Control>
					<Control label={t("Next video")} onClick={() => command(room, { t: "skip", key: video.key })}>
						<SkipForward className="size-4" />
					</Control>
					{/* The exact position as well, for whoever is checking two
					    players against each other: YouTube's frame cannot be read
					    from outside, and the clock shows whole seconds. */}
					<span className="px-1 text-[11px] text-white/80 tabular-nums" data-position={now.toFixed(2)}>
						{video.live ? t("Live") : length > 0 ? `${clock(shown)} / ${clock(length)}` : clock(shown)}
					</span>

					<span className="flex-1" />

					<Control label={muted ? t("Unmute the video") : t("Mute the video")} onClick={() => setMuted(!muted)}>
						{muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
					</Control>
					<input
						type="range"
						min={0}
						max={1}
						step={0.05}
						value={muted ? 0 : volume}
						aria-label={t("Video volume")}
						onChange={(event) => {
							setMuted(false);
							setVolumeState(event.target.valueAsNumber);
							keep(VOLUME_KEY, event.target.valueAsNumber === 1 ? undefined : String(event.target.valueAsNumber));
						}}
						className="hidden w-20 cursor-pointer accent-white sm:block"
					/>
					<Control label={t("Videos")} onClick={onOpenPanel}>
						<ListVideo className="size-4" />
					</Control>
				</div>
			</div>
		</div>
	);
}

/** The site a link is on, as people say it: "youtube.com", not "www.youtube.com". */
export function siteOf(link: string): string {
	try {
		const { protocol, hostname } = new URL(link);
		return protocol === "https:" || protocol === "http:" ? hostname.replace(/^www\./, "") : "";
	} catch {
		return "";
	}
}

function Control({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className="grid size-8 place-items-center rounded-full transition-colors hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white"
		>
			{children}
		</button>
	);
}
