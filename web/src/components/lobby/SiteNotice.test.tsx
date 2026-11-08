import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deployment } from "@/live/api";
import { setLocale } from "@/live/i18n";
import { closedHere, forgetNotice, learnNotice } from "@/live/notice";
import { SiteNotice } from "./SiteNotice";

/*
 * Two notices, each on its own screen. The lobby's reached the apps alone, and
 * the owner, who had published one, looked for it in Chrome and found nothing;
 * once the page showed it, it showed it on the sign-in as well, and the owner
 * asked for the sign-in page's to be its own, "this one is for people signed
 * in". What is guarded here is that each screen shows its own notice and never
 * the other's, in the reader's language as the apps choose it, that closing one
 * is remembered for that notice only, and that /api/deployment's answer is
 * where both are learned, the lobby's asked for again as the lobby appears.
 */

const LOBBY = {
	id: "2026-11-02-074326",
	level: "info",
	text: { en: "AliCloud will be discontinued soon.", "zh-Hans": "阿里云将于近期下架" },
};
const SIGNIN = {
	id: "2026-11-02-080000",
	level: "info",
	text: { en: "Accounts are made by the administrators.", "zh-Hans": "账号由管理员开通" },
};

afterEach(() => {
	cleanup();
	act(() => {
		forgetNotice();
		setLocale("en");
	});
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("SiteNotice", () => {
	it("shows nothing where the server said no notice", () => {
		render(<SiteNotice kind="signin" />);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows each screen its own notice and never the other's", () => {
		act(() => learnNotice({ notice: LOBBY, signInNotice: SIGNIN }));

		render(<SiteNotice kind="signin" />);
		expect(screen.getByRole("status").textContent).toContain("Accounts are made by the administrators.");
		expect(screen.getByRole("status").textContent).not.toContain("AliCloud");

		cleanup();
		render(<SiteNotice kind="lobby" />);
		expect(screen.getByRole("status").textContent).toContain("AliCloud will be discontinued soon.");
	});

	it("shows the sign-in page nothing when only the lobby has a notice", () => {
		act(() => learnNotice({ notice: LOBBY }));
		render(<SiteNotice kind="signin" />);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("says the notice in the page's language, and in English where it has none of that", () => {
		act(() => learnNotice({ signInNotice: SIGNIN }));
		render(<SiteNotice kind="signin" />);
		expect(screen.getByRole("status").textContent).toContain("Accounts are made by the administrators.");

		act(() => setLocale("zh-Hans"));
		expect(screen.getByRole("status").textContent).toContain("账号由管理员开通");

		act(() => setLocale("ja"));
		expect(screen.getByRole("status").textContent).toContain("Accounts are made by the administrators.");
	});

	it("shows none in a language it was not written in where it has no English either", () => {
		act(() => learnNotice({ signInNotice: { ...SIGNIN, text: { "zh-Hans": "只有中文" } } }));
		render(<SiteNotice kind="signin" />);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("is put away when closed, for that notice on that screen only, and a new notice is shown", async () => {
		act(() => learnNotice({ notice: LOBBY, signInNotice: { ...SIGNIN, id: LOBBY.id } }));
		render(<SiteNotice kind="signin" />);

		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
		expect(closedHere("signin", LOBBY.id)).toBe(true);
		// The same id on the other screen is another notice.
		expect(closedHere("lobby", LOBBY.id)).toBe(false);

		cleanup();
		render(<SiteNotice kind="signin" />);
		expect(screen.queryByRole("status")).toBeNull();

		act(() => learnNotice({ notice: LOBBY, signInNotice: { ...SIGNIN, id: "2026-11-03-010000" } }));
		expect(screen.getByRole("status")).toBeTruthy();
	});

	it("leaves when it is taken down", async () => {
		act(() => learnNotice({ signInNotice: SIGNIN }));
		render(<SiteNotice kind="signin" />);
		expect(screen.getByRole("status")).toBeTruthy();

		act(() => learnNotice({}));
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("shows none past its end", () => {
		act(() => learnNotice({ signInNotice: { ...SIGNIN, until: new Date(Date.now() - 60_000).toISOString() } }));
		render(<SiteNotice kind="signin" />);
		expect(screen.queryByRole("status")).toBeNull();
	});

	// In the colour the product says a problem in, as the apps draw a warning.
	it("draws a warning apart from a notice", () => {
		act(() => learnNotice({ signInNotice: { ...SIGNIN, level: "warning" } }));
		render(<SiteNotice kind="signin" />);
		expect(screen.getByRole("status").className).toContain("border-danger");

		cleanup();
		act(() => learnNotice({ signInNotice: SIGNIN }));
		render(<SiteNotice kind="signin" />);
		expect(screen.getByRole("status").className).not.toContain("border-danger");
	});

	// A notice already up as the screen is drawn is simply there; one that
	// arrives later opens its own room, so the page below moves down rather
	// than jumping by the notice's height in one frame.
	it("opens a room for a notice that arrives, and not for one already there", () => {
		const opens = () => screen.getByRole("status").parentElement?.parentElement?.className ?? "";

		act(() => learnNotice({ signInNotice: SIGNIN }));
		render(<SiteNotice kind="signin" />);
		expect(opens(), "the page moved under a notice that was there all along").not.toContain("starting:");

		cleanup();
		act(() => forgetNotice());
		render(<SiteNotice kind="signin" />);
		act(() => learnNotice({ signInNotice: SIGNIN }));
		expect(opens(), "a notice arriving pushed the page down in one frame").toContain("starting:grid-rows-[0fr]");
	});

	it("learns both from what /api/deployment says", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ openedBy: "anyone", joinedBy: "anyone", source: "", signInNotice: SIGNIN })),
		);
		render(<SiteNotice kind="signin" />);
		expect(screen.queryByRole("status")).toBeNull();

		await act(async () => {
			await deployment();
		});
		expect(screen.getByRole("status").textContent).toContain("Accounts are made by the administrators.");
	});

	// The lobby's is told only to a caller signed in, and the answer read as the
	// page loaded was read before the sign-in that led to the lobby.
	it("asks again for the lobby's as the lobby appears", async () => {
		const fetched = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ openedBy: "anyone", joinedBy: "anyone", source: "", notice: LOBBY })));

		render(<SiteNotice kind="lobby" />);
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("AliCloud will be discontinued soon."));
		expect(fetched).toHaveBeenCalledWith("/api/deployment");
	});
});
