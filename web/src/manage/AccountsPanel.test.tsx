import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountsPanel } from "./AccountsPanel";
import type { Account, Policy, Watching } from "./api";

/*
 * What these guard is a row of checkboxes that each look as though they work.
 *
 * The server changes the permissions it is sent and leaves the rest as it holds
 * them. A box that sent the whole set as the page last drew it — which is what
 * this page did — would save, the box it moved reading back exactly as ticked,
 * and quietly put the other five back to however they stood when the page last
 * asked, up to half a minute earlier: an Emby grant another administrator had
 * just given, taken back by whoever next ticked Music. Nothing on screen says
 * so until the person turns up without it.
 *
 * The rest are the same shape. A box that does not show the press until the
 * server answers reads as a box that did not take, and invites the press that
 * undoes it; one that keeps showing a press the server refused is a page lying
 * about who holds what. And the Emby box, which the accounts capability may not
 * tick, has to be drawn as such rather than offered and refused — and has to be
 * left out when somebody without moderate ticks a box beside it, or the server
 * would read the change as theirs to refuse.
 */

const { accounts, changeAccount, addAccount, settings, policy, actionFailed } = vi.hoisted(() => ({
	accounts: vi.fn(),
	changeAccount: vi.fn(),
	addAccount: vi.fn(),
	settings: vi.fn(),
	policy: vi.fn(),
	actionFailed: vi.fn(),
}));

vi.mock("./api", () => ({
	// The poll reaches for this to tell a lost session from a failure.
	SignedOut: class SignedOut extends Error {},
	api: { accounts, changeAccount, addAccount, settings, policy, dropAccount: vi.fn() },
}));

vi.mock("@/live/notices", () => ({ actionFailed }));

const DEFAULTS = { watch: true, emby: false, music: true, arrange: true, invite: true, open: true };

function account(name: string, effective: Partial<typeof DEFAULTS> = {}, embySpent?: number): Account {
	return {
		name,
		trip: `t${name.padEnd(7, "0")}`,
		effective: { ...DEFAULTS, ...effective },
		embySpent,
	};
}

const on: Watching = { configured: true, directOnly: true, embyRelay: true };

function opening(openedBy: Policy["openedBy"]): Policy {
	return {
		openedBy,
		chosen: openedBy,
		configured: openedBy,
		joinedBy: "invited",
		chosenJoin: "invited",
		configuredJoin: "invited",
		remember: 0,
	};
}

/** The row an account is drawn in, found by its name. */
async function row(name: string): Promise<HTMLElement> {
	const named = await screen.findByText(name);
	const item = named.closest("li");
	if (!item) throw new Error(`no row for ${name}`);
	return item;
}

/** Open a row's permissions and hand back the box for one of them. */
async function box(name: string, label: string): Promise<HTMLInputElement> {
	const item = await row(name);
	fireEvent.click(within(item).getByRole("button", { name: "Permissions" }));
	return within(item).getByRole("checkbox", { name: label }) as HTMLInputElement;
}

beforeEach(() => {
	vi.clearAllMocks();
	accounts.mockResolvedValue([account("ada"), account("bea", { emby: true }, 1_500_000_000)]);
	settings.mockResolvedValue(on);
	policy.mockResolvedValue(opening("accounts"));
	changeAccount.mockResolvedValue({ name: "ada", trip: "tada0000" });
});

describe("a permission box", () => {
	it("sends the box that moved, and nothing about the others", async () => {
		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		fireEvent.click(await box("ada", "Music"));

		await waitFor(() => expect(changeAccount).toHaveBeenCalledTimes(1));

		// The whole point. The other five as this page last drew them would be
		// the other five as they stood when it last asked, written back over
		// whatever anybody changed since.
		expect(changeAccount).toHaveBeenCalledWith("ada", { perms: { music: false } });
	});

	it("shows the press at once, and takes it back when the server refuses", async () => {
		let refuse: (reason: Error) => void = () => {};
		changeAccount.mockReturnValue(
			new Promise((_, reject) => {
				refuse = reject;
			}),
		);

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		const music = await box("ada", "Music");
		fireEvent.click(music);

		// Before the server has said anything.
		expect(music.checked).toBe(false);

		refuse(new Error("The store is not answering, so nothing was changed."));

		await waitFor(() => expect(music.checked).toBe(true));
		expect(actionFailed).toHaveBeenCalledWith("The store is not answering, so nothing was changed.");
	});

	it("waits for the request before it, and then sends the presses made since", async () => {
		// A server that lays what it is sent over what it holds, as the real one
		// does, so the list read back after the first request says what that
		// request wrote.
		let ada = { ...DEFAULTS };
		accounts.mockImplementation(async () => [account("ada", ada)]);

		let answer: () => void = () => {};
		changeAccount.mockImplementationOnce(
			(_name: string, change: { perms: Partial<typeof DEFAULTS> }) =>
				new Promise((resolve) => {
					answer = () => {
						ada = { ...ada, ...change.perms };
						resolve({ name: "ada", trip: "tada0000" });
					};
				}),
		);
		changeAccount.mockImplementation(async (_name: string, change: { perms: Partial<typeof DEFAULTS> }) => {
			ada = { ...ada, ...change.perms };
			return { name: "ada", trip: "tada0000" };
		});

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		const music = await box("ada", "Music");
		const links = within(await row("ada")).getByRole("checkbox", { name: "Guest links" }) as HTMLInputElement;

		fireEvent.click(music);
		fireEvent.click(links);

		await waitFor(() => expect(changeAccount).toHaveBeenCalledTimes(1));

		// Both shown at once, and only one request on its way. Two in flight
		// together can land in either order, and a box ticked and unticked
		// quickly would then be left as it was pressed first.
		expect(music.checked).toBe(false);
		expect(links.checked).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(changeAccount).toHaveBeenCalledTimes(1);

		answer();

		await waitFor(() => expect(changeAccount).toHaveBeenCalledTimes(2));
		expect(changeAccount).toHaveBeenLastCalledWith("ada", { perms: { invite: false } });

		// Every request named only boxes that were pressed.
		for (const [, change] of changeAccount.mock.calls as [string, { perms: Record<string, boolean> }][]) {
			expect(Object.keys(change.perms).every((key) => key === "music" || key === "invite")).toBe(true);
		}

		await waitFor(() => expect(ada).toEqual({ ...DEFAULTS, music: false, invite: false }));
		expect(music.checked).toBe(false);
		expect(links.checked).toBe(false);
	});

	it("does not send back a list not yet reread", async () => {
		// The same list, the same object, every time it is asked for: a reread
		// that has not yet been drawn, which in a browser is every reread at the
		// moment the next queued request leaves — the answer lands in state and
		// is drawn a task later, and the request goes in the same turn.
		const list = [account("ada")];
		accounts.mockResolvedValue(list);

		let answer: () => void = () => {};
		changeAccount.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = () => resolve({ name: "ada", trip: "tada0000" });
				}),
		);

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		fireEvent.click(await box("ada", "Music"));
		fireEvent.click(within(await row("ada")).getByRole("checkbox", { name: "Guest links" }));

		await waitFor(() => expect(changeAccount).toHaveBeenCalledTimes(1));
		answer();

		// Built on the list as last drawn, this would send the music library
		// back as it was before the first request and undo it.
		await waitFor(() => expect(changeAccount).toHaveBeenCalledTimes(2));
		expect(changeAccount).toHaveBeenLastCalledWith("ada", { perms: { invite: false } });
	});

	it("leaves a refused box out of the request that follows it", async () => {
		changeAccount.mockRejectedValueOnce(
			new Error("Only an administrator who can manage everything can give or take away Emby, or set the passphrase of somebody who has it."),
		);

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		const emby = await box("ada", "Emby library");
		const music = within(await row("ada")).getByRole("checkbox", { name: "Music" });

		fireEvent.click(emby);
		fireEvent.click(music);

		await waitFor(() => expect(changeAccount).toHaveBeenCalledTimes(2));

		// Sent again, the refused grant would be refused again and take the
		// music box down with it.
		expect(changeAccount).toHaveBeenLastCalledWith("ada", { perms: { music: false } });
		await waitFor(() => expect(emby.checked).toBe(false));
	});
});

describe("the Emby box", () => {
	it("is not offered to somebody who manages accounts but not everything, and says why", async () => {
		render(<AccountsPanel canAccounts canModerate={false} onSignedOut={vi.fn()} />);

		const emby = await box("bea", "Emby library");
		expect(emby.disabled).toBe(true);
		expect(
			within(await row("bea")).getByText("Only an administrator who can manage everything can change this."),
		).toBeDefined();

		// And a box beside it says nothing about Emby, so the server has no
		// change to Emby to refuse somebody without moderate.
		fireEvent.click(within(await row("bea")).getByRole("checkbox", { name: "Music" }));

		await waitFor(() => expect(changeAccount).toHaveBeenCalledWith("bea", { perms: { music: false } }));
	});

	it("is moderate's to tick", async () => {
		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		const emby = await box("ada", "Emby library");
		expect(emby.disabled).toBe(false);

		fireEvent.click(emby);

		await waitFor(() => expect(changeAccount).toHaveBeenCalledWith("ada", { perms: { emby: true } }));
	});

	it("says when the switch above every grant is off", async () => {
		settings.mockResolvedValue({ ...on, embyRelay: false });

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		await box("ada", "Emby library");

		expect(
			await screen.findByText(
				"The Emby relay is switched off for the whole site, so this does nothing until it is turned on under Rooms.",
			),
		).toBeDefined();
	});

	it("is struck on an account that is blocked, which the server holds to nothing", async () => {
		accounts.mockResolvedValue([{ ...account("bea", { emby: true }, 1_500_000_000), blocked: true }]);

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		const badge = (await within(await row("bea")).findByText(/relayed since restart/)).parentElement as HTMLElement;
		expect(badge.textContent).toContain("not allowed");
		expect(within(badge).getByText("Emby library").className).toContain("line-through");
	});

	it("is drawn with what it has cost, on the rows that hold it", async () => {
		render(<AccountsPanel canAccounts={false} canModerate={false} onSignedOut={vi.fn()} />);

		const figure = within(await row("bea")).getByText(/1\.50 GB relayed since restart/);
		expect(within(await row("ada")).queryByText(/relayed since restart/)).toBeNull();

		// Live where nothing stops it, so the struck badge above is struck for
		// being blocked and not for some other reason.
		expect(figure.parentElement?.textContent).not.toContain("not allowed");
	});
});

describe("an administrator who may only look", () => {
	it("sees what each account holds and nothing to press", async () => {
		accounts.mockResolvedValue([account("ada", { music: false })]);

		render(<AccountsPanel canAccounts={false} canModerate={false} onSignedOut={vi.fn()} />);

		const item = await row("ada");

		expect(within(item).queryByRole("button", { name: "Permissions" })).toBeNull();
		expect(within(item).queryByRole("checkbox")).toBeNull();

		// Taken away is drawn, not left out: struck through, and said.
		expect(within(item).getByText("Music").textContent).toContain("not allowed");
		expect(within(item).getByText("Guest links").textContent).not.toContain("not allowed");
	});
});

describe("a new passphrase", () => {
	it("is shown to pass on only when the server took it", async () => {
		changeAccount.mockRejectedValue(new Error("The store is not answering, so nothing was changed."));

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		const item = await row("ada");
		fireEvent.click(within(item).getByRole("button", { name: "Set a new passphrase" }));
		fireEvent.click(await within(item).findByRole("button", { name: "Set it" }));

		await waitFor(() => expect(actionFailed).toHaveBeenCalled());

		// A passphrase the server never set, offered as the one to hand over,
		// is somebody locked out by the person trying to let them in.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.queryByText(/Give this to ada now/)).toBeNull();
	});

	// Setting the passphrase of somebody who holds Emby is choosing who holds
	// it, and the server refuses it to anybody it refuses the box to. Offered
	// anyway, the key would be a press refused every time, beside a box that
	// says why and a key that did not.
	it("is not offered for somebody holding Emby, to an administrator who cannot give it", async () => {
		render(<AccountsPanel canAccounts canModerate={false} onSignedOut={vi.fn()} />);

		const locked = within(await row("bea")).getByRole("button", { name: "Set a new passphrase" }) as HTMLButtonElement;
		expect(locked.disabled).toBe(true);
		expect(locked.title).toBe(
			"Only an administrator who can manage everything can give or take away Emby, or set the passphrase of somebody who has it.",
		);

		// Anybody else's is.
		const open = within(await row("ada")).getByRole("button", { name: "Set a new passphrase" }) as HTMLButtonElement;
		expect(open.disabled).toBe(false);
	});

	it("is offered for somebody holding Emby to an administrator who can give it", async () => {
		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		const key = within(await row("bea")).getByRole("button", { name: "Set a new passphrase" }) as HTMLButtonElement;
		expect(key.disabled).toBe(false);
	});
});

describe("a new account", () => {
	it("is made holding exactly what its boxes showed", async () => {
		addAccount.mockResolvedValue({ name: "cy", trip: "tcy00000" });

		render(<AccountsPanel canAccounts canModerate={false} onSignedOut={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: "New account" }));

		const form = (await screen.findByText("First passphrase")).closest("form") as HTMLElement;

		// Everything on but Emby, which is given to people one at a time and
		// is not this administrator's to give.
		const emby = within(form).getByRole("checkbox", { name: "Emby library" }) as HTMLInputElement;
		expect(emby.checked).toBe(false);
		expect(emby.disabled).toBe(true);
		expect((within(form).getByRole("checkbox", { name: "Music" }) as HTMLInputElement).checked).toBe(true);

		fireEvent.click(within(form).getByRole("checkbox", { name: "Guest links" }));
		fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "cy" } });
		fireEvent.click(within(form).getByRole("button", { name: "Create" }));

		await waitFor(() => expect(addAccount).toHaveBeenCalledTimes(1));
		expect(addAccount.mock.calls[0]?.[0]).toBe("cy");
		expect(addAccount.mock.calls[0]?.[2]).toEqual({ ...DEFAULTS, invite: false });
	});
});

/*
 * A line and the field that edits it are one thing in two states, and each
 * leaves as the other arrives. The field used to fade in over a line that had
 * already gone between two frames, and fade out — it did not; it was removed —
 * as the line came back.
 */
describe("the note", () => {
	it("fades out as the field that edits it fades in, and back", async () => {
		accounts.mockResolvedValue([{ ...account("ada"), note: "the one from accounts" }]);
		changeAccount.mockResolvedValue({});

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		const line = await within(await row("ada")).findByRole("button", { name: "the one from accounts" });
		fireEvent.click(line);

		const field = within(await row("ada")).getByRole("textbox", { name: "Note" });

		// Both on screen for a moment: the line on its way out, the field on
		// its way in.
		expect(line.isConnected).toBe(true);
		expect(line.parentElement?.className).toContain("animate-fade-out");
		expect(field.parentElement?.className).toContain("animate-fade-in");

		await waitFor(() => expect(line.isConnected).toBe(false));

		fireEvent.keyDown(field, { key: "Escape" });

		const back = await within(await row("ada")).findByRole("button", { name: "the one from accounts" });
		expect(field.isConnected).toBe(true);
		expect(field.parentElement?.className).toContain("animate-fade-out");
		expect(back.parentElement?.className).toContain("animate-fade-in");

		// Still focused while it fades, so a click elsewhere blurs it; put away
		// with Escape, it must not save on its way out.
		fireEvent.blur(field);
		expect(changeAccount).not.toHaveBeenCalled();

		await waitFor(() => expect(field.isConnected).toBe(false));
	});
});

describe("the note, saved", () => {
	// The field stays focused while it fades out, so the blur that follows a
	// save would be a second save of the same note.
	it("saves once, when Enter is followed by the field leaving", async () => {
		accounts.mockResolvedValue([account("ada")]);
		changeAccount.mockResolvedValue({});

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		fireEvent.click(await within(await row("ada")).findByRole("button", { name: "Add a note" }));
		const field = within(await row("ada")).getByRole("textbox", { name: "Note" });

		fireEvent.change(field, { target: { value: "the one from accounts" } });
		fireEvent.keyDown(field, { key: "Enter" });
		fireEvent.blur(field);

		await waitFor(() => expect(changeAccount).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(field.isConnected).toBe(false));
		expect(changeAccount).toHaveBeenCalledTimes(1);
		expect(changeAccount).toHaveBeenCalledWith("ada", { note: "the one from accounts" });
	});
});

describe("the scopes", () => {
	it("leave as the field that edits them arrives, and come back as it leaves", async () => {
		accounts.mockResolvedValue([{ ...account("ada"), scopes: ["acme"] }]);

		render(<AccountsPanel canAccounts canModerate onSignedOut={vi.fn()} />);

		const tags = (await within(await row("ada")).findByText("@acme")).parentElement as HTMLElement;
		fireEvent.click(within(await row("ada")).getByRole("button", { name: "Scopes" }));

		const field = within(await row("ada")).getByRole("textbox", { name: "Scopes" });

		expect(tags.isConnected).toBe(true);
		expect(tags.parentElement?.className).toContain("animate-fade-out");
		expect(field.parentElement?.className).toContain("animate-fade-in");
		await waitFor(() => expect(tags.isConnected).toBe(false));

		fireEvent.keyDown(field, { key: "Escape" });

		expect(field.parentElement?.className).toContain("animate-fade-out");
		const back = (await within(await row("ada")).findByText("@acme")).parentElement as HTMLElement;
		expect(back.parentElement?.className).toContain("animate-fade-in");

		fireEvent.blur(field);
		expect(changeAccount).not.toHaveBeenCalled();

		await waitFor(() => expect(field.isConnected).toBe(false));
	});
});
