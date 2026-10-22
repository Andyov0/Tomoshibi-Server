import { type RemoteParticipant, type Room, RoomEvent } from "livekit-client";
import { musicFactor, subscribeDuck } from "./duck";
import { settingFor, silenced, subscribe as onHearing } from "./hearing";
import { ASK_EVERY, CHANNELS, type Channel, Malformed, fromInt24, unpack } from "./lossless";
import type { Counts } from "./playout";
import { wake } from "./speakers";

/**
 * Hearing somebody's shared sound without loss.
 *
 * For each person whose sound share is offered losslessly (its Opus track is
 * named LOSSLESS), this browser asks for the stream, plays it through its own
 * audio context, and holds the Opus track back at the media server so the same
 * song is not downloaded twice or heard twice a second apart. holdsBack is how
 * the code that applies volumes and blocks (Audible.tsx) learns which Opus
 * tracks to leave off.
 *
 * It is lossless or it is nothing. A stream that has not started STALL_MS after
 * asking, has stopped for that long, or has a packet missing from its sequence
 * is given up on for the rest of that share, and the Opus track comes back. A
 * missing packet should not happen -- the channel is reliable and the media
 * server, as this deployment configures it, never drops from it -- but if one
 * does, twenty milliseconds of the song have gone, and carrying on would be
 * presenting a stream with a hole in it as the lossless one.
 *
 * Not offered in an encrypted call. The SDK encrypts media tracks there and,
 * with the options this project uses, not data packets, so the lossless stream
 * would cross the relay as plain samples in a call whose whole promise is that
 * the relay cannot hear it. The sharer's side never offers it in one either;
 * this side checks as well, because it is the side whose sound it would be.
 */

/** Seconds held before playing: enough for a retransmission across a border. */
const TARGET_SECONDS = 0.6;

/** Past this, whole packets are dropped back to the target. See playout.ts. */
const CEILING_SECONDS = 3;

/** Silence after asking, or between packets, that counts as the stream having failed. */
export const STALL_MS = 4000;

/**
 * Times playout may run dry in one share before the stream is given up on.
 *
 * One can be a burst of loss the retransmissions took longer than the buffer to
 * repair. Two means the path cannot carry the stream in real time: measured
 * from a machine reaching a mainland relay over the open internet, where loss
 * runs to tens of per cent, the reliable channel delivered about an eighth of
 * the stream's rate -- every sample correct, and the sound arriving in pieces
 * between long gaps. Packets kept coming, so STALL_MS never fired, and the
 * listener heard that instead of the Opus track, which is built for exactly
 * such a path.
 */
export const MAX_UNDERRUNS = 2;

/**
 * The share of real time a stream must arrive at, measured over SLOW_WINDOW_MS.
 *
 * The quicker of the two verdicts on a path that cannot carry the stream. A
 * second underrun takes a buffer fill, a play-out and another fill to arrive,
 * which on that path was ten seconds and more of sound in pieces; a stream
 * arriving at an eighth of its rate is plain in five. Half is far below what a
 * working path delivers even through a retransmission stall -- the paths that
 * worked never dipped below real time over any five seconds -- so it does not
 * mistake a hiccup for a path that cannot do it.
 */
export const SLOW_RATIO = 0.5;
export const SLOW_WINDOW_MS = 5000;

/**
 * How often to ask until the first packet comes.
 *
 * Far more often than the keep-alive, because an unanswered first ask is the
 * likeliest failure there is: it can cross the publication on the way and
 * arrive before the sender is listening, and waiting the full ASK_EVERY to
 * repeat it would outlast STALL_MS and give up on a stream that was fine.
 */
const ASK_UNTIL_ANSWERED = 1000;

/** What plays a stream. A seam for the tests, which have no audio thread. */
export interface Player {
	push(block: Float32Array[]): void;
	volume(level: number): void;
	close(): void;
	counts(): Counts | undefined;
	/** Whether it could not start: no worklet, or none that would load. */
	broken(): boolean;
	/**
	 * Whether the browser has kept it from starting for longer than STALL_MS:
	 * its context made where a press is wanted first, and none has come.
	 */
	held?(): boolean;
}

export type MakePlayer = (rate: number, channels: number) => Player;

interface Source {
	identity: string;
	channel: Channel;
	/** The publication this is about. A new share is a new publication and a fresh start. */
	publication: string;
	wanted: boolean;
	failed: boolean;
	askedAt: number;
	lastAsk: number;
	lastPacket: number;
	stream?: number;
	nextSeq?: number;
	player?: Player;
	/** Frames arrived since `windowStart`, against the rate they should arrive at. */
	windowStart?: number;
	windowFrames: number;
	rate: number;
}

/** Filed by person and by channel: somebody can be sharing an application's sound and playing music at once. */
const sources = new WeakMap<Room, Map<string, Source>>();

const keyOf = (identity: string, sound: Channel["sound"]) => `${sound}\n${identity}`;

/** Whether this person's Opus track for a sound should be held back, because the lossless one is playing. */
export function holdsBack(room: Room, identity: string, sound: Channel["sound"] = "screen"): boolean {
	return sources.get(room)?.get(keyOf(identity, sound))?.wanted === true;
}

/** How a person's lossless stream is doing, if one is being played. For the panel and the tests. */
export function losslessCounts(room: Room, identity: string, sound: Channel["sound"] = "screen"): Counts | undefined {
	return sources.get(room)?.get(keyOf(identity, sound))?.player?.counts();
}

/** How loud a stream plays: the listener's setting, and for music the duck; see duck.ts. */
function levelOf(source: Source): number {
	const volume = settingFor(source.identity, source.channel.sound).volume;
	return source.channel.sound === "music" ? volume * musicFactor(source.identity) : volume;
}

/** Whether this browser can play a lossless stream at all. */
export function canReceiveLossless(): boolean {
	return typeof AudioWorkletNode === "function" && typeof AudioContext === "function";
}

function losslessShare(participant: RemoteParticipant, channel: Channel) {
	for (const publication of participant.trackPublications.values()) {
		if (publication.source === channel.source && publication.trackName === channel.lossless) {
			return publication;
		}
	}

	return undefined;
}

/**
 * Start listening for lossless shares in a room. Returns the function that stops.
 *
 * `changed` is called whenever which Opus tracks to hold back has changed.
 */
export function receiveLossless(room: Room, changed: () => void, makePlayer: MakePlayer = audioPlayer): () => void {
	const mine = new Map<string, Source>();
	sources.set(room, mine);

	if (!canReceiveLossless() || room.options.e2ee !== undefined) {
		return () => sources.delete(room);
	}

	const ask = (source: Source, yes: boolean) => {
		room.localParticipant
			.publishData(new TextEncoder().encode(yes ? "1" : "0"), {
				reliable: true,
				topic: source.channel.ask,
				destinationIdentities: [source.identity],
			})
			.catch(() => {});
	};

	const giveUp = (source: Source) => {
		source.failed = true;
		source.player?.close();
		source.player = undefined;
		ask(source, false);
	};

	const refresh = () => {
		const now = Date.now();
		let moved = false;

		const offers = [...room.remoteParticipants.values()].flatMap((participant) =>
			CHANNELS.map((channel) => ({ participant, channel })),
		);

		for (const { participant, channel } of offers) {
			const identity = participant.identity;
			const key = keyOf(identity, channel.sound);
			const share = losslessShare(participant, channel);
			let source = mine.get(key);

			if (!share) {
				if (source) {
					source.player?.close();
					mine.delete(key);
					moved ||= source.wanted;
				}
				continue;
			}

			if (!source || source.publication !== share.trackSid) {
				source?.player?.close();
				source = {
					identity,
					channel,
					publication: share.trackSid,
					wanted: false,
					failed: false,
					askedAt: 0,
					lastAsk: 0,
					lastPacket: 0,
					windowFrames: 0,
					rate: 0,
				};
				mine.set(key, source);
			}

			const setting = settingFor(identity, channel.sound);
			let want = !source.failed && !silenced(setting);

			// Packets arriving for a player that cannot play is the same failure
			// as packets not arriving, and must come back to Opus just as surely:
			// otherwise the Opus track stays held back and nothing is heard.
			const stalled = now - Math.max(source.askedAt, source.lastPacket) > STALL_MS;
			const starved = (source.player?.counts()?.underruns ?? 0) >= MAX_UNDERRUNS;

			let slow = false;
			if (source.windowStart !== undefined && now - source.windowStart >= SLOW_WINDOW_MS) {
				const due = ((now - source.windowStart) / 1000) * source.rate;
				slow = source.windowFrames < SLOW_RATIO * due;
				source.windowStart = now;
				source.windowFrames = 0;
			}

			// A player the browser will not start, in a call whose other sound it
			// is playing, is a player that cannot play: the Opus track comes back
			// and is heard on an element that was allowed. That is a browser
			// asking for a press per thing that plays, after a call the page
			// came back to by itself — its elements were carried over from an
			// earlier press (live/speakers.ts) and this context could not be.
			// Where the call's sound is held back as well, it waits: the press
			// that starts one starts both, and the stream is still lossless.
			const held = Boolean(source.player?.held?.()) && room.canPlaybackAudio;

			if (want && source.wanted && (stalled || starved || slow || held || source.player?.broken())) {
				giveUp(source);
				want = false;
			} else if (want && !source.wanted) {
				source.askedAt = now;
				source.lastAsk = now;
				ask(source, true);
			} else if (want && now - source.lastAsk >= (source.lastPacket ? ASK_EVERY : ASK_UNTIL_ANSWERED)) {
				source.lastAsk = now;
				ask(source, true);
			} else if (!want && source.wanted && !source.failed) {
				source.player?.close();
				source.player = undefined;
				source.stream = undefined;
				ask(source, false);
			}

			if (want !== source.wanted) {
				source.wanted = want;
				moved = true;
			}

			source.player?.volume(levelOf(source));
		}

		for (const [key, source] of mine) {
			if (!room.remoteParticipants.has(source.identity)) {
				source.player?.close();
				mine.delete(key);
				moved ||= source.wanted;
			}
		}

		if (moved) changed();
	};

	const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
		const channel = CHANNELS.find((one) => one.topic === topic);
		if (!channel || !participant) return;

		const source = mine.get(keyOf(participant.identity, channel.sound));
		if (!source?.wanted) return;

		let block: ReturnType<typeof unpack>;
		try {
			block = unpack(payload);
		} catch (err) {
			if (err instanceof Malformed) return;
			throw err;
		}

		if (block.stream !== source.stream) {
			source.player?.close();
			source.player = makePlayer(block.rate, block.channels.length);
			source.player.volume(levelOf(source));
			source.stream = block.stream;
			source.nextSeq = block.seq;
			source.rate = block.rate;
			source.windowStart = Date.now();
			source.windowFrames = 0;
		}

		if (block.seq !== source.nextSeq) {
			giveUp(source);
			refresh();
			return;
		}

		source.nextSeq = block.seq + 1;
		source.lastPacket = Date.now();
		source.windowFrames += block.channels[0]?.length ?? 0;
		source.player?.push(block.channels.map((channel) => Float32Array.from(channel, fromInt24)));
	};

	const events = [
		RoomEvent.TrackPublished,
		RoomEvent.TrackUnpublished,
		RoomEvent.ParticipantConnected,
		RoomEvent.ParticipantDisconnected,
	] as const;

	for (const event of events) room.on(event, refresh);
	room.on(RoomEvent.DataReceived, onData);
	const unhear = onHearing(refresh);
	// The music's level moves under speech many times a second; only the
	// players' volumes follow it, not the whole of refresh.
	const unduck = subscribeDuck(() => {
		for (const source of mine.values()) if (source.channel.sound === "music") source.player?.volume(levelOf(source));
	});
	const timer = setInterval(refresh, 1000);
	refresh();

	return () => {
		clearInterval(timer);
		unhear();
		unduck();
		for (const event of events) room.off(event, refresh);
		room.off(RoomEvent.DataReceived, onData);
		for (const source of mine.values()) {
			source.player?.close();
			if (source.wanted) ask(source, false);
		}
		mine.clear();
		sources.delete(room);
	};
}

/** The real player: its own audio context at the stream's rate, and the worklet. */
function audioPlayer(rate: number, channels: number): Player {
	// At the stream's own rate, so nothing between the packet and the sound
	// card resamples it. Whatever the operating system does after that is the
	// same for every sound on the machine.
	const context = new AudioContext({ sampleRate: rate, latencyHint: "playback" });
	const gain = context.createGain();
	gain.connect(context.destination);

	let node: AudioWorkletNode | undefined;
	let latest: Counts | undefined;
	let early: Float32Array[][] = [];
	let closed = false;
	let broken = false;

	const post = (block: Float32Array[]) => {
		node?.port.postMessage(
			block,
			block.map((channel) => channel.buffer),
		);
	};

	// A context made outside a press can start suspended; the next press
	// anywhere on the page is enough to start it, and it is the page's one
	// listener for presses that does it. This used to listen for itself, to
	// one pointerdown, which on a touch screen arrives before the activation
	// rather than with it: by the rules the browsers publish, a first tap
	// there is refused and the listener is already gone, leaving the stream
	// silent with its Opus track held back. Read from the rules, not seen.
	const unwake = wake(context);
	const made = Date.now();
	let ran = context.state === "running";
	context.addEventListener("statechange", () => {
		if (context.state === "running") ran = true;
	});

	void (async () => {
		const { default: url } = await import("./playout.worklet.ts?worker&url");
		await context.audioWorklet.addModule(url);
		if (closed) return;

		node = new AudioWorkletNode(context, "tomoshibi-lossless", {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			outputChannelCount: [2],
			processorOptions: {
				channels,
				target: Math.round(TARGET_SECONDS * rate),
				ceiling: Math.round(CEILING_SECONDS * rate),
			},
		});
		node.port.onmessage = (event: MessageEvent<Counts>) => {
			latest = event.data;
		};
		node.connect(gain);

		for (const block of early) post(block);
		early = [];
	})().catch(() => {
		broken = true;
	});

	return {
		push(block) {
			if (node) post(block);
			else early.push(block);
		},
		volume(level) {
			// Eased rather than set: under speech it moves every few tens of
			// milliseconds, and a gain stepped that often is heard as clicks.
			gain.gain.setTargetAtTime(level, context.currentTime, 0.03);
		},
		close() {
			closed = true;
			unwake();
			void context.close().catch(() => {});
		},
		counts: () => latest,
		broken: () => broken,
		held: () => !ran && Date.now() - made > STALL_MS,
	};
}
