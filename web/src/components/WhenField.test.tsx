import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { WhenField, readLocal, writeLocal } from "./WhenField";

/*
 * The guest links' start and end, drawn with the lobby's calendar and clock
 * where they were the platform's date-and-time fields. What would go wrong
 * quietly is the value: the form around it sends what the platform's field
 * gave, "YYYY-MM-DDTHH:mm" in this machine's time, and a picker that wrote
 * anything else, or kept a cleared value, or let an end fall before its
 * start's day, would make a link that works at the wrong time with nothing on
 * the page to say so. And the lobby's calendar stops at the sixty days the
 * server allows a meeting; a link's end has no such bound.
 */

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	// A Wednesday morning, 10:07.
	vi.setSystemTime(new Date(2026, 10, 4, 10, 7));
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function Field(props: { earliest?: Date; future?: boolean; initial?: string; seen: (value: string) => void }) {
	const [value, setValue] = useState(props.initial ?? "");
	return (
		<WhenField
			value={value}
			onChange={(next) => {
				setValue(next);
				props.seen(next);
			}}
			label="Works until"
			none="Until it is stopped"
			earliest={props.earliest}
			future={props.future}
		/>
	);
}

function dayLabel(date: Date) {
	return new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(date);
}

function open() {
	fireEvent.click(screen.getByRole("button", { name: "Works until" }));
}

describe("WhenField", () => {
	it("reads and writes the platform field's value", () => {
		const at = new Date(2026, 0, 2, 3, 45);
		expect(writeLocal(at)).toBe("2026-01-02T03:45");
		expect(readLocal("2026-01-02T03:45")?.getTime()).toBe(at.getTime());
		expect(readLocal("")).toBeUndefined();
		expect(readLocal("2026-01-02")).toBeUndefined();
	});

	it("gives a day chosen first the next quarter hour, and then the time chosen", () => {
		const seen = vi.fn();
		render(<Field seen={seen} />);
		expect(screen.getByRole("button", { name: "Works until" }).textContent).toContain("Until it is stopped");

		open();
		fireEvent.click(screen.getByRole("button", { name: dayLabel(new Date(2026, 10, 9)) }));
		expect(seen).toHaveBeenLastCalledWith("2026-11-09T10:15");

		fireEvent.change(screen.getByLabelText("Hour"), { target: { value: "18" } });
		expect(seen).toHaveBeenLastCalledWith("2026-11-09T18:15");
		fireEvent.change(screen.getByLabelText("Minute"), { target: { value: "45" } });
		expect(seen).toHaveBeenLastCalledWith("2026-11-09T18:45");
	});

	it("clears to nothing", () => {
		const seen = vi.fn();
		render(<Field seen={seen} initial="2026-11-09T18:45" />);
		open();
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		expect(seen).toHaveBeenLastCalledWith("");
	});

	it("offers no day before the first it is given", () => {
		render(<Field seen={vi.fn()} earliest={new Date(2026, 10, 12, 9, 0)} />);
		open();
		expect((screen.getByRole("button", { name: dayLabel(new Date(2026, 10, 11)) }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: dayLabel(new Date(2026, 10, 12)) }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("goes on past the sixty days a meeting is limited to", () => {
		render(<Field seen={vi.fn()} />);
		open();
		for (let n = 0; n < 6; n++) fireEvent.click(screen.getByRole("button", { name: "Next month" }));
		const far = new Date(2027, 4, 20);
		expect((screen.getByRole("button", { name: dayLabel(far) }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("says so of an end that has already gone", () => {
		render(<Field seen={vi.fn()} future initial="2026-11-04T09:00" />);
		open();
		expect(screen.getByText("That time has already gone.")).toBeTruthy();

		cleanup();
		render(<Field seen={vi.fn()} future initial="2026-11-04T11:00" />);
		open();
		expect(screen.queryByText("That time has already gone.")).toBeNull();
		act(() => {});
	});
});
