import { hearing, settingFor, subscribe } from "@/live/hearing";
import { useSyncExternalStore } from "react";

/**
 * Read what has been decided about hearing people, and follow it while it
 * changes.
 *
 * Returns the reader rather than the settings, so that subscribing and reading
 * cannot come apart: a component that forgets to subscribe has no way to read
 * anything either, where a hook returning the values would let somebody call the
 * plain function and quietly stop re-rendering when they changed.
 *
 * Built on `useSyncExternalStore` for the same reason the roster is: the store
 * is written to from event handlers the media library fires during React's own
 * rendering, and this is the contract designed for that.
 */
export function useHearing(): typeof settingFor {
	useSyncExternalStore(subscribe, hearing, hearing);
	return settingFor;
}
