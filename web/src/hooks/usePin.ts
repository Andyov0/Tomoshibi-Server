import type { Surface } from "@/live/surface";
import { useCallback, useEffect, useRef, useState } from "react";

export interface Pin {
	/** The surface filling the stage, or undefined for an even grid. */
	pinned: Surface | undefined;
	/** Pin a surface, or pass undefined to go back to the grid. */
	pin: (surface: Surface | undefined) => void;
	/** Toggle, which is what a double-click on a surface does. */
	toggle: (surface: Surface) => void;
}

/**
 * Decide which surface owns the stage.
 *
 * A screen share auto-pins itself, and un-pins when it stops. The subtlety worth
 * getting right, and the easy thing to miss: **only an automatic pin is cleared
 * automatically**. Once someone has pinned something by hand, a share starting
 * or stopping must not yank the stage out from under them.
 *
 * That is what `autoRef` tracks: it holds the id of the surface *we* pinned, and is
 * cleared the moment a human overrides it.
 */
export function usePin(surfaces: Surface[]): Pin {
	const [pinnedId, setPinnedId] = useState<string>();
	const autoRef = useRef<string>();

	const pin = useCallback((surface: Surface | undefined) => {
		// A manual choice, so stop treating the current pin as ours to revoke.
		autoRef.current = undefined;
		setPinnedId(surface?.id);
	}, []);

	const toggle = useCallback((surface: Surface) => {
		autoRef.current = undefined;
		setPinnedId((current) => (current === surface.id ? undefined : surface.id));
	}, []);

	useEffect(() => {
		// A video watched together takes the stage as a share does.
		const shares = surfaces.filter((surface) => surface.kind !== "camera");
		const auto = autoRef.current;

		if (auto === undefined) {
			// Nothing of ours on the stage. Claim it only if it is free: a manual pin
			// outranks a share that just started.
			if (shares.length > 0 && pinnedId === undefined) {
				const first = shares[0];
				if (first) {
					autoRef.current = first.id;
					setPinnedId(first.id);
				}
			}
			return;
		}

		// Ours is on the stage. Release it once that share is gone.
		if (!shares.some((surface) => surface.id === auto)) {
			autoRef.current = undefined;
			setPinnedId((current) => (current === auto ? undefined : current));
		}
	}, [surfaces, pinnedId]);

	// A pinned participant who leaves must not take the stage with them.
	const pinned = surfaces.find((surface) => surface.id === pinnedId);
	useEffect(() => {
		if (pinnedId !== undefined && !pinned) {
			autoRef.current = undefined;
			setPinnedId(undefined);
		}
	}, [pinnedId, pinned]);

	return { pinned, pin, toggle };
}
