import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminsPanel } from "./AdminsPanel";
import type { Administrator } from "./api";

/*
 * What these guard is a role written by something that only meant to touch a
 * name.
 *
 * The roster lists every capability an administrator holds, moderate's four
 * included, because that is what a page needs to ask whether somebody may do
 * something. It is not what anybody granted: a moderator was given one word.
 * This page used to send the list back with every rename, so renaming a
 * moderator wrote four grants nobody chose into their record — harmless today,
 * a record an older build refuses on a rollback, and invisible on screen
 * because the four are exactly what moderate already holds.
 *
 * The role control has the same hazard in the other direction. Custom is read
 * from what was written, not from what is held, or every moderator would draw
 * as a custom administrator with all four ticked, and the first box anybody
 * unticked would quietly take away the roster and the Emby grant with it.
 *
 * And the Emby box: every administrator needs it ticked like anybody else, only
 * somebody who can manage everything may tick it, and that includes ticking it
 * for themselves.
 */

const { admins, changeAdmin, addAdmin, changePassphrase, actionFailed } = vi.hoisted(() => ({
	admins: vi.fn(),
	changeAdmin: vi.fn(),
	addAdmin: vi.fn(),
	changePassphrase: vi.fn(),
	actionFailed: vi.fn(),
}));

vi.mock("./api", () => ({
	// The poll reaches for this to tell a lost session from a failure.
	SignedOut: class SignedOut extends Error {},
	api: { admins, changeAdmin, addAdmin, dropAdmin: vi.fn(), changePassphrase },
}));

vi.mock("@/live/notices", () => ({ actionFailed }));

const HELD = { watch: true, emby: false, music: true, arrange: true, invite: true, open: true };
const EVERYTHING = ["observe", "rooms", "accounts", "relays", "settings", "moderate"];

function admin(name: string, granted: string[], extra: Partial<Administrator> = {}): Administrator {
	const moderate = granted.includes("moderate");

	return {
		trip: `t${name.toLowerCase().padEnd(7, "0")}`,
		name,
		can: moderate ? EVERYTHING : ["observe", ...granted],
		granted,
		effective: { ...HELD },
		...extra,
	};
}

/** The row an administrator is drawn in: a field to somebody who may rename, text to anybody else. */
async function row(name: string): Promise<HTMLElement> {
	await screen.findAllByRole("listitem");

	const named = screen.queryByDisplayValue(name) ?? screen.getByText(name);
	const item = named.closest("li");
	if (!item) throw new Error(`no row for ${name}`);
	return item;
}

beforeEach(() => {
	vi.clearAllMocks();
	admins.mockResolvedValue([
		admin("Owner", ["moderate"], { self: true }),
		admin("Second", ["moderate"]),
		admin("Helper", ["accounts"]),
		admin("Viewer", []),
	]);
	changeAdmin.mockResolvedValue({ changed: "x" });
});

describe("renaming somebody", () => {
	it("sends the name and nothing else", async () => {
		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		const field = await screen.findByDisplayValue("Second");
		fireEvent.change(field, { target: { value: "Deputy" } });
		fireEvent.blur(field);

		await waitFor(() => expect(changeAdmin).toHaveBeenCalledTimes(1));

		// Exactly this. The role the list spells out — moderate and its four —
		// sent beside it would be written as granted.
		expect(changeAdmin).toHaveBeenCalledWith("tsecond0", { name: "Deputy" });
	});
});

describe("the role", () => {
	it("is read from what was written, so a moderator is not a custom administrator", async () => {
		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		expect((within(await row("Second")).getByRole("combobox") as HTMLSelectElement).value).toBe(
			"moderate",
		);
		expect(within(await row("Second")).queryByRole("checkbox", { name: "Manage rooms" })).toBeNull();

		expect((within(await row("Helper")).getByRole("combobox") as HTMLSelectElement).value).toBe(
			"custom",
		);
	});

	it("draws a custom administrator's boxes as written, and sends the box that moved", async () => {
		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		const item = await row("Helper");
		const accounts = within(item).getByRole("checkbox", { name: "Manage accounts" }) as HTMLInputElement;
		const relays = within(item).getByRole("checkbox", { name: "Manage relays" }) as HTMLInputElement;

		expect(accounts.checked).toBe(true);
		expect(relays.checked).toBe(false);

		fireEvent.click(relays);

		// Shown before the server answers.
		expect(relays.checked).toBe(true);

		// The box, laid by the server over the list it holds. The whole list as
		// this page drew it would put back whatever another administrator
		// changed since; a list built from the press alone, which this sent for
		// a while, took Accounts away from somebody given Relays.
		await waitFor(() => expect(changeAdmin).toHaveBeenCalledWith("thelper0", { caps: { relays: true } }));
		expect(changeAdmin).toHaveBeenCalledTimes(1);
		expect(accounts.checked).toBe(true);
	});

	it("sends the boxes pressed, and never a list, however quickly they are pressed", async () => {
		let answer: () => void = () => {};
		changeAdmin.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = () => resolve({ changed: "thelper0" });
				}),
		);

		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		const item = await row("Helper");
		fireEvent.click(within(item).getByRole("checkbox", { name: "Manage relays" }));
		fireEvent.click(within(item).getByRole("checkbox", { name: "Site settings" }));

		await waitFor(() => expect(changeAdmin).toHaveBeenCalledTimes(1));
		answer();
		await waitFor(() => expect(changeAdmin).toHaveBeenCalledTimes(2));

		// The first leaves after both presses, carrying both; the second carries
		// what is still unanswered. Neither carries a list, and neither names a
		// box nobody pressed.
		expect(changeAdmin).toHaveBeenNthCalledWith(1, "thelper0", { caps: { relays: true, settings: true } });
		expect(changeAdmin).toHaveBeenNthCalledWith(2, "thelper0", { caps: { settings: true } });

		for (const [, change] of changeAdmin.mock.calls as [string, Record<string, unknown>][]) {
			expect(change.can).toBeUndefined();
		}
	});

	it("keeps a moderator's four when they are made custom, and drops only the roster", async () => {
		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		fireEvent.change(within(await row("Second")).getByRole("combobox"), {
			target: { value: "custom" },
		});

		await waitFor(() =>
			expect(changeAdmin).toHaveBeenCalledWith("tsecond0", {
				can: ["rooms", "accounts", "relays", "settings"],
			}),
		);
	});

	it("changes nothing for somebody who may only look until a box is ticked", async () => {
		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		const item = await row("Viewer");
		fireEvent.change(within(item).getByRole("combobox"), { target: { value: "custom" } });

		const rooms = (await within(item).findByRole("checkbox", { name: "Manage rooms" })) as HTMLInputElement;
		expect(rooms.checked).toBe(false);
		expect(changeAdmin).not.toHaveBeenCalled();

		fireEvent.click(rooms);

		await waitFor(() => expect(changeAdmin).toHaveBeenCalledWith("tviewer0", { caps: { rooms: true } }));
	});

	it("cannot be taken from the last administrator who can manage everything", async () => {
		admins.mockResolvedValue([admin("Owner", ["moderate"], { self: true }), admin("Viewer", [])]);

		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		expect((within(await row("Owner")).getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
		expect((within(await row("Viewer")).getByRole("combobox") as HTMLSelectElement).disabled).toBe(false);
	});
});

describe("an administrator's Emby", () => {
	it("is ticked by somebody who can manage everything, for themselves as for anybody", async () => {
		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		fireEvent.click(
			within(await row("Owner")).getByRole("checkbox", { name: "May use the Emby library" }),
		);

		// The box, and nothing about the rest: the server lays it over what it
		// holds, so a page drawn a while ago cannot undo anything with it.
		await waitFor(() => expect(changeAdmin).toHaveBeenCalledWith("towner00", { perms: { emby: true } }));
	});

	it("is shown, and not offered, to somebody who cannot manage everything", async () => {
		admins.mockResolvedValue([
			admin("Owner", ["moderate"], { self: true }),
			admin("Helper", ["accounts"], {
				effective: { ...HELD, emby: true },
				embySpent: 2_000_000,
			}),
		]);

		render(<AdminsPanel canModerate={false} onSignedOut={vi.fn()} />);

		const item = await row("Helper");

		expect(within(item).queryByRole("checkbox", { name: "May use the Emby library" })).toBeNull();
		expect((within(item).getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
		expect(within(item).getByText(/2\.0 MB relayed since restart/)).toBeDefined();

		// The custom boxes are drawn so the role can be read, and cannot be moved.
		expect(
			(within(item).getByRole("checkbox", { name: "Manage accounts" }) as HTMLInputElement).disabled,
		).toBe(true);
	});
});

describe("adding somebody", () => {
	it("sends the boxes ticked for a custom role, and their Emby", async () => {
		addAdmin.mockResolvedValue({ added: "tnew0000" });

		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: "Add somebody" }));

		const form = (await screen.findByPlaceholderText("Signature")).closest("form") as HTMLElement;

		fireEvent.change(within(form).getByPlaceholderText("Signature"), { target: { value: "tNew0000" } });
		fireEvent.change(within(form).getByRole("combobox"), { target: { value: "custom" } });
		fireEvent.click(await within(form).findByRole("checkbox", { name: "Site settings" }));
		fireEvent.click(within(form).getByRole("checkbox", { name: "May use the Emby library" }));
		fireEvent.click(within(form).getByRole("button", { name: "Add" }));

		await waitFor(() =>
			expect(addAdmin).toHaveBeenCalledWith({
				trip: "tnew0000",
				name: "",
				can: ["settings"],
				perms: { emby: true },
			}),
		);
	});
});

/*
 * The line under the passphrase form is a hint until the passphrase changes and
 * then the answer, and the hint used to vanish between two frames as the answer
 * faded in over the place it had been.
 */
describe("your own passphrase", () => {
	it("lets the hint leave as the answer arrives", async () => {
		changePassphrase.mockResolvedValue({ trip: "tnewsig00" });

		render(<AdminsPanel canModerate onSignedOut={vi.fn()} />);

		const hint = await screen.findByText("At least eight characters.");

		fireEvent.change(screen.getByLabelText("Current passphrase"), { target: { value: "the old one" } });
		fireEvent.change(screen.getByLabelText("New passphrase"), { target: { value: "the new one, longer" } });
		fireEvent.click(screen.getByRole("button", { name: "Change it" }));

		const answer = await screen.findByText("tnewsig00");

		// Both there for a moment: the hint on its way out, the answer on its way in.
		expect(hint.isConnected).toBe(true);
		expect(hint.parentElement?.className).toContain("animate-fade-out");
		expect(answer.closest("span.animate-fade-in")).not.toBeNull();

		await waitFor(() => expect(hint.isConnected).toBe(false));
	});
});
