import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/live/i18n";
import { Account } from "./Account";

const { actionFailed } = vi.hoisted(() => ({ actionFailed: vi.fn() }));

vi.mock("@/live/notices", () => ({ actionFailed, actionDone: vi.fn() }));

/*
 * What somebody's own page tells them, and what it writes when they change it.
 *
 * Three things here would go wrong without anybody seeing it.
 *
 * The Emby grant is the one permission that spends the deployment's money, and
 * it is given to people one at a time. A page that listed it among the things
 * somebody had not been given would be an advertisement for asking, shown to
 * everybody who has an account — and nothing would look broken.
 *
 * The guest links are offered by what the account may do, not only by whether
 * it has scopes. An account whose links were taken away and still saw the form
 * would fill it in and be refused by the server every time, which reads as the
 * page being broken rather than as a decision somebody made.
 *
 * And the settings are written to the keys a call reads. A switch that wrote a
 * key nobody reads looks exactly like one that works until the next call, so
 * the keys are spelled out here rather than imported.
 */

const base = {
	name: "Alex",
	trip: "AbCdEfGhIj",
	created: "2026-03-04T10:00:00Z",
	scopes: ["acme"],
};

function serve(me: Record<string, unknown>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url === "/api/account/me") return new Response(JSON.stringify(me));
			return new Response("{}", { status: 404 });
		}),
	);
}

async function open(me: Record<string, unknown>) {
	serve(me);
	render(<Account />);
	await screen.findByText("What you can use");
}

beforeEach(() => localStorage.clear());

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
	act(() => setLocale("en"));
});

describe("what you can use", () => {
	it("lists what the account holds, and what it does not apart, but never Emby", async () => {
		await open({ ...base, can: ["watch", "arrange", "invite", "open"] });

		const held = screen.getByRole("list", { name: "What you can use" });
		expect(held.textContent).toContain("Watch together");
		expect(held.textContent).toContain("Arrange meetings");

		const withheld = screen.getByRole("list", { name: "Not opened to this account" });
		expect(withheld.textContent).toContain("Music");

		// Not given, and not mentioned anywhere on the page.
		expect(document.body.textContent).not.toContain("Emby");
	});

	it("names Emby to somebody who was given it", async () => {
		await open({ ...base, can: ["watch", "emby", "music", "arrange", "invite", "open"] });

		const held = screen.getByRole("list", { name: "What you can use" });
		expect(held.textContent).toContain("Emby library");
		expect(screen.queryByRole("list", { name: "Not opened to this account" })).toBeNull();
	});

	it("shows the account's scopes and when it was made", async () => {
		await open({ ...base, can: [] });

		expect(screen.getByText("@acme")).toBeTruthy();
		expect(screen.getByText("Account created")).toBeTruthy();
		expect(document.body.textContent).toContain("2026");
	});

	it("follows the language picker without a reload", async () => {
		await open({ ...base, can: ["watch"] });

		act(() => setLocale("ja"));

		expect(screen.getByText("使える機能")).toBeTruthy();
		expect(screen.queryByText("What you can use")).toBeNull();
	});
});

describe("guest links", () => {
	it("are offered to a member of a scope who may make them", async () => {
		await open({ ...base, can: ["invite"] });
		expect(screen.getByRole("heading", { name: "Guest links" })).toBeTruthy();
	});

	it("are not offered once that was taken away, scopes or not", async () => {
		await open({ ...base, can: ["watch", "music"] });
		expect(screen.queryByRole("heading", { name: "Guest links" })).toBeNull();
	});

	// Taken away while the page was open, which offered the form by what it was
	// told when it loaded: said as what happened, not as a press to try again.
	it("say so when they were taken away while the page was open", async () => {
		await open({ ...base, can: ["invite"] });

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: "not_allowed" }), { status: 403 })),
		);

		fireEvent.change(screen.getByRole("textbox", { name: "Room name" }), { target: { value: "standup" } });
		fireEvent.submit(screen.getByRole("textbox", { name: "Room name" }).closest("form") as HTMLFormElement);

		await waitFor(() => expect(actionFailed).toHaveBeenCalledWith("Guest links have not been opened to you."));
	});
});

describe("settings", () => {
	async function settings(me: Record<string, unknown> = { ...base, can: ["watch", "music"] }) {
		await open(me);
		fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
	}

	it("are folded away until asked for", async () => {
		await open({ ...base, can: ["watch"] });

		const toggle = screen.getByRole("button", { name: /^Settings/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("checkbox", { name: "Start with the camera on" })).toBeNull();

		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("checkbox", { name: "Start with the camera on" })).toBeTruthy();
	});

	it("start from what a call would start from, and write where a call reads", async () => {
		localStorage.setItem("meet-live.devices", JSON.stringify({ camera: true, microphone: false }));
		await settings();

		const camera = screen.getByRole("checkbox", { name: "Start with the camera on" }) as HTMLInputElement;
		const microphone = screen.getByRole("checkbox", { name: "Start with the microphone on" }) as HTMLInputElement;
		expect(camera.checked).toBe(true);
		expect(microphone.checked).toBe(false);

		fireEvent.click(microphone);
		expect(JSON.parse(localStorage.getItem("meet-live.devices") ?? "{}")).toEqual({ camera: true, microphone: true });

		fireEvent.click(screen.getByRole("checkbox", { name: "Blur my background" }));
		expect(localStorage.getItem("meet-live.blur")).toBe("on");

		fireEvent.click(screen.getByRole("button", { name: "At the side" }));
		expect(localStorage.getItem("meet-live.controls")).toBe("side");

		fireEvent.click(screen.getByRole("checkbox", { name: "Lower the music while anybody talks" }));
		expect(localStorage.getItem("meet-live.music-duck")).toBe("off");

		fireEvent.click(screen.getByRole("button", { name: "Highest" }));
		expect(localStorage.getItem("meet-live.music-quality")).toBe("best");

		fireEvent.click(screen.getByRole("button", { name: "720p" }));
		expect(localStorage.getItem("meet-live.watch-quality")).toBe("720p");

		fireEvent.click(screen.getByRole("button", { name: "Automatic" }));
		expect(localStorage.getItem("meet-live.watch-quality")).toBeNull();
	});

	it("offer the library's quality only to somebody who may fetch from it", async () => {
		await settings({ ...base, can: ["watch"] });

		// Ducking is the listener's, and everybody listens.
		expect(screen.getByRole("checkbox", { name: "Lower the music while anybody talks" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Highest" })).toBeNull();
	});

	it("offer to forget the devices picked in a call, and only while there are some", async () => {
		await settings();
		expect(screen.queryByRole("button", { name: "Forget" })).toBeNull();
	});

	it("forget the devices picked in a call, and the offer leaves", async () => {
		localStorage.setItem("meet-live.device-choice", JSON.stringify({ audioinput: "mic-1" }));
		await settings();

		fireEvent.click(screen.getByRole("button", { name: "Forget" }));
		expect(localStorage.getItem("meet-live.device-choice")).toBeNull();

		await waitFor(() => expect(screen.queryByRole("button", { name: "Forget" })).toBeNull());
	});
});
