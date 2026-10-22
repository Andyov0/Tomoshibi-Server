import { useCallback, useState } from "react";

export interface Size {
	width: number;
	height: number;
}

/**
 * Measure an element as it resizes.
 *
 * Uses a callback ref rather than an object ref and an effect, so measurement
 * begins the moment the element exists instead of after the first paint. The
 * difference is visible: with an effect the layout is computed against a size of
 * zero once, and every tile animates out of the corner.
 */
export function useMeasure(): [(element: Element | null) => void, Size] {
	const [size, setSize] = useState<Size>({ width: 0, height: 0 });

	const ref = useCallback((element: Element | null) => {
		if (!element) return;

		const update = (rect: { width: number; height: number }) => {
			// Rounded before comparing, because a resize observer reports
			// fractional pixels that differ every frame during a drag, and each
			// distinct value would be another render.
			const width = Math.round(rect.width);
			const height = Math.round(rect.height);

			setSize((held) => (held.width === width && held.height === height ? held : { width, height }));
		};

		update(element.getBoundingClientRect());

		const observer = new ResizeObserver(([entry]) => {
			if (entry) update(entry.contentRect);
		});

		observer.observe(element);

		// React 19 calls a cleanup returned from a ref callback; on 18 it does
		// not, and the observer is collected with the element instead. Returning
		// it costs nothing either way and disconnects promptly where supported.
		return () => observer.disconnect();
	}, []);

	return [ref, size];
}
