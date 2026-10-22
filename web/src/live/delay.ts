/**
 * A cushion under a shared screen: what arrives of it is held a fifth of a
 * second before it is drawn.
 *
 * On for every share this browser receives, since 2026-10-14. It was tried
 * first behind a switch only a test could reach, because what it costs was
 * certain and what it buys was not; the owner chose on the measurements below.
 *
 * What it is: the browser holds what arrives of a share for a set time before
 * drawing it (`RTCRtpReceiver.jitterBufferTarget`), so a packet lost on the way
 * has that long to be asked for again and arrive before its frame is due, and
 * frames that arrive bunched are drawn evenly. Nothing about the picture
 * changes — its size, its rate and its sharpness are whatever was sent.
 *
 * What it costs: everybody watching sees and hears the share that much later
 * than it happens. The share's sound is held by the same amount so the two stay
 * together; a voice explaining what is on the screen is a different track and is
 * not held, so it runs that much ahead of the picture it describes. Cameras and
 * microphones are never held: the conversation itself is not made later for the
 * sake of the screen, which is the cost the owner did not accept.
 *
 * Why it needs the relays: a retransmission can only be asked for and answered
 * if the server still has the packet, and until the relays keep 4000 packets of
 * video rather than 500 (2026-10-13), it did not have it for long enough to
 * matter at the rates a share is sent. The cushion and the server's memory are
 * one change or neither.
 *
 * Measured with both (Chrome 145, two headless browsers, the relays' settings,
 * a minute each, after a warm-up):
 *
 *   - 2026-10-13, a viewer 150 ms away losing 0.2% of packets, a 1440p share at
 *     sixty: without it 52 and 57 frames a second and 6.7 and 5.1 seconds frozen
 *     in the minute; with 200 ms, 59.9 and 59.8 and none. A hotel-like line,
 *     20 Mb/s losing 3%: 6.2 and 1.4 seconds frozen without it, 0.3 and none
 *     with it.
 *   - 2026-10-14, the acceptance runs, freezing in the minute without and with
 *     it: the hotel-like line, 4.56 and 3.55 seconds against 0.31 and 1.15; the
 *     person sharing 120 ms away and losing 0.2%, 16.2 and 6.3 against 4.9 and
 *     6.5; and the viewer in a macOS 26 virtual machine, 7.33 against 3.39 on
 *     the hotel-like line and 5.89 against 1.53 with the sharer far away. Less
 *     in five comparisons of six, and about the same in the sixth (6.3 against
 *     6.5). The frame rates are not comparable, because they follow whichever
 *     rung the server chose.
 *
 * The price, measured: the jitter buffer held 157 to 183 ms in every run with
 * it, on 10-14, where it had held about 50 to 100 without, so a picture and its
 * sound about a tenth of a second later.
 * Measured on a loopback with a shaper, not a real path, and on the picture
 * only — the test share had no sound, so the sound being held with it is read
 * from the code below rather than seen.
 *
 * The switch is still there, in local storage, read once when a call starts,
 * in milliseconds: `localStorage.setItem("meet-live.share-playout-ms", "0")`
 * turns it off, and a whole number from 1 to 1000 replaces the default. Kept
 * for measuring, and for the one browser where a tenth of a second matters more
 * than a freeze; nothing in the interface reaches it. Anything else kept there
 * — a word, a fraction, more than a second — says nothing, and the default
 * stands: a stray value is not somebody asking for it off.
 */

import { type RemoteTrack, type RemoteTrackPublication, type Room, RoomEvent, Track } from "livekit-client";
import { recall } from "@/lib/storage";

/** Where the switch is kept. The old product name, as every key here has. */
export const DELAY_KEY = "meet-live.share-playout-ms";

/** What every share is held by, unless the switch says otherwise. */
export const DEFAULT_MS = 200;

/** More than this is not a cushion but a broadcast, and is refused. */
const MOST_MS = 1000;

/** The cushion to hold shares by: the switch's, or the default; nothing means off. */
export function shareDelay(): number {
	// `recall` reads a refusing storage as nothing kept, which is the default:
	// a browser that will not remember is held like any other.
	const kept = recall(DELAY_KEY);
	if (kept === null || kept.trim() === "") return DEFAULT_MS;

	const ms = Number(kept);
	if (ms === 0) return 0;
	return Number.isInteger(ms) && ms > 0 && ms <= MOST_MS ? ms : DEFAULT_MS;
}

/** Whether a receiver was given the cushion, by whichever name the browser has. */
export function cushion(receiver: RTCRtpReceiver | undefined, ms: number): boolean {
	if (!receiver) return false;

	// The standard name first, in milliseconds. Chrome's older one is in
	// seconds and is what the SDK's own setPlayoutDelay still writes; it is
	// kept for a browser that has only that.
	if ("jitterBufferTarget" in receiver) {
		receiver.jitterBufferTarget = ms;
		return true;
	}

	const old = receiver as RTCRtpReceiver & { playoutDelayHint?: number };
	if ("playoutDelayHint" in old) {
		old.playoutDelayHint = ms / 1000;
		return true;
	}

	return false;
}

/**
 * Hold every share this browser receives, picture and sound, by `ms`.
 *
 * Returns the unsubscribe. Does nothing at all when `ms` is nothing, which is a
 * browser whose switch says off.
 */
export function cushionShares(room: Room, ms: number = shareDelay()): () => void {
	if (!ms) return () => {};

	const hold = (track: RemoteTrack | undefined, publication: RemoteTrackPublication) => {
		if (publication.source !== Track.Source.ScreenShare && publication.source !== Track.Source.ScreenShareAudio) return;
		cushion(track?.receiver, ms);
	};

	const onSubscribed = (track: RemoteTrack, publication: RemoteTrackPublication) => hold(track, publication);

	for (const participant of room.remoteParticipants.values()) {
		for (const publication of participant.trackPublications.values()) hold(publication.track, publication);
	}

	room.on(RoomEvent.TrackSubscribed, onSubscribed);
	return () => {
		room.off(RoomEvent.TrackSubscribed, onSubscribed);
	};
}
