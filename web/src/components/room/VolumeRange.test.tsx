import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const louderThanSent = vi.fn();
vi.mock("@/live/notices", () => ({ louderThanSent: (echo: boolean) => louderThanSent(echo) }));

const { VolumeRange } = await import("./VolumeRange");

/*
 * Past as loud as it was sent is where hearing can be harmed, and the slider
 * says so as it crosses (the owner, 2026-11-05). What would go wrong quietly: a
 * crossing that says nothing, or a warning raised on every step of a drag
 * already past the line.
 */
afterEach(() => {
	cleanup();
	louderThanSent.mockReset();
});

function slider(value: number, max: number, echo = true) {
	const changed = vi.fn();
	const view = render(<VolumeRange value={value} max={max} echo={echo} label="Volume" onChange={changed} />);
	return { input: view.getByLabelText("Volume") as HTMLInputElement, changed, view };
}

describe("a volume slider past as sent", () => {
	it("goes to three times, with a mark at as sent", () => {
		const { input } = slider(1, 3);
		expect(input.max).toBe("3");
		const marks = document.getElementById(input.getAttribute("list") ?? "");
		expect(marks?.tagName).toBe("DATALIST");
		expect(marks?.querySelector("option")?.getAttribute("value")).toBe("1");
	});

	it("warns as it crosses above as sent, and not again on the far side", () => {
		const below = slider(0.9, 3);
		fireEvent.change(below.input, { target: { value: "1.5" } });
		expect(below.changed).toHaveBeenLastCalledWith(1.5);
		expect(louderThanSent).toHaveBeenCalledTimes(1);
		expect(louderThanSent).toHaveBeenLastCalledWith(true);
		cleanup();

		const beyond = slider(1.5, 3);
		fireEvent.change(beyond.input, { target: { value: "2" } });
		expect(louderThanSent).toHaveBeenCalledTimes(1);
	});

	it("stops at as sent where a sound cannot be made louder, with no mark", () => {
		const { input } = slider(1, 1, false);
		expect(input.max).toBe("1");
		expect(input.getAttribute("list")).toBeNull();
	});
});
