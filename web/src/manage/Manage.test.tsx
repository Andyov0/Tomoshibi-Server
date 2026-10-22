import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Manage } from "./Manage";
import { LEAVING_MS } from "./swap";

/*
 * Moving between the management pages' panels.
 *
 * The panels used to be replaced between two frames: the new one rose in and
 * the old one was gone, which the owner's rule does not allow — nothing appears
 * or disappears without moving. The two ways the fix can be quietly wrong are
 * the two halves of it. The old panel can vanish anyway, which looks like the
 * fix was never made; or the two can be drawn together for the length of the
 * leaving, the new one below the old, which reads as the page jumping and is
 * worse than what it replaced. Neither throws, and both look fine in a still.
 *
 * So what is counted here is how many panels share the column at any moment,
 * by watching the document change rather than looking at it now and then.
 */

const { whoami, now, runtime } = vi.hoisted(() => ({
	whoami: vi.fn(),
	now: vi.fn(),
	runtime: vi.fn(),
}));

vi.mock("./api", () => ({
	SignedOut: class SignedOut extends Error {},
	api: { whoami, now, runtime, signOut: vi.fn() },
}));

// Each panel as its name and nothing else: what is under test is the column
// they share, not what any one of them shows.
vi.mock("./NowPanel", () => ({ NowPanel: () => "now panel" }));
vi.mock("./RoomsPanel", () => ({ RoomsPanel: () => "rooms panel" }));
vi.mock("./AccountsPanel", () => ({ AccountsPanel: () => "accounts panel" }));
vi.mock("./RelaysPanel", () => ({ RelaysPanel: () => "relays panel" }));
vi.mock("./AppsPanel", () => ({ AppsPanel: () => "apps panel" }));
vi.mock("./AdminsPanel", () => ({ AdminsPanel: () => "admins panel" }));
vi.mock("./RuntimePanel", () => ({ RuntimePanel: () => "runtime panel" }));

/** Every panel the column ever held, and the most it held at once. */
function watching() {
	const seen = new Set<string>();
	let most = 0;

	const count = () => {
		const panels = document.querySelectorAll("[data-panel]");
		most = Math.max(most, panels.length);
		for (const one of panels) seen.add(one.getAttribute("data-panel") ?? "");
	};

	const observer = new MutationObserver(count);
	observer.observe(document.body, { childList: true, subtree: true, attributes: true });
	count();

	return {
		seen,
		most: () => most,
		stop: () => observer.disconnect(),
	};
}

/** The rail's button for a panel; the row along the bottom has another. */
function rail(name: string): HTMLElement {
	const [first] = screen.getAllByRole("button", { name });
	if (!first) throw new Error(`no ${name} button`);
	return first;
}

beforeEach(() => {
	vi.clearAllMocks();
	window.location.hash = "";
	whoami.mockResolvedValue({ trip: "abcdefghij", name: "kit", can: ["moderate"] });
	now.mockReturnValue(new Promise(() => {}));
	runtime.mockResolvedValue({ meet: {}, rtc: {}, credentials: { key: "" }, codecs: [] });
});

afterEach(() => {
	window.location.hash = "";
});

describe("moving between panels", () => {
	it("lets the old panel leave before the new one arrives, and never draws the two together", async () => {
		render(<Manage />);

		const before = await screen.findByText("now panel");
		const watch = watching();

		fireEvent.click(rail("Relays"));

		// The rail answers at once; the column waits for the old panel to go.
		expect(rail("Relays").getAttribute("aria-current")).toBe("page");
		expect(screen.getByText("now panel").className).toContain("animate-page-leave");
		expect(screen.queryByText("relays panel")).toBeNull();

		const after = await screen.findByText("relays panel");

		expect(after.className).toContain("animate-page");
		expect(after.className).not.toContain("animate-page-leave");
		expect(before.isConnected, "the old panel is still on the page").toBe(false);
		expect(watch.most(), "two panels shared the column while one left").toBe(1);

		watch.stop();
	});

	it("takes a second press while leaving as the panel chosen, and never draws the one passed over", async () => {
		render(<Manage />);

		await screen.findByText("now panel");
		const watch = watching();

		fireEvent.click(rail("Relays"));
		fireEvent.click(rail("Apps"));

		await screen.findByText("apps panel");
		await new Promise((resolve) => setTimeout(resolve, LEAVING_MS * 2));

		expect([...watch.seen].sort()).toEqual(["Apps", "Now"]);
		expect(watch.most()).toBe(1);
		expect(screen.queryByText("relays panel")).toBeNull();

		watch.stop();
	});

	it("keeps the panel that was leaving, as it was, when it is chosen again", async () => {
		render(<Manage />);

		const before = await screen.findByText("now panel");

		fireEvent.click(rail("Relays"));
		expect(before.className).toContain("animate-page-leave");

		fireEvent.click(rail("Now"));

		await waitFor(() => expect(before.className).not.toContain("animate-page-leave"));
		await new Promise((resolve) => setTimeout(resolve, LEAVING_MS * 2));

		expect(before.isConnected, "the panel was drawn again from nothing").toBe(true);
		expect(screen.queryByText("relays panel")).toBeNull();
	});
});
