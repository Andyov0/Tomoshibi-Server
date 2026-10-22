import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ScopedRoomInput } from "./ScopedRoomInput";

/*
 * Completing the scope of a room name.
 *
 * What matters is the mistake it exists to prevent -- a scope typed wrong is a
 * room nobody can enter -- and the two ways the field itself could get in the
 * way: rewriting what somebody typed on purpose, and swallowing the Enter that
 * should have started the meeting.
 */

function Field({ scopes, admin = false, onSubmit = vi.fn() }: { scopes: string[]; admin?: boolean; onSubmit?: () => void }) {
	const [value, setValue] = useState("");
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<ScopedRoomInput aria-label="Room name" value={value} onValueChange={setValue} scopes={scopes} admin={admin} />
		</form>
	);
}

const field = () => screen.getByRole("combobox", { name: "Room name" }) as HTMLInputElement;

/** Type one character at a time, as a keyboard would. */
function type(text: string) {
	for (const character of text) {
		fireEvent.change(field(), { target: { value: field().value + character } });
	}
}

const options = () => screen.queryAllByRole("option").map((option) => option.textContent);

describe("one scope", () => {
	it("is written in when @ is typed", () => {
		render(<Field scopes={["acme"]} />);
		fireEvent.focus(field());

		type("standup@");

		expect(field().value).toBe("standup@acme");
	});

	it("is not written in again over a scope somebody typed themselves", () => {
		render(<Field scopes={["acme"]} />);
		fireEvent.focus(field());

		type("standup@");
		fireEvent.change(field(), { target: { value: "standup@" } });
		type("other");

		expect(field().value).toBe("standup@other");
	});
});

describe("several scopes", () => {
	it("are offered after @, narrowed as the scope is typed", () => {
		render(<Field scopes={["acme", "apex", "zeta"]} />);
		fireEvent.focus(field());

		type("standup");
		expect(field().getAttribute("aria-expanded")).toBe("false");

		type("@");
		expect(field().getAttribute("aria-expanded")).toBe("true");
		expect(options()).toEqual(["@acme", "@apex", "@zeta"]);

		type("a");
		expect(options()).toEqual(["@acme", "@apex"]);
	});

	it("takes the highlighted one on Enter, without submitting the form", () => {
		const onSubmit = vi.fn();
		render(<Field scopes={["acme", "apex"]} onSubmit={onSubmit} />);
		fireEvent.focus(field());
		type("standup@a");

		fireEvent.keyDown(field(), { key: "ArrowDown" });
		// jsdom does not submit a form on Enter, so whether the key was kept
		// from doing so is read off the event itself: false means cancelled.
		const went = fireEvent.keyDown(field(), { key: "Enter" });

		expect(went).toBe(false);
		expect(field().value).toBe("standup@apex");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(field().getAttribute("aria-expanded")).toBe("false");
	});

	it("takes one that is pressed", () => {
		render(<Field scopes={["acme", "apex"]} />);
		fireEvent.focus(field());
		type("standup@");

		const apex = screen.getAllByRole("option").find((option) => option.textContent === "@apex");
		fireEvent.pointerDown(apex as HTMLElement);

		expect(field().value).toBe("standup@apex");
	});

	it("goes away on Escape and leaves the name alone", () => {
		render(<Field scopes={["acme", "apex"]} />);
		fireEvent.focus(field());
		type("standup@");

		fireEvent.keyDown(field(), { key: "Escape" });

		expect(field().getAttribute("aria-expanded")).toBe("false");
		expect(field().value).toBe("standup@");
	});
});

describe("a scope somebody is not in", () => {
	it("is said under the field", () => {
		render(<Field scopes={["acme"]} />);
		fireEvent.focus(field());
		fireEvent.change(field(), { target: { value: "standup@acne" } });

		expect(screen.getByRole("status").textContent).toContain("acne");
	});

	it("is not said to an administrator, who is in every scope", () => {
		render(<Field scopes={[]} admin />);
		fireEvent.focus(field());
		fireEvent.change(field(), { target: { value: "standup@acne" } });

		expect(screen.getByRole("status").textContent).toBe("");
	});

	it("is not said of a plain name", () => {
		render(<Field scopes={["acme"]} />);
		fireEvent.focus(field());
		type("standup");

		expect(screen.getByRole("status").textContent).toBe("");
	});
});
