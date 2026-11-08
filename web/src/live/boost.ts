import { RemoteAudioTrack, type Room, RoomEvent, type RemoteTrack } from "livekit-client";
import { wake } from "./speakers";

/**
 * Somebody turned up past how they were sent, up to three times (hearing.ts,
 * MAX_VOLUME; the owner asked for it on 2026-11-05).
 *
 * An element plays at most as loud as it was given, and throws on anything
 * above one, so a sound above one goes through a gain node instead: the
 * library's own Web Audio path for one track (`setAudioContext`), the gain on
 * one context this page makes for it. Only those tracks, and only while they
 * are above one. Every other sound stays on its element, because remote audio
 * sent through Web Audio is out of reach of the browser's echo cancelling
 * (speakers.ts says why the room does not mix that way): somebody turned up on
 * speakers may hear themselves back, which the slider says when it goes past
 * one.
 *
 * The library's attach() mutes an element it connects through a context, but
 * setAudioContext() on a track already playing does not, and the sound came out
 * twice, element and gain together; so the element is muted here when a track
 * goes through the gain, and unmuted when it comes back. Muted, an element
 * still plays the stream, which is what keeps a remote track flowing into Web
 * Audio at all.
 *
 * The context is sent where the room's sound is, and follows it when somebody
 * picks other speakers; it is resumed by the press that starts the room's sound
 * (speakers.ts, wake).
 */
export interface Booster {
	/** Play this track at this volume: through its element up to one, through the gain above. */
	set(track: RemoteAudioTrack, volume: number): void;
	/** Every track back on its element, the context closed. */
	stop(): void;
}

type Sinking = AudioContext & { setSinkId?: (id: string) => Promise<void> };

export function booster(room: Room): Booster {
	let context: Sinking | undefined;
	let unwake: (() => void) | undefined;
	const up = new Set<RemoteAudioTrack>();

	const route = () => {
		if (!context || typeof context.setSinkId !== "function") return;
		const id = room.getActiveDevice("audiooutput");
		void context.setSinkId(id && id !== "default" ? id : "").catch(() => {});
	};

	const contextFor = (): AudioContext => {
		if (!context) {
			context = new AudioContext({ latencyHint: "interactive" }) as Sinking;
			unwake = wake(context);
			route();
		}
		return context;
	};

	const down = (track: RemoteAudioTrack) => {
		track.setAudioContext(undefined);
		for (const element of track.attachedElements) element.muted = false;
		up.delete(track);
	};

	const onDevice = (kind: MediaDeviceKind) => {
		if (kind === "audiooutput") route();
	};
	// A track gone is let go of here as well, rather than kept for good.
	const onGone = (track: RemoteTrack) => {
		if (track instanceof RemoteAudioTrack) up.delete(track);
	};
	room.on(RoomEvent.ActiveDeviceChanged, onDevice);
	room.on(RoomEvent.TrackUnsubscribed, onGone);

	return {
		set(track, volume) {
			if (volume > 1) {
				if (!up.has(track)) {
					track.setAudioContext(contextFor());
					for (const element of track.attachedElements) element.muted = true;
					up.add(track);
				}
				// On the gain now: any value up to MAX_VOLUME.
				track.setVolume(volume);
			} else if (up.has(track)) {
				down(track);
				track.setVolume(volume);
			}
		},
		stop() {
			room.off(RoomEvent.ActiveDeviceChanged, onDevice);
			room.off(RoomEvent.TrackUnsubscribed, onGone);
			for (const track of [...up]) {
				down(track);
				track.setVolume(1);
			}
			unwake?.();
			void context?.close().catch(() => {});
			context = undefined;
		},
	};
}
