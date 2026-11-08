import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Room } from "livekit-client";
import { afterEach, describe, expect, it } from "vitest";
import { HandButton } from "./HandButton";
import { Leaving } from "./Leaving";

/*
 * Two things on the island that open by hand rather than through Radix, and
 * how they close.
 *
 * Neither closed on a press elsewhere. The reactions closed only on their own
 * caret, so somebody who opened them and thought better of it had a row of
 * faces over their own picture until they found it again; screenshots of the
 * call caught them still open behind three menus opened after them. The leave
 * question did have a way out by a press elsewhere, as a transparent layer over
 * the window — fixed to the window by its class, and so, inside an island that
 * is transformed and blurred, fixed to the island instead: a press on the
 * pictures went straight through with the question still asked. jsdom lays
 * nothing out, so that cause cannot be shown here; what is held is that a press
 * outside, wherever it lands, is what closes them, and Escape as well.
 */

afterEach(cleanup);

const expanded = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-expanded");

describe("the reactions", () => {
	function opened() {
		render(
			<div>
				<HandButton up={false} onRaise={() => {}} onReact={() => {}} />
				<p>the pictures</p>
			</div>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Reactions" }));
		expect(expanded("Reactions")).toBe("true");
	}

	it("close on a press anywhere else", () => {
		opened();
		act(() => {
			fireEvent.pointerDown(screen.getByText("the pictures"));
		});
		expect(expanded("Reactions")).toBe("false");
	});

	it("close on Escape", () => {
		opened();
		act(() => {
			fireEvent.keyDown(document, { key: "Escape" });
		});
		expect(expanded("Reactions")).toBe("false");
	});

	it("stay open for a press inside them", () => {
		opened();
		act(() => {
			fireEvent.pointerDown(screen.getByRole("group", { name: "Reactions" }));
		});
		expect(expanded("Reactions")).toBe("true");
	});
});

describe("the leave question", () => {
	it("is put away by a press on the pictures", () => {
		render(
			<div>
				<Leaving room={{} as Room} host={false} onLeave={() => {}} />
				<p>the pictures</p>
			</div>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Leave" }));
		expect(expanded("Leave")).toBe("true");

		act(() => {
			fireEvent.pointerDown(screen.getByText("the pictures"));
		});
		expect(expanded("Leave")).toBe("false");
	});

	it("is named, and takes the focus when it is asked", () => {
		render(<Leaving room={{} as Room} host={false} onLeave={() => {}} />);

		fireEvent.click(screen.getByRole("button", { name: "Leave" }));

		const dialog = screen.getByRole("dialog", { name: "Leave" });
		expect(dialog.contains(document.activeElement)).toBe(true);
	});
});
