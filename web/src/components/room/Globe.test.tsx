import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Relay } from "@/live/relays";
import { Globe, wheelSays, ZOOM_MOST } from "./Globe";

/*
 * Zooming the servers' globe, which the owner asked for with a mouse's wheel
 * and with the Mac's trackpad both. Each browser says a trackpad's pinch its own
 * way (Chrome and Firefox as a wheel with ctrlKey, Safari as gesture events),
 * and a trackpad's two-finger swipe arrives as the same kind of wheel event as
 * a mouse's, so what is guarded here is what each of them does: the wheel and
 * the pinch zoom, the swipe turns, neither scrolls the page or zooms it from
 * under the globe, and the zoom stays between whole and six times.
 *
 * Read from the ocean's radius, which is the globe's radius times the zoom.
 */

const RELAYS = [
	{ name: "hk", url: "wss://hk.example.com", lat: 22.3, lon: 114.2 },
	{ name: "tokyo", url: "wss://tokyo.example.com", lat: 35.7, lon: 139.7 },
] as Relay[];

beforeAll(() => {
	// jsdom has neither; the globe captures the pointer that grabs it.
	Element.prototype.setPointerCapture ??= vi.fn();
	Element.prototype.releasePointerCapture ??= vi.fn();

	// Nor pointer events, without which a pointer's id never arrives and two
	// fingers read as one.
	if (typeof globalThis.PointerEvent === "undefined") {
		class PointerEvent extends MouseEvent {
			pointerId: number;
			constructor(type: string, init: PointerEventInit = {}) {
				super(type, init);
				this.pointerId = init.pointerId ?? 0;
			}
		}
		globalThis.PointerEvent = PointerEvent as unknown as typeof globalThis.PointerEvent;
	}
});

afterEach(() => vi.restoreAllMocks());

function drawn() {
	const view = render(<Globe relays={RELAYS} value="hk" onChange={vi.fn()} />);
	const svg = view.container.querySelector("svg") as SVGSVGElement;
	// The ocean is the first thing drawn inside the round lens the globe is
	// seen through, which keeps the globe's own radius whatever the zoom.
	const ocean = () => Number(svg.querySelector("g[clip-path] > circle")?.getAttribute("r"));
	const land = () => svg.querySelectorAll("path")[1]?.getAttribute("d") ?? "";
	return { svg, ocean, land };
}

function wheel(svg: Element, init: WheelEventInit) {
	const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
	act(() => {
		svg.dispatchEvent(event);
	});
	return event;
}

describe("wheelSays", () => {
	it("takes a trackpad's pinch for a zoom, in as the fingers part", () => {
		const said = wheelSays({ deltaMode: 0, deltaX: 0, deltaY: -12.5, ctrlKey: true });
		expect("zoom" in said && said.zoom > 1).toBe(true);
	});

	it("takes a mouse's wheel for a zoom, in lines or in whole steps", () => {
		const lines = wheelSays({ deltaMode: 1, deltaX: 0, deltaY: 3, ctrlKey: false });
		const pixels = wheelSays({ deltaMode: 0, deltaX: 0, deltaY: -100, ctrlKey: false });
		expect("zoom" in lines && lines.zoom < 1).toBe(true);
		expect("zoom" in pixels && pixels.zoom > 1).toBe(true);
	});

	it("takes two fingers moving on a trackpad for a turn", () => {
		expect(wheelSays({ deltaMode: 0, deltaX: 14.25, deltaY: -3.5, ctrlKey: false })).toEqual({
			turn: { x: 14.25, y: -3.5 },
		});
	});
});

describe("Globe", () => {
	it("zooms in under a pinch and a wheel, and not the page", () => {
		const { svg, ocean } = drawn();
		expect(ocean()).toBe(100);

		const pinch = wheel(svg, { deltaY: -50, ctrlKey: true });
		expect(ocean()).toBeGreaterThan(100);
		expect(pinch.defaultPrevented, "the browser would zoom the whole page under the pinch").toBe(true);

		const before = ocean();
		const notch = wheel(svg, { deltaY: -100 });
		expect(ocean()).toBeGreaterThan(before);
		expect(notch.defaultPrevented, "the page would scroll under the wheel").toBe(true);
	});

	it("stays between whole and six times", () => {
		const { svg, ocean } = drawn();

		wheel(svg, { deltaY: -5000, ctrlKey: true });
		expect(ocean()).toBe(100 * ZOOM_MOST);

		wheel(svg, { deltaY: 5000, ctrlKey: true });
		expect(ocean()).toBe(100);
	});

	it("turns under two fingers moving on a trackpad, without zooming", () => {
		const { svg, ocean, land } = drawn();
		const before = land();

		const swipe = wheel(svg, { deltaX: 40.5, deltaY: 0.5 });
		expect(ocean()).toBe(100);
		expect(land()).not.toBe(before);
		expect(swipe.defaultPrevented).toBe(true);
	});

	it("zooms under Safari's pinch, from where it was when the pinch began", () => {
		const { svg, ocean } = drawn();

		const gesture = (type: string, scale: number) => {
			const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale });
			act(() => {
				svg.dispatchEvent(event);
			});
			return event;
		};

		gesture("gesturestart", 1);
		const change = gesture("gesturechange", 2);
		expect(ocean()).toBe(200);
		expect(change.defaultPrevented).toBe(true);

		// The wheel Safari may send alongside the same pinch is not counted again.
		wheel(svg, { deltaY: -50, ctrlKey: true });
		expect(ocean()).toBe(200);

		gesture("gestureend", 2);
	});

	it("zooms under two fingers apart on a touch screen", () => {
		const { svg, ocean } = drawn();

		fireEvent.pointerDown(svg, { pointerId: 1, clientX: 100, clientY: 100 });
		fireEvent.pointerDown(svg, { pointerId: 2, clientX: 140, clientY: 100 });
		fireEvent.pointerMove(svg, { pointerId: 2, clientX: 180, clientY: 100 });

		expect(ocean()).toBe(200);

		fireEvent.pointerUp(svg, { pointerId: 2 });
		fireEvent.pointerUp(svg, { pointerId: 1 });
	});
});
