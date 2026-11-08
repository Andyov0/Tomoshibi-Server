import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Choice, Group, Popover, usePresence } from "./Grouped";

/*
 * Rows that leave a list are kept for the length of their exit and then let
 * go. The fault this guards was found on the sign-in lockouts: a lift asks for
 * the list again at once, the list arrived inside the exit, and the timer that
 * would have let the lifted row go was cancelled by the list arriving. The
 * row stayed for good, invisible at the end of its animation, as a blank the
 * height of a row in the middle of the group.
 */

function List({ items }: { items: string[] }) {
	const shown = usePresence(items, (one) => one, 180);

	return (
		<ul>
			{shown.map(({ item, leaving }) => (
				<li key={item} data-leaving={leaving || undefined}>
					{item}
				</li>
			))}
		</ul>
	);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const drawn = (container: HTMLElement) => [...container.querySelectorAll("li")].map((li) => li.textContent);

describe("a row leaving a list", () => {
	it("is kept while it leaves, then let go", () => {
		const { container, rerender } = render(<List items={["a", "b"]} />);

		rerender(<List items={["b"]} />);
		expect(drawn(container)).toEqual(["a", "b"]);
		expect(container.querySelector("[data-leaving]")?.textContent).toBe("a");

		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(drawn(container)).toEqual(["b"]);
	});

	it("is let go even when the list is handed over again while it leaves", () => {
		const { container, rerender } = render(<List items={["a", "b"]} />);

		rerender(<List items={["b"]} />);
		act(() => {
			vi.advanceTimersByTime(50);
		});
		// The same list, asked for again: a new array holding the same rows.
		rerender(<List items={["b"]} />);

		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(drawn(container)).toEqual(["b"]);
	});

	it("comes back as itself if it returns while leaving", () => {
		const { container, rerender } = render(<List items={["a", "b"]} />);

		rerender(<List items={["b"]} />);
		rerender(<List items={["a", "b"]} />);

		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(drawn(container)).toEqual(["a", "b"]);
		expect(container.querySelector("[data-leaving]")).toBeNull();
	});
});

/*
 * A popover hung from a button inside a group. The group clips what is inside
 * it to its rounded corners, and the relays a person could be sent in through
 * were cut off at its edge, one name showing (2026-11-05): the sheet is on the
 * document now, placed against the button in the window's coordinates.
 */
describe("a popover in a group", () => {
	function Menu({ onPick }: { onPick: (what: string) => void }) {
		const [open, setOpen] = useState(false);
		return (
			<Group>
				<Popover
					open={open}
					onClose={() => setOpen(false)}
					align="right"
					trigger={
						<button type="button" onClick={() => setOpen((was) => !was)}>
							Move
						</button>
					}
				>
					{["Beijing", "Chengdu", "Hong Kong"].map((name) => (
						<Choice
							key={name}
							onClick={() => {
								onPick(name);
								setOpen(false);
							}}
						>
							{name}
						</Choice>
					))}
				</Popover>
			</Group>
		);
	}

	function at(button: Element, box: { top: number; bottom: number; left: number; right: number }) {
		vi.spyOn(button.parentElement as HTMLElement, "getBoundingClientRect").mockReturnValue({
			...box,
			x: box.left,
			y: box.top,
			width: box.right - box.left,
			height: box.bottom - box.top,
			toJSON: () => ({}),
		});
	}

	function tall(height: number) {
		return vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(height);
	}

	afterEach(() => vi.restoreAllMocks());

	it("is on the document, outside the group that would clip it", () => {
		const { container, getByText } = render(<Menu onPick={() => {}} />);
		fireEvent.click(getByText("Move"));

		const sheet = getByText("Chengdu").closest("div");
		expect(sheet).not.toBeNull();
		expect(container.contains(sheet)).toBe(false);
		expect(document.body.contains(sheet)).toBe(true);
		expect(sheet?.className).toContain("fixed");
	});

	it("takes a press on a choice, and closes on a press anywhere else", () => {
		const picked: string[] = [];
		const { getByText, queryByText } = render(<Menu onPick={(what) => picked.push(what)} />);

		fireEvent.click(getByText("Move"));
		fireEvent.pointerDown(getByText("Hong Kong"));
		fireEvent.click(getByText("Hong Kong"));
		expect(picked).toEqual(["Hong Kong"]);

		fireEvent.click(getByText("Move"));
		expect(getByText("Beijing")).toBeTruthy();
		fireEvent.pointerDown(document.body);
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(queryByText("Beijing")).toBeNull();
	});

	it("opens downward under its button, and upward where there is more room above", () => {
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
		tall(300);

		const low = render(<Menu onPick={() => {}} />);
		const button = low.getByText("Move");
		at(button, { top: 100, bottom: 132, left: 1000, right: 1032 });
		fireEvent.click(button);
		let sheet = low.getByText("Beijing").closest("div") as HTMLElement;
		expect(sheet.style.top).toBe("138px");
		expect(sheet.style.right).toBe("168px");
		low.unmount();

		const high = render(<Menu onPick={() => {}} />);
		const lower = high.getByText("Move");
		at(lower, { top: 700, bottom: 732, left: 1000, right: 1032 });
		fireEvent.click(lower);
		sheet = high.getByText("Beijing").closest("div") as HTMLElement;
		expect(sheet.style.top).toBe(`${700 - 6 - 300}px`);
		expect(sheet.className).toContain("origin-bottom");
	});

	it("scrolls within the window when it is taller than either side", () => {
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
		tall(900);

		const { getByText } = render(<Menu onPick={() => {}} />);
		const button = getByText("Move");
		at(button, { top: 150, bottom: 182, left: 10, right: 42 });
		fireEvent.click(button);
		const sheet = getByText("Beijing").closest("div") as HTMLElement;
		expect(sheet.style.maxHeight).toBe(`${400 - 182 - 6 - 8}px`);
		expect(sheet.className).toContain("overflow-y-auto");
	});
});
