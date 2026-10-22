import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GAP, ISLAND } from "@/live/plan";
import { islandReserve, useIslandReserve } from "./useIslandReserve";

/*
 * What the pictures are laid out clear of is read off the controls as drawn,
 * because both halves of it move: the distance from the edge is a safe-area
 * expression and the height steps down at narrow widths. A figure written down
 * once was ten pixels short on a laptop and thirty-two on an iPhone; see
 * live/plan.ts, ISLAND.
 */

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
});

/** An element as the browser would report it: its resolved bottom, and its height. */
function drawn(bottom: string, height: number): HTMLElement {
	const element = document.createElement("footer");
	element.style.bottom = bottom;
	Object.defineProperty(element, "offsetHeight", { value: height });
	document.body.append(element);
	return element;
}

describe("islandReserve", () => {
	it("is the distance from the edge, the height, and a gap", () => {
		// An iPhone: a 34-pixel home indicator and eight more.
		expect(islandReserve(drawn("42px", 58))).toBe(42 + 58 + GAP);
		// A laptop.
		expect(islandReserve(drawn("20px", 58))).toBe(20 + 58 + GAP);
	});

	it("is the figure for nothing measured where there is nothing to measure", () => {
		expect(islandReserve(drawn("", 58))).toBe(ISLAND);
		expect(islandReserve(drawn("20px", 0))).toBe(ISLAND);
	});
});

function Bar({ side, report, element }: { side: boolean; report: (reserve: number) => void; element: HTMLElement }) {
	const ref = useRef<HTMLElement>(element);
	useIslandReserve(ref, side, report);
	return null;
}

describe("useIslandReserve", () => {
	it("says what it measured, and the figure for nothing measured while the controls are down the side", () => {
		const report = vi.fn();
		const element = drawn("42px", 58);

		const { rerender } = render(<Bar side={false} report={report} element={element} />);
		expect(report).toHaveBeenLastCalledWith(42 + 58 + GAP);

		rerender(<Bar side report={report} element={element} />);
		expect(report).toHaveBeenLastCalledWith(ISLAND);
	});

	it("measures again when the window turns, which moves the safe area without resizing anything", () => {
		const report = vi.fn();
		const element = drawn("42px", 58);
		render(<Bar side={false} report={report} element={element} />);

		element.style.bottom = "20px";
		window.dispatchEvent(new Event("resize"));
		expect(report).toHaveBeenLastCalledWith(20 + 58 + GAP);
	});
});
