import type { Phrase } from "@/live/i18n";

/**
 * What a person may use, and what an administrator may change, as the
 * management pages name them.
 *
 * Two lists that look alike and are not the same kind of thing. A permission
 * belongs to somebody with an account and decides what they can do in a call —
 * start watching together, open the music library, spend the deployment's
 * bandwidth on a film. A capability belongs to an administrator and decides
 * which of these pages' switches they may move. They meet in one place, the
 * Emby box, which is a permission that only the widest capability may tick.
 *
 * The words are the server's (store/perms.go and config.go) and the order is
 * the server's too, so a row reads the same here as in the audit log.
 */

/** The permissions an account can hold, in the order the server lists them. */
export const PERMISSIONS = ["watch", "emby", "music", "arrange", "invite", "open"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * What each permission is called on a page.
 *
 * Three of them reuse what the call already calls the feature, so that the
 * box an administrator ticks and the button the person then finds have the
 * same name. "Can watch" is not among them: it is already the administrator
 * level that may only look, and a box with that label on an account would read
 * as the account being made a read-only administrator.
 */
export const PERMISSION_NAMES: Record<Permission, Phrase> = {
	watch: "Watch together",
	emby: "Emby library",
	music: "Music",
	arrange: "Arrange meetings",
	invite: "Guest links",
	open: "Open new rooms",
};

/**
 * What a new account starts with, before the server has said anything.
 *
 * The one place the page has to know the defaults. Everywhere else it draws
 * from what the server reports an account holds, so that a default changed on
 * the server is not drawn wrongly here; a form for an account that does not
 * exist yet has nothing to be told, and these mirror store/perms.go — every
 * permission on except Emby, which spends the deployment's bandwidth and is
 * given to people one at a time.
 */
export const DEFAULTS: Record<Permission, boolean> = {
	watch: true,
	emby: false,
	music: true,
	arrange: true,
	invite: true,
	open: true,
};

/**
 * The capabilities a custom administrator can be given, in the server's order.
 *
 * Observe is not among them because everybody listed holds it, and moderate is
 * not because it is the role the select names rather than a fifth box: it holds
 * all four and the roster besides, and drawn as a box it would invite somebody
 * to tick it beside the four and wonder what it added.
 */
export const CAPABILITIES = ["rooms", "accounts", "relays", "settings"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_NAMES: Record<Capability, Phrase> = {
	rooms: "Manage rooms",
	accounts: "Manage accounts",
	relays: "Manage relays",
	settings: "Site settings",
};

/** What the person reading these pages may change, one flag per panel's worth. */
export interface Powers {
	rooms: boolean;
	accounts: boolean;
	relays: boolean;
	settings: boolean;
	/** Everything, and the roster, and the Emby grant. */
	moderate: boolean;
}

/**
 * The flags, from the list the server sent.
 *
 * The server spells every capability out, moderate's four included, so the
 * list alone would do. Moderate is read as implying them here as well because
 * a page newer than its server would otherwise lock a moderator out of every
 * switch the moment it was deployed ahead of the binary — the older server
 * says only observe and moderate.
 */
export function powers(can: readonly string[]): Powers {
	const moderate = can.includes("moderate");
	const holds = (one: Capability) => moderate || can.includes(one);

	return {
		rooms: holds("rooms"),
		accounts: holds("accounts"),
		relays: holds("relays"),
		settings: holds("settings"),
		moderate,
	};
}
