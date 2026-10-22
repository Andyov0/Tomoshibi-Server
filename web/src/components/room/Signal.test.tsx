import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Reading } from "@/live/connection";
import { Signal } from "./Signal";

/*
 * That the reason a share is held back is drawn, and taken down.
 *
 * The hook's tests cover the merge — a reason that clears when the browser
 * says so. This is the other half: that the row on the screen follows the
 * reading, and follows it down as well as up. A test rig cannot make a real
 * browser report a bandwidth limitation on demand — the fake desktop it shares
 * is a still picture and the encoder is never short of anything — so this is
 * where the row's own behaviour is pinned.
 */

const reading = (limited?: "cpu" | "bandwidth" | "other"): Reading => ({
	grade: "good",
	measured: true,
	rttMs: 20,
	lossPercent: 0,
	jitterMs: 1,
	share: { sending: true, width: 1280, height: 720, fps: 30, limited },
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

function open(first: Reading) {
	const view = render(<Signal reading={first} />);
	fireEvent.click(screen.getByRole("button", { name: "Good connection" }));
	return view;
}

it("says the connection is holding a share back, and stops saying so", async () => {
	const view = open(reading("bandwidth"));

	expect(await screen.findByText("Held back by")).toBeTruthy();
	expect(screen.getByText("the connection")).toBeTruthy();

	// The browser reports the limitation gone; the row goes with it.
	view.rerender(<Signal reading={reading(undefined)} />);

	expect(screen.queryByText("Held back by")).toBeNull();
	expect(screen.queryByText("the connection")).toBeNull();
	// The share row itself stays: the share is still going.
	expect(screen.getByText("Sharing")).toBeTruthy();
});

it("names this machine when the encoder is the limit", async () => {
	open(reading("cpu"));

	expect(await screen.findByText("Held back by")).toBeTruthy();
	expect(screen.getByText("this machine")).toBeTruthy();
});

it("draws no reason row for a share that is not held back", async () => {
	open(reading(undefined));

	expect(await screen.findByText("Sharing")).toBeTruthy();
	expect(screen.queryByText("Held back by")).toBeNull();
});
