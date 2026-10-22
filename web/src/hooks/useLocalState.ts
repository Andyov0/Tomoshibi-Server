import type { Room } from "livekit-client";
import { listening } from "@/live/sound";
import { RoomEvent } from "livekit-client";
import { useCallback, useSyncExternalStore } from "react";

/** What our own devices are doing. */
export interface LocalState {
	microphone: boolean;
	camera: boolean;
	screen: boolean;
	/** Sound shared on its own, to listen to together. */
	listening: boolean;
}

const EVENTS = [
	RoomEvent.LocalTrackPublished,
	RoomEvent.LocalTrackUnpublished,
	RoomEvent.TrackMuted,
	RoomEvent.TrackUnmuted,
] as const;

/**
 * Read our own device state from the room rather than from a local flag.
 *
 * The distinction matters: a button bound to its own state claims the camera is
 * on the moment it is clicked, and stays wrong if permission is refused or the
 * screen-share picker is cancelled. Reading what was actually published means
 * the control can only ever say what is true.
 */
export function useLocalState(room: Room | undefined): LocalState {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!room) return () => {};
			for (const event of EVENTS) room.on(event, onChange);
			return () => {
				for (const event of EVENTS) room.off(event, onChange);
			};
		},
		[room],
	);

	const snapshot = useCallback(() => (room ? cached(room) : OFF), [room]);

	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const OFF: LocalState = { microphone: false, camera: false, screen: false, listening: false };

// Cached per room, because useSyncExternalStore compares snapshots by identity.
const snapshots = new WeakMap<Room, LocalState>();

function cached(room: Room): LocalState {
	const local = room.localParticipant;
	const next: LocalState = {
		microphone: local.isMicrophoneEnabled,
		camera: local.isCameraEnabled,
		screen: local.isScreenShareEnabled,
		listening: listening(room) !== undefined,
	};

	const held = snapshots.get(room);
	if (
		held &&
		held.microphone === next.microphone &&
		held.camera === next.camera &&
		held.screen === next.screen &&
		held.listening === next.listening
	) {
		return held;
	}

	snapshots.set(room, next);
	return next;
}
