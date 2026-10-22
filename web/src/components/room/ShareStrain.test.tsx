import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShareStrain } from "./ShareStrain";

/*
 * What these guard is the card saying something other than what was measured,
 * or doing something other than what was pressed.
 *
 * The numbers are the whole argument the card makes — the line carries this,
 * the share asks that — and a card that rounded them into agreement, or showed
 * a setting other than the one its button applies, would be talking somebody
 * into a change on false figures. And it leaves the way it arrived: a card
 * that blinks out of existence on a press reads as a fault, which in a call is
 * read as the call breaking.
 */

const HINT = { have: 37_200_000, need: 51_660_000, to: { quality: "1440p" as const, frameRate: 30 as const } };

describe("ShareStrain", () => {
	it("says what the line carries, what the share asks, and what would fit", () => {
		render(<ShareStrain hint={HINT} onSwitch={vi.fn()} onDismiss={vi.fn()} />);

		expect(
			screen.getByText(
				"Your connection is sending about 37 Mbps, and this share needs about 52 Mbps, so it stutters.",
			),
		).toBeDefined();
		expect(screen.getByText("Switch to 1440p at 30 frames a second?")).toBeDefined();
	});

	it("keeps a decimal where a whole number would round a small line away", () => {
		render(<ShareStrain hint={{ ...HINT, have: 8_400_000, need: 12_700_000 }} onSwitch={vi.fn()} onDismiss={vi.fn()} />);

		expect(screen.getByText(/about 8\.4 Mbps, and this share needs about 13 Mbps/)).toBeDefined();
	});

	it("does each thing only when it is pressed", () => {
		const onSwitch = vi.fn();
		const onDismiss = vi.fn();
		render(<ShareStrain hint={HINT} onSwitch={onSwitch} onDismiss={onDismiss} />);

		expect(onSwitch).not.toHaveBeenCalled();
		expect(onDismiss).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(onSwitch).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "Not now" }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("arrives, and leaves without taking a second press on its way out", () => {
		const onSwitch = vi.fn();
		const { rerender } = render(<ShareStrain hint={HINT} onSwitch={onSwitch} onDismiss={vi.fn()} />);

		expect(screen.getByRole("status").className).toContain("animate-arrive");

		rerender(<ShareStrain hint={HINT} leaving onSwitch={onSwitch} onDismiss={vi.fn()} />);

		expect(screen.getByRole("status").className).toContain("animate-depart");
		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(onSwitch).not.toHaveBeenCalled();
	});
});
