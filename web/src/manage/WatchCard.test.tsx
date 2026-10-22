import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Account, Watching } from "./api";
import { WatchCard } from "./WatchCard";

/*
 * What this guards is the one switch that stops every Emby grant at once, and
 * the one beside it that relays YouTube for everybody who cannot reach it.
 *
 * It is the deployment's last word on whether a film goes through the CDN, so
 * the two ways it can be quietly wrong both matter: drawn from something other
 * than what is stored, it can read as off while films are being relayed; and
 * moved by somebody whose role does not cover the settings, it is a press the
 * server refuses after the radio has already shown it taken. The counts beside
 * it are what says whether "on" is costing anything, and a count drawn from the
 * wrong field — the stored overrides rather than what each account holds —
 * reads as nobody granted on a deployment where everybody is.
 *
 * The YouTube switch adds one more way: the two are separate requests, and a
 * press on one that sent the other — or drew one from the other's value — would
 * move a decision somebody did not make. Its figure is what says whether "on"
 * has cost anything, and it is drawn from the server's count, not assumed.
 *
 * The bangumi switch is the third, and the one that starts on: so the way it
 * would be quietly wrong is the other way round — drawn as off while every
 * episode is being relayed, or turned off by a press meant for another switch.
 */

const { settings, setEmbyRelay, setYouTubeRelay, setBangumiRelay, accounts, admins, actionFailed } = vi.hoisted(() => ({
	settings: vi.fn(),
	setEmbyRelay: vi.fn(),
	setYouTubeRelay: vi.fn(),
	setBangumiRelay: vi.fn(),
	accounts: vi.fn(),
	admins: vi.fn(),
	actionFailed: vi.fn(),
}));

vi.mock("./api", () => ({
	SignedOut: class SignedOut extends Error {},
	api: { settings, setEmbyRelay, setYouTubeRelay, setBangumiRelay, accounts, admins },
}));

vi.mock("@/live/notices", () => ({ actionFailed }));

const off: Watching = {
	configured: true,
	directOnly: true,
	embyRelay: false,
	youtubeRelay: false,
	youtubeSpent: 0,
	bangumiRelay: false,
	bangumiSpent: 0,
};

function account(name: string, emby: boolean): Account {
	return { name, trip: `t${name.padEnd(7, "0")}`, effective: { watch: true, emby } };
}

beforeEach(() => {
	vi.clearAllMocks();
	settings.mockResolvedValue(off);
	setEmbyRelay.mockResolvedValue({ ...off, embyRelay: true });
	setYouTubeRelay.mockResolvedValue({ ...off, youtubeRelay: true });
	setBangumiRelay.mockResolvedValue({ ...off, bangumiRelay: true });
	accounts.mockResolvedValue([account("ada", true), account("bea", false), account("cy", true)]);
	admins.mockResolvedValue([]);
});

describe("the Emby relay switch", () => {
	it("says what is stored, and turns on when asked by somebody with the settings", async () => {
		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		const nothing = await screen.findByRole("radio", { name: /Relay no Emby films/ });
		await waitFor(() => expect(nothing.getAttribute("aria-checked")).toBe("true"));

		fireEvent.click(screen.getByRole("radio", { name: /Relay Emby films picked/ }));

		await waitFor(() => expect(setEmbyRelay).toHaveBeenCalledWith(true));
	});

	it("draws on as on, so it cannot read as off while films are being relayed", async () => {
		settings.mockResolvedValue({ ...off, embyRelay: true });

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		const emby = await screen.findByRole("radio", { name: /Relay Emby films picked/ });
		await waitFor(() => expect(emby.getAttribute("aria-checked")).toBe("true"));
		expect(screen.getByRole("radio", { name: /Relay no Emby films/ }).getAttribute("aria-checked")).toBe(
			"false",
		);
	});

	it("cannot be moved without the settings, and says so", async () => {
		render(<WatchCard canSettings={false} onSignedOut={vi.fn()} />);

		const emby = await screen.findByRole("radio", { name: /Relay Emby films picked/ });
		await waitFor(() => expect(settings).toHaveBeenCalled());

		expect((emby as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText("You can view this but not change it.")).toBeDefined();
	});

	it("counts who holds the grant from what each account holds", async () => {
		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		expect(await screen.findByText("Accounts granted Emby: 2")).toBeDefined();
		expect(screen.getByText("Administrators granted Emby: 0")).toBeDefined();
	});

	it("does not count a grant that can relay nothing", async () => {
		settings.mockResolvedValue({ ...off, embyRelay: true });
		accounts.mockResolvedValue([
			{ ...account("ada", true), blocked: true },
			{ ...account("bea", true), effective: { watch: false, emby: true } },
		]);

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		// A blocked account holds nothing at the server, and one that may not
		// watch together cannot pick a film: neither is spending anything, and
		// the sentence that says nothing is relayed is the true one.
		expect(await screen.findByText("Accounts granted Emby: 0")).toBeDefined();
		expect(await screen.findByText("Nobody is granted Emby yet, so no film is relayed.")).toBeDefined();
	});

	it("says it changes nothing where the file relays everything", async () => {
		settings.mockResolvedValue({ ...off, directOnly: false });

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		expect(
			await screen.findByText(
				"The configuration file relays every video (meet.watch.direct_only is off), so these switches change nothing until that is turned on. Emby films still need the grant.",
			),
		).toBeDefined();
	});
});

describe("the YouTube relay switch", () => {
	it("turns on alone, and leaves the Emby switch where it is", async () => {
		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		const direct = await screen.findByRole("radio", { name: /Play YouTube from where each viewer is/ });
		await waitFor(() => expect(direct.getAttribute("aria-checked")).toBe("true"));

		fireEvent.click(screen.getByRole("radio", { name: /Relay YouTube for viewers/ }));

		await waitFor(() => expect(setYouTubeRelay).toHaveBeenCalledWith(true));
		expect(setEmbyRelay).not.toHaveBeenCalled();
	});

	it("is drawn from its own value, not the Emby switch's", async () => {
		settings.mockResolvedValue({ ...off, embyRelay: true, youtubeRelay: false });

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		const emby = await screen.findByRole("radio", { name: /Relay Emby films picked/ });
		await waitFor(() => expect(emby.getAttribute("aria-checked")).toBe("true"));
		expect(screen.getByRole("radio", { name: /Relay YouTube for viewers/ }).getAttribute("aria-checked")).toBe(
			"false",
		);

		// And pressing the Emby row that is already chosen sends nothing at all.
		fireEvent.click(emby);
		expect(setEmbyRelay).not.toHaveBeenCalled();
		expect(setYouTubeRelay).not.toHaveBeenCalled();
	});

	it("cannot be moved without the settings", async () => {
		render(<WatchCard canSettings={false} onSignedOut={vi.fn()} />);

		const tube = await screen.findByRole("radio", { name: /Relay YouTube for viewers/ });
		await waitFor(() => expect(settings).toHaveBeenCalled());

		expect((tube as HTMLButtonElement).disabled).toBe(true);
	});

	it("says what it has carried since the server started", async () => {
		settings.mockResolvedValue({ ...off, youtubeRelay: true, youtubeSpent: 5_200_000 });

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		expect(await screen.findByText("5.2 MB relayed since restart")).toBeDefined();
	});

	it("shows no figure while it is off and has carried nothing", async () => {
		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		await screen.findByRole("radio", { name: /Relay YouTube for viewers/ });
		await waitFor(() => expect(settings).toHaveBeenCalled());

		expect(screen.queryByText(/relayed since restart/)).toBeNull();
	});

	it("says what is never relayed, whatever any switch says", async () => {
		settings.mockResolvedValue({ ...off, embyRelay: true, youtubeRelay: true, bangumiRelay: true });

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		// Bilibili's videos, not Bilibili: its bangumi have a switch of their own.
		expect(
			await screen.findByText("Bilibili videos and pasted links are never relayed: they play from where each viewer is."),
		).toBeDefined();
	});
});

describe("the bangumi relay switch", () => {
	it("draws on as on, and turns off alone, leaving the other two where they are", async () => {
		settings.mockResolvedValue({ ...off, embyRelay: true, youtubeRelay: true, bangumiRelay: true });
		setBangumiRelay.mockResolvedValue({ ...off, embyRelay: true, youtubeRelay: true, bangumiRelay: false });

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		const everybody = await screen.findByRole("radio", { name: /Relay bangumi for everybody/ });
		await waitFor(() => expect(everybody.getAttribute("aria-checked")).toBe("true"));
		expect(screen.getByRole("radio", { name: /Relay no bangumi/ }).getAttribute("aria-checked")).toBe("false");

		fireEvent.click(screen.getByRole("radio", { name: /Relay no bangumi/ }));

		await waitFor(() => expect(setBangumiRelay).toHaveBeenCalledWith(false));
		expect(setEmbyRelay).not.toHaveBeenCalled();
		expect(setYouTubeRelay).not.toHaveBeenCalled();
	});

	it("is drawn from its own value, and a press on the row already chosen sends nothing", async () => {
		settings.mockResolvedValue({ ...off, youtubeRelay: true, bangumiRelay: false });

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		const none = await screen.findByRole("radio", { name: /Relay no bangumi/ });
		await waitFor(() => expect(none.getAttribute("aria-checked")).toBe("true"));

		fireEvent.click(none);
		expect(setBangumiRelay).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("radio", { name: /Relay bangumi for everybody/ }));
		await waitFor(() => expect(setBangumiRelay).toHaveBeenCalledWith(true));
		expect(setYouTubeRelay).not.toHaveBeenCalled();
	});

	it("reads a server older than the switch, which relays no bangumi, as off", async () => {
		const { bangumiRelay: _relay, bangumiSpent: _spent, ...older } = off;
		settings.mockResolvedValue(older);

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		const none = await screen.findByRole("radio", { name: /Relay no bangumi/ });
		await waitFor(() => expect(none.getAttribute("aria-checked")).toBe("true"));
	});

	it("cannot be moved without the settings", async () => {
		settings.mockResolvedValue({ ...off, bangumiRelay: true });

		render(<WatchCard canSettings={false} onSignedOut={vi.fn()} />);

		const none = await screen.findByRole("radio", { name: /Relay no bangumi/ });
		await waitFor(() => expect(settings).toHaveBeenCalled());

		expect((none as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(none);
		expect(setBangumiRelay).not.toHaveBeenCalled();
	});

	it("says what it has carried since the server started, apart from YouTube's", async () => {
		settings.mockResolvedValue({ ...off, youtubeRelay: true, youtubeSpent: 5_200_000, bangumiRelay: true, bangumiSpent: 7_300_000 });

		render(<WatchCard canSettings onSignedOut={vi.fn()} />);

		expect(await screen.findByText("7.3 MB relayed since restart")).toBeDefined();
		expect(screen.getByText("5.2 MB relayed since restart")).toBeDefined();
	});
});
