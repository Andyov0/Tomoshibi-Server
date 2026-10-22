import { ROSTER_EVENTS, roster } from "@/live/room";
import type { Participant, Room } from "livekit-client";
import { ConnectionState } from "livekit-client";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Re-render when the roster changes.
 *
 * Built on `useSyncExternalStore` rather than an effect that calls `setState`,
 * because the room is an event emitter that fires during React's own rendering
 * on connect. The store contract is the one designed for that.
 *
 * The snapshot is cached and only replaced when something meaningful changed,
 * since `useSyncExternalStore` compares by identity and a fresh array every read
 * would loop forever.
 */
export function useRoster(room: Room | undefined): Participant[] {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!room) return () => {};
			for (const event of ROSTER_EVENTS) room.on(event, onChange);
			return () => {
				for (const event of ROSTER_EVENTS) room.off(event, onChange);
			};
		},
		[room],
	);

	const snapshot = useCallback(() => (room ? cached(room) : EMPTY), [room]);

	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether the connection is up, for the banner over the stage. */
export function useConnection(room: Room | undefined): ConnectionState {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!room) return () => {};
			room.on("connectionStateChanged", onChange);
			return () => {
				room.off("connectionStateChanged", onChange);
			};
		},
		[room],
	);

	return useSyncExternalStore(
		subscribe,
		() => room?.state ?? ConnectionState.Disconnected,
		() => ConnectionState.Disconnected,
	);
}

const EMPTY: Participant[] = [];

// One cached snapshot per room, replaced only when the roster really moved.
const snapshots = new WeakMap<Room, { key: string; value: Participant[] }>();

function cached(room: Room): Participant[] {
	const value = roster(room);
	const key = value
		.map((p) => {
			const tracks = [...p.trackPublications.values()]
				.map((t) => `${t.source}:${t.isMuted ? "m" : "u"}:${t.isSubscribed ? "s" : "-"}`)
				.sort()
				.join(",");
			return `${p.identity}|${p.name}|${p.isSpeaking ? "!" : ""}|${tracks}`;
		})
		.join(";");

	const held = snapshots.get(room);
	if (held?.key === key) return held.value;

	snapshots.set(room, { key, value });
	return value;
}
