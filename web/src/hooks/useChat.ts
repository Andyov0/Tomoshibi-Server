import { KEEP, SAID_FOR, type Said, received } from "@/live/chat";
import type { ChatMessage, Participant, Room } from "livekit-client";
import { RoomEvent } from "livekit-client";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface Chat {
	/** Everything said this call, oldest first. */
	all: Said[];
	/** What is still on screen in the corner, oldest first. */
	arriving: Said[];
	/** Something arrived while the panel was closed. */
	unread: boolean;
	/** Send, resolving when the media server has it. */
	send: (body: string) => Promise<unknown>;
	/** A message is in flight. */
	sending: boolean;
	/** Called when the panel opens, which is what clears the mark. */
	markRead: () => void;
}

/**
 * Collect what is said during a call.
 *
 * Subscribes to the room's own chat event rather than going through the
 * library's `useChat`. That hook takes a room and looked like the right answer,
 * but it hands back an empty list unless the tree is wrapped in the provider it
 * expects, and this application deliberately owns its room object instead. The
 * event underneath it is two lines; the provider is not worth adopting for
 * them.
 *
 * Nothing is persisted. Messages live as long as this component does, which is
 * as long as the call, and the room they belong to stops existing at the same
 * moment for the same reason.
 */
export function useChat(room: Room | undefined, open: boolean): Chat {
	const [all, setAll] = useState<Said[]>([]);
	const [recent, setRecent] = useState<Said[]>([]);
	const [unread, setUnread] = useState(false);
	const [sending, setSending] = useState(false);

	useEffect(() => {
		if (!room) return;

		const onMessage = (message: ChatMessage, from?: Participant) => {
			const said = received(message, from, room.localParticipant.identity);

			// Trimmed as it grows rather than swept later: a long call otherwise
			// keeps every message mounted in the panel, and five hundred is more
			// than anybody scrolls back through.
			setAll((held) => {
				const next = [...held, said];
				return next.length > KEEP ? next.slice(-KEEP) : next;
			});

			// Our own words are not news to us. Floating them over our own
			// picture covers a face to repeat something we just typed.
			if (said.mine) return;

			setRecent((held) => [...held, said]);
			if (!open) setUnread(true);

			// Each message clears itself rather than a sweep over the list, so
			// one that arrived late is not cut short by an earlier one.
			setTimeout(() => {
				setRecent((held) => held.filter((other) => other.id !== said.id));
			}, SAID_FOR);
		};

		room.on(RoomEvent.ChatMessage, onMessage);
		return () => {
			room.off(RoomEvent.ChatMessage, onMessage);
		};
	}, [room, open]);

	/*
	 * What the corner shows, in the order it was said.
	 *
	 * This used to be a Map keyed by identity, because a message was drawn on
	 * its speaker's own picture and the picture had to be able to ask for its
	 * own. The corner replaced that, and flattening a Map to feed it produced a
	 * conversation ordered by speaker: two people talking in turn came out as
	 * everything the first said and then everything the second did, and the
	 * "same person again" rule that drops the second face then invented runs
	 * that never happened. `recent` is already in arrival order; the grouping
	 * had no remaining reader.
	 *
	 * Nothing is shown while the panel is open, which is the one part of the old
	 * rule that survives: the same sentence in two places makes the reader decide
	 * twice whether they have seen it.
	 */
	const arriving = useMemo(() => (open ? [] : recent), [recent, open]);

	const send = useCallback(
		async (body: string) => {
			if (!room) return;

			setSending(true);
			try {
				await room.localParticipant.sendChatMessage(body.trim());
			} finally {
				setSending(false);
			}
		},
		[room],
	);

	const markRead = useCallback(() => setUnread(false), []);

	return { all, arriving, unread, send, sending, markRead };
}
