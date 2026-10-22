import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { rememberFrameRate, rememberQuality } from "@/live/room";
import { ShareButton } from "./ShareButton";

/*
 * What these guard is a control that offers something it cannot deliver.
 *
 * The frame rates a share can carry depend on its size: 1080p reaches 240, 1440p
 * stops at 120, 4K at 60. Offering the wrong ones does not fail loudly — the
 * encoder falls behind and the picture drifts, and nothing anywhere says why. So
 * the menu must offer exactly the rates the chosen size allows, and a rate
 * chosen at one size must not survive being carried to a smaller one.
 *
 * And the automatic setting has no frame rate at all, because it chooses one. A
 * control that appeared and did nothing would be a control somebody set and
 * believed.
 */

/**
 * Open the menu the way a keyboard does.
 *
 * A pointer would be the truer gesture, but jsdom defines no PointerEvent, so
 * React registers no listener for one and a synthesised pointerdown reaches
 * nothing — the menu simply stays shut, and the failure reads as a missing menu.
 * Enter opens it through the same handler and the same state.
 */
function open() {
	fireEvent.keyDown(screen.getByRole("button", { name: "Share your screen" }), { key: "Enter" });
}

function draw() {
	const onStart = vi.fn();
	render(
		<ShareButton sharing={false} listening={false} onListen={vi.fn()} onStopListening={vi.fn()} onStart={onStart} onAdjust={vi.fn()} onStop={vi.fn()} />,
	);
	open();

	return onStart;
}

function pick(label: string) {
	fireEvent.click(screen.getByRole("menuitemcheckbox", { name: new RegExp(label) }));
}

function rates(): number[] {
	return screen
		.queryAllByRole("button")
		.map((one) => one.textContent ?? "")
		.filter((text) => /^\d+$/.test(text))
		.map(Number);
}

describe("ShareButton", () => {
	it("asks nothing and starts nothing on the press that opens it", () => {
		const onStart = draw();

		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText("Automatic")).toBeDefined();
		expect(screen.getByText("4K")).toBeDefined();
	});

	it("offers only the frame rates the chosen size can carry", () => {
		draw();

		pick("1080p");
		expect(rates()).toEqual([15, 30, 60, 120, 240]);

		pick("1440p");
		expect(rates()).toEqual([15, 30, 60, 120]);

		pick("4K");
		expect(rates()).toEqual([15, 30, 60]);
	});

	// Automatic chooses the rate as well, so offering one would be offering a
	// control that does nothing.
	it("offers no frame rate at all for automatic", () => {
		draw();

		pick("1080p");
		expect(rates().length).toBeGreaterThan(0);

		pick("Automatic");
		expect(rates()).toEqual([]);
	});

	// The silent one. A rate chosen while 1080p was selected must not be sent
	// with 4K, where no encoder will keep up with it.
	it("does not carry a fast rate onto a size that cannot take it", () => {
		const onStart = draw();

		pick("1080p");
		fireEvent.click(screen.getByRole("button", { name: "240" }));

		pick("4K");
		fireEvent.click(screen.getByRole("menuitem", { name: /Share your screen/ }));

		expect(onStart).toHaveBeenCalledWith(60, "4k");
	});

	it("starts with both choices, and only when asked to", () => {
		const onStart = draw();

		pick("1440p");
		fireEvent.click(screen.getByRole("button", { name: "120" }));

		expect(onStart).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("menuitem", { name: /Share your screen/ }));
		expect(onStart).toHaveBeenCalledWith(120, "1440p");
	});

	/*
	 * The settings have to be reachable while a share is running.
	 *
	 * This used to be a plain stop button the moment sharing began, on the
	 * reasoning that stopping is not a choice and a menu would be a step to
	 * dismiss. That is true of stopping and wrong about everything else: the
	 * only moment anybody can judge whether the picture is too soft or too jerky
	 * is while they are looking at it, and the settings had gone. Fixing it meant
	 * stopping, reopening the picker, and choosing the window again in front of
	 * the meeting.
	 */
	it("adjusts a running share in place instead of publishing it again", () => {
		const onStart = vi.fn();
		const onAdjust = vi.fn();
		render(<ShareButton sharing listening={false} onListen={vi.fn()} onStopListening={vi.fn()} onStart={onStart} onAdjust={onAdjust} onStop={vi.fn()} />);

		fireEvent.keyDown(screen.getByRole("button", { name: "Screen sharing settings" }), {
			key: "Enter",
		});
		pick("1440p");

		expect(onAdjust).toHaveBeenCalledWith(120, "1440p");

		// Never this. Publishing again makes the browser ask for the screen a
		// second time, and somebody who already chose a window would be shown the
		// picker for having adjusted a number, with everybody watching.
		expect(onStart).not.toHaveBeenCalled();
	});

	// The same clamp as when starting, and it has to be applied here too: 240 is
	// offered at 1080p and is not carried onto 4K by a size change mid-share.
	it("does not carry a fast rate onto a smaller size while sharing", () => {
		const onAdjust = vi.fn();
		render(<ShareButton sharing listening={false} onListen={vi.fn()} onStopListening={vi.fn()} onStart={vi.fn()} onAdjust={onAdjust} onStop={vi.fn()} />);

		fireEvent.keyDown(screen.getByRole("button", { name: "Screen sharing settings" }), {
			key: "Enter",
		});
		pick("1080p");
		fireEvent.click(screen.getByRole("button", { name: "240" }));
		pick("4K");

		expect(onAdjust).toHaveBeenLastCalledWith(60, "4k");
	});

	/*
	 * The menu shows what is being sent, not what it last picked.
	 *
	 * Something other than the menu changes a share now — the hint that the line
	 * cannot carry it — and a menu that kept ticking its own last choice would
	 * describe a share nobody is sending, and its next press would start from
	 * that setting rather than from the one on the wire.
	 */
	it("shows the setting the share is running at, and adjusts from it", () => {
		const onAdjust = vi.fn();
		render(
			<ShareButton
				sharing
				running={{ quality: "1080p", frameRate: 30 }}
				listening={false}
				onListen={vi.fn()}
				onStopListening={vi.fn()}
				onStart={vi.fn()}
				onAdjust={onAdjust}
				onStop={vi.fn()}
			/>,
		);

		fireEvent.keyDown(screen.getByRole("button", { name: "Screen sharing settings" }), { key: "Enter" });

		expect(screen.getByRole("menuitemcheckbox", { name: /1080p/ }).getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("menuitemcheckbox", { name: /Automatic/ }).getAttribute("aria-checked")).toBe("false");

		fireEvent.click(screen.getByRole("button", { name: "60" }));
		expect(onAdjust).toHaveBeenLastCalledWith(60, "1080p");
	});

	// And the next share starts from what was chosen here: what one line
	// carried one afternoon is not a choice anybody made.
	it("goes back to what was chosen here once the share has ended", () => {
		rememberQuality("4k");
		rememberFrameRate(15);

		const onStart = vi.fn();
		render(
			<ShareButton
				sharing={false}
				running={{ quality: "1080p", frameRate: 30 }}
				listening={false}
				onListen={vi.fn()}
				onStopListening={vi.fn()}
				onStart={onStart}
				onAdjust={vi.fn()}
				onStop={vi.fn()}
			/>,
		);
		open();

		expect(screen.getByRole("menuitemcheckbox", { name: /4K/ }).getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("menuitemcheckbox", { name: /1080p/ }).getAttribute("aria-checked")).toBe("false");

		fireEvent.click(screen.getByRole("menuitem", { name: /Share your screen/ }));
		expect(onStart).toHaveBeenCalledWith(15, "4k");
	});

	it("still stops, from the menu", () => {
		const onStop = vi.fn();
		render(<ShareButton sharing listening={false} onListen={vi.fn()} onStopListening={vi.fn()} onStart={vi.fn()} onAdjust={vi.fn()} onStop={onStop} />);

		fireEvent.keyDown(screen.getByRole("button", { name: "Screen sharing settings" }), {
			key: "Enter",
		});
		fireEvent.click(screen.getByRole("menuitem", { name: /Stop sharing/ }));

		expect(onStop).toHaveBeenCalled();
	});
});

/*
 * Sound on its own, to listen to something together.
 *
 * Offered from the same menu as the screen, and not while the screen is being
 * shared -- a share already sends its sound, and offering a second copy of it
 * would put the same song in the room twice, a beat apart.
 */
describe("sharing sound on its own", () => {
	it("is offered beside the screen, and starts when chosen", () => {
		const onListen = vi.fn();
		render(
			<ShareButton
				sharing={false}
				listening={false}
				onStart={vi.fn()}
				onAdjust={vi.fn()}
				onStop={vi.fn()}
				onListen={onListen}
				onStopListening={vi.fn()}
			/>,
		);
		open();
		fireEvent.click(screen.getByRole("menuitem", { name: /Share only sound/ }));

		expect(onListen).toHaveBeenCalledTimes(1);
	});

	it("is not offered while the screen is shared", () => {
		render(
			<ShareButton
				sharing
				listening={false}
				onStart={vi.fn()}
				onAdjust={vi.fn()}
				onStop={vi.fn()}
				onListen={vi.fn()}
				onStopListening={vi.fn()}
			/>,
		);
		fireEvent.keyDown(screen.getByRole("button", { name: "Screen sharing settings" }), { key: "Enter" });

		expect(screen.queryByRole("menuitem", { name: /Share only sound/ })).toBeNull();
	});

	it("says it is sharing sound, and stops from the menu", () => {
		const onStopListening = vi.fn();
		render(
			<ShareButton
				sharing={false}
				listening
				onStart={vi.fn()}
				onAdjust={vi.fn()}
				onStop={vi.fn()}
				onListen={vi.fn()}
				onStopListening={onStopListening}
			/>,
		);
		fireEvent.keyDown(screen.getByRole("button", { name: "Sharing sound" }), { key: "Enter" });
		fireEvent.click(screen.getByRole("menuitem", { name: /Stop sharing sound/ }));

		expect(onStopListening).toHaveBeenCalledTimes(1);
	});
});

describe("lossless", () => {
	const menu = (props: Partial<Parameters<typeof ShareButton>[0]> = {}) => {
		render(
			<ShareButton
				sharing={false}
				listening={false}
				onStart={vi.fn()}
				onAdjust={vi.fn()}
				onStop={vi.fn()}
				onListen={vi.fn()}
				onStopListening={vi.fn()}
				{...props}
			/>,
		);
		const button = screen.getByRole("button", { name: props.listening ? "Sharing sound" : "Share your screen" });
		fireEvent.keyDown(button, { key: "Enter" });
	};

	it("is offered beneath sharing sound, ticked, and switches without closing the menu", () => {
		const onLossless = vi.fn();
		menu({ lossless: true, onLossless });

		const item = screen.getByRole("menuitemcheckbox", { name: /Lossless/ });
		expect(item.getAttribute("aria-checked")).toBe("true");
		expect(item.textContent).toContain("about a second behind");

		fireEvent.click(item);
		expect(onLossless).toHaveBeenCalledWith(false);
		expect(screen.getByRole("menuitemcheckbox", { name: /Lossless/ })).toBeTruthy();
	});

	it("is shown off, with the reason, in an encrypted call", () => {
		const onLossless = vi.fn();
		menu({ lossless: true, losslessUnavailable: "encrypted", onLossless });

		const item = screen.getByRole("menuitemcheckbox", { name: /Lossless/ });
		expect(item.getAttribute("aria-checked")).toBe("false");
		expect(item.getAttribute("aria-disabled")).toBe("true");
		expect(item.textContent).toContain("Not available in an encrypted call");

		fireEvent.click(item);
		expect(onLossless).not.toHaveBeenCalled();
	});

	it("says which of the two is going out while sound is shared", () => {
		menu({ listening: true, sendingLossless: true });
		expect(screen.getByRole("menuitem", { name: /Stop sharing sound/ }).textContent).toContain("Lossless");
		expect(screen.queryByRole("menuitemcheckbox", { name: /Lossless/ })).toBeNull();
	});
});
