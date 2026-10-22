import { type Resolved, type Unread, knownInfo, subscribeInfo, videoInfo } from "@/live/watch-api";
import { useEffect, useSyncExternalStore } from "react";

/** What a ticket plays: asked of the server once, and undefined until it answers. */
export function useVideoInfo(ticket: string | undefined): Resolved | Unread | undefined {
	useEffect(() => {
		if (ticket) videoInfo(ticket);
	}, [ticket]);
	return useSyncExternalStore(subscribeInfo, () => (ticket ? knownInfo(ticket) : undefined));
}
