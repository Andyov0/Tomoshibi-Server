/**
 * Which screen somebody lands on.
 *
 * Six conditions decide it — an invitation, whether this tab was already in
 * this room, whether there is an account, what the address names, and what the
 * deployment lets people open — and the order between them is the whole of the
 * policy. It lived inline in an effect that also connects to a room, mints a
 * name and reads four kinds of storage, which meant the only way to exercise it
 * was to render the application and mock all of that.
 *
 * So it was never exercised, and it was wrong in the case that matters most to
 * a deployment that has any settings at all: somebody told the name of a
 * meeting, on a deployment where not everybody may open one, was sent to a
 * sign-in page for an account they do not have. The server would have admitted
 * them — the setting governs who may say a name first, not who may join a name
 * already in use — but nothing asked it. Three separate places promise that
 * path works: the management page, the README, and two sentences in the join
 * screen written for exactly this person and reachable by nobody.
 *
 * Pure, and returning what to do rather than doing it, so each branch is one
 * assertion.
 */

/**
 * What the deployment lets people do with a name nobody has used.
 *
 * Re-exported rather than written again. It was written again, in three files,
 * and adding a fourth setting compiled in two of them — the third failed at the
 * one place the two copies met, which is a good deal luckier than it sounds.
 */
import type { Opening } from "./api";

export type { Opening };

export type Arriving = {
	/** The room an invitation names, if one was presented and was good. */
	invitation?: string;
	/** The room the address names, empty when it names none. */
	address: string;
	/** The room this tab was last in, empty when it was in none. */
	wasIn: string;
	/** Whether somebody is signed in. */
	account: boolean;
	/** The token of an arranged meeting the address carried, if any. */
	meeting?: string;
	opening: Opening;
};

export type Landing =
	/** Straight back into the call, as an account holder. */
	| { at: "ready"; rejoin: true }
	/** Straight back into the call, as somebody with no account. */
	| { at: "invited"; room: string; rejoin: true }
	/** The join screen, on the room the invitation names. */
	| { at: "invited"; room: string; rejoin: false }
	/** The join screen, on the room the address names. */
	| { at: "open" }
	/** The join screen, on a name minted for the occasion. */
	| { at: "open"; mint: true }
	/** The join screen, waiting on a meeting somebody arranged. */
	| { at: "arranged"; token: string }
	| { at: "lobby" }
	| { at: "sign in" };

export function doorway(arriving: Arriving): Landing {
	// An invitation wins over everything. Somebody holding one was sent to a
	// particular meeting, and asking them to sign in first is asking them for
	// something they were never given.
	/*
	 * Except when it is for somewhere else. A tab keeps the last invitation it
	 * was let in on, and a person opening a meeting link for one room while
	 * holding last week's invitation to another was being sent to last week's
	 * room. The link in hand names where they mean to be; an invitation to the
	 * same room is the shorter way in, and to any other room it is a stale
	 * scrap of a different day.
	 */
	const elsewhere = Boolean(arriving.meeting && arriving.address && arriving.invitation !== arriving.address);

	/*
	 * And back into the call where this tab was in that room a moment ago,
	 * which is a reload rather than an arrival. The rule for that below was
	 * written for people with no account, who are mostly people on an
	 * invitation, and never reached them: the invitation was decided first
	 * and sent them to the join screen, so a guest who refreshed pressed Join
	 * again every time while somebody who had only been told the name went
	 * straight back. Asked for by the owner, 2026-10-20, for somebody who has
	 * already gone in. A deliberate leave forgets the room (leftRoom), so
	 * leaving and then reloading is still the join screen.
	 */
	if (arriving.invitation && !elsewhere) {
		return { at: "invited", room: arriving.invitation, rejoin: arriving.wasIn === arriving.invitation };
	}

	// A reload while in a call must not lose the call. The guard is that this
	// tab was in this room, not that somebody is signed in: signed in was the
	// wrong test twice over, walking somebody who had merely pasted a link
	// straight into the call without a look at their own camera, and leaving
	// everybody who arrived on an invitation — who has no account by design —
	// pressing Join again after every refresh.
	if (arriving.address && arriving.wasIn === arriving.address) {
		return arriving.account
			? { at: "ready", rejoin: true }
			: { at: "invited", room: arriving.address, rejoin: true };
	}

	// Back into the call rather than to the screen in front of it. They were on
	// the microphone a second ago; the surprising thing is not it carrying on,
	// it is a call that stops because a page was reloaded.
	/*
	 * A meeting link, after an invitation and after a call this tab was in,
	 * and before anything that would join straight away.
	 *
	 * After the invitation, because a person holding both has already been let
	 * in once and the invitation is the shorter way back. After the call this
	 * tab was in, because the token is kept for the tab: a reload during the
	 * meeting would otherwise land on the waiting screen and ask the host to
	 * start a meeting they are already in.
	 *
	 * Before the signed-in rule, and this is the one that matters: a host who
	 * opens their own link is signed in and on the room's address, and the rule
	 * below would walk them straight into the room — which begins the meeting
	 * with no moment to see that that is what pressing Join now means.
	 */
	if (arriving.meeting) {
		return { at: "arranged", token: arriving.meeting };
	}

	if (arriving.account && arriving.address) {
		return { at: "ready", rejoin: true };
	}

	// A deployment anybody may open a room on has no lobby, so a bare address
	// means a new meeting and one is minted.
	if (arriving.opening === "anyone") {
		return arriving.address ? { at: "open" } : { at: "open", mint: true };
	}

	// Somebody who was given a name gets to try it, whatever the setting is.
	// The server refuses only a name that has never been used, so a colleague
	// told the name of a meeting happening right now is somebody it will admit.
	//
	// Not treated as a guest: under the middle setting a passphrase is
	// precisely what lets them open a new name, so hiding the field would hide
	// the answer.
	if (arriving.address) {
		return { at: "open" };
	}

	return arriving.account ? { at: "lobby" } : { at: "sign in" };
}
