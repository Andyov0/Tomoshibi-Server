import { type Invitation, type Me, inviteToken, invited, me as whoAmI } from "@/live/account";
import { doorway } from "@/live/doorway";
import { forget as forgetTimings } from "@/live/relays";
import { chosenRelay, leftRoom, rememberRelay, wasIn } from "@/live/api";
import { deployment, join as requestJoin } from "@/live/api";
import { generateRoomName, normaliseRoomName, validRoomName } from "@/live/names";
import { connect, create } from "@/live/room";
import { cushionShares } from "@/live/delay";
import { watchShareFreezes } from "@/live/freeze";
import { magnifyShares } from "@/live/lens";
import { forgetMeeting, keepMeeting, meetingToken, whenSaid } from "@/live/meeting";
import { useT } from "@/hooks/useT";
import { deviceFailed, joinFailed, newerVersion } from "@/live/notices";
import { watchForNewerBuild } from "@/live/freshness";
import { Lobby, SignIn } from "@/routes/Lobby";
import { type Choices, PreJoin, rememberedName } from "@/routes/PreJoin";
import { Landing, type LandingProps } from "@/routes/Landing";
import { fromHere, insideAnApp, offerFor, offeredTo, opened, pass, passed } from "@/live/landing";
import { ipad, platform } from "@/live/platform";
import { rememberedDevices, restoreDevices } from "@/live/preferences";
import { Moving } from "@/components/room/Moving";
import { Room } from "@/routes/Room";
import { RoomEvent, type Room as LiveRoom } from "livekit-client";
import type { ReactNode } from "react";

/*
 * Why a call ended, as the media server numbers it.
 *
 * Written out rather than imported from the protocol package, which is a
 * transitive dependency of the client rather than one this application declares
 * — importing from it would make the manifest wrong in the direction the
 * dependency test cannot see. The numbers are wire format and do not move; read
 * out of `@livekit/protocol`'s own generated enum, where PARTICIPANT_REMOVED is
 * 4 and ROOM_DELETED is 5.
 */
const DISCONNECT_REMOVED = 4;
const DISCONNECT_ROOM_CLOSED = 5;
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The room the address names, or nothing.
 *
 * Nothing rather than a generated name: a page that has not decided to be a
 * room yet must not put one in the address bar, which is what used to happen —
 * somebody signing in read their own URL and found a room they had not asked
 * for. Where a name is wanted for a bare address, doorway says so and it is
 * minted then.
 *
 * An invalid name is treated as no name at all. The hash is whatever somebody
 * pasted, and a room called "../../etc" is not a room this refuses politely; it
 * is a room this never had.
 */
function initialRoom(): string {
	const raw = normaliseRoomName(window.location.hash.replace(/^#\/?/, ""));

	return validRoomName(raw) ? raw : "";
}

/**
 * What the front of this deployment looks like before anybody is in a call.
 *
 * Four states and one question behind all of them: may whoever is looking start
 * a meeting? Where anybody may — which is what most deployments are and what
 * this one was — the answer is the old page, straight into a generated room,
 * because the fastest path to a meeting is to already be in it.
 *
 * Where they may not, that page puts a refusal at the end of choosing a camera
 * and typing a name. So the order inverts: say who you are, then say what you
 * want. And somebody who was sent a link is neither of those people — they have
 * no account and were not meant to need one — so an invite skips both and goes
 * to the room it names.
 */
type Front =
	| { at: "asking" }
	| { at: "open" }
	| { at: "sign in" }
	| { at: "lobby"; me: Me }
	| { at: "ready"; me: Me; relay: string }
	/**
	 * Holding a link. `invitation` is what the link says about the guest — the
	 * name they will wear and when it stops working — for the page to show.
	 */
	| { at: "invited"; room: string; invitation?: Invitation }
	/** Waiting on a meeting somebody arranged; `me` where the person is signed in. */
	| { at: "arranged"; token: string; me?: Me }
	| { at: "done" };

export function App() {
	const t = useT();
	const [room, setRoom] = useState(initialRoom);
	const [front, setFront] = useState<Front>({ at: "asking" });
	const [live, setLive] = useState<LiveRoom>();
	// What the machine holding the call is called, so it can be said in the words
	// the picker used rather than as an address.
	const [holding, setHolding] = useState<string>();

	// And the machine it is actually on, where the two came apart. Undefined for
	// most calls, which is what makes the panel say one name rather than two.
	const [carrying, setCarrying] = useState<string>();

	// The region of the machine the call came in through, which is the best
	// this page knows of where its viewer is: a mainland one skips YouTube for
	// the relay (see WatchScreen).
	const [entry, setEntry] = useState<string>();

	// Whether this page is older than the server, for as long as it is open.
	// See live/freshness.ts: a page kept open across a deployment went on running
	// the code from before it, rejoins included.
	useEffect(() => watchForNewerBuild(newerVersion), []);

	/*
	 * The step in front of the join screen that offers the app, while it is
	 * showing (live/landing.ts, routes/Landing.tsx).
	 *
	 * Beside the front door rather than one of its states. Where the link
	 * leads is decided exactly as it was, and the join screen it leads to is
	 * ready behind this from the start; the step only stands in front of it
	 * until somebody chooses the browser. As a state of its own it would have
	 * had to be threaded through every branch that reads one, the rejoins
	 * among them, and a branch that missed it would put the offer in front of
	 * somebody coming back into a call.
	 */
	const [door, setDoor] = useState<Omit<LandingProps, "onBrowser">>();

	/*
	 * Where this call is being moved to, while it is being moved.
	 *
	 * Undefined nearly always. Set when the server says a move is coming and
	 * cleared when the call is back, and what it buys is that the room stays on
	 * screen in between: a move ends the call and every tab comes straight back,
	 * and without this the room came down, the join screen appeared, and the
	 * call returned a few seconds later. That reads as having been thrown out
	 * and let back in, which is not what happened and is worse than what did.
	 *
	 * The empty string is a move whose destination the server did not name,
	 * which is still a move worth showing.
	 */
	const [moving, setMoving] = useState<string>();

	/*
	 * And a hard limit on how long that may be shown.
	 *
	 * The overlay is cleared when the call comes back and when the rejoin
	 * fails, which is every path there is — until one of them is added later
	 * and misses this, and what that produces is somebody sitting under "you
	 * will be back in a moment" for ever, with the controls they would use
	 * covered by the promise.
	 *
	 * Twenty seconds is well past a rejoin that is going to work: the whole
	 * thing takes two or three, and the flag driving it expires at fifteen.
	 */
	useEffect(() => {
		if (moving === undefined) return;

		const giveUp = setTimeout(() => setMoving(undefined), 20_000);

		return () => clearTimeout(giveUp);
	}, [moving]);

	// Worked out once, from two questions asked together.
	//
	// Together rather than one after the other, because the second is only
	// interesting if the first says the door is shut, and asking them in sequence
	// would put a visible pause in front of the common case where it is not.
	useEffect(() => {
		let live = true;

		const token = inviteToken();
		const meeting = meetingToken();

		// What the app step would offer, asked alongside the rest so that it
		// costs no wait of its own, and asked only where the step could be
		// shown at all: a link in the address, a device with an app, a tab
		// that has not been past it for this link, and somebody who did not
		// come here from this deployment's own pages.
		const link = opened();
		const device = platform();
		const offering = link && device && !passed(link.token) && !fromHere() ? offeredTo(link) : undefined;

		/*
		 * The step, where the link is the one the doorway below sent somebody
		 * in by and the device has something on offer. Asked once the doorway
		 * has decided rather than before, so that only a link going to the
		 * join screen as a first arrival is ever stood in front of: never a
		 * rejoin, never a link that was refused.
		 */
		const step = (kind: "invite" | "meeting", room: string, offered: Awaited<typeof offering>) => {
			if (!link || link.kind !== kind || !device || !offered || !offerFor(device, offered)) return;

			setDoor({ link, room, offered, device, ipad: ipad(), inApp: insideAnApp() });
		};

		void Promise.all([deployment(), whoAmI(), token ? invited(token) : undefined, offering]).then(
			([said, account, invitation, offered]) => {
				if (!live) return;

				// An invitation that is no good is still an invitation, which is
				// to say it is still somebody who was sent here on purpose and who
				// arrives to find the sign-in page of a deployment they have no
				// account on. They were not told why, so the reading available to
				// them is that the link was mistyped or that this is the wrong
				// site — neither of which is true, and both of which end with them
				// asking the person who sent it.
				//
				// Three sentences rather than one, because they are three
				// different next moves: one asks for another link, one says the
				// meeting is over and no link will help, and one says somebody
				// took this link back.
				// Two sentences rather than four. The other two were for refusals
				// the server does not make: one for an invitation used up, from
				// when a link admitted one person, and one for a meeting reported
				// as over, which it says a different way. Both were translated
				// into four languages and reachable by nobody.
				//
				// And a third, for a link opened before the time it was made for.
				// It is the right link at the wrong moment, and the one useful
				// thing to say is when to come back — in the reader's own clock,
				// since the person who made it may be somewhere else entirely.
				if (invitation?.error) {
					joinFailed(
						invitation.error === "invite_not_yet" && invitation.from
							? t("That invitation opens {when}. Come back then.", { when: whenSaid(invitation.from) })
							: invitation.error === "invite_expired"
								? t("That meeting has ended.")
								: t("That invitation is no longer good. Ask for another."),
					);
				}

				// Which screen, decided in one place and tested there. The order
				// between these conditions is the whole policy and it used to be
				// spelled out here, in an effect that also connects to rooms and
				// reads storage — which is why the branch that admits somebody
				// holding a room name on a deployment with settings was missing
				// for as long as it was.
				const landing = doorway({
					invitation: invitation?.room,
					address: initialRoom(),
					wasIn: wasIn(),
					account: Boolean(account),
					meeting: meeting || undefined,
					opening: said.openedBy,
				});

				if (landing.at === "invited") {
					setRoom(landing.room);
					setFront({
						at: "invited",
						room: landing.room,
						// Only where it is about this room. A tab that kept last
						// week's link and was sent somewhere else lands without it,
						// and a name meant for that room is not this one's.
						invitation: invitation?.room === landing.room ? invitation : undefined,
					});

					// Rejoining rather than arriving: this tab was in this room a
					// moment ago and the devices go back exactly as they were, so
					// nothing is turned on that was off.
					if (landing.rejoin) {
						onJoin({
							name: rememberedName(),
							passphrase: "",
							// Empty, and that is the honest answer.
							//
							// This is a reload: the tab that held the word is gone
							// and nothing wrote it down, which is the whole point of
							// keeping it in memory. A reload of a sealed call comes
							// back unsealed, hears nobody, and the person types the
							// word again — which is what should happen, and is
							// better than any of the ways of avoiding it.
							secret: "",
							relay: chosenRelay(),
							...rememberedDevices(),
						}).catch(unattended);
					} else {
						step("invite", landing.room, offered);
					}

					return;
				}

				// The account is tested again rather than asserted. doorway only
				// says "ready" where it was given one, so this is a narrowing the
				// compiler needs and not a case that happens — but written as a
				// cast it would be a claim about the other file that nothing here
				// would notice going stale, and the fall-through is the sign-in,
				// which is the right place to be wrong.
				if (landing.at === "ready" && account) {
					setFront({ at: "ready", me: account, relay: chosenRelay() });

					onJoin({
						name: account.name,
						passphrase: "",
						// See above: a reload cannot recover a word nothing stored.
						secret: "",
						relay: chosenRelay(),
						...rememberedDevices(),
					}).catch(unattended);

					return;
				}

				if (landing.at === "arranged") {
					// Kept for the tab and taken out of the address bar, for the
					// reason ?invite= is: it is a day's entry once the meeting
					// begins, and people share their screens.
					keepMeeting(landing.token);
					setFront({ at: "arranged", token: landing.token, me: account ?? undefined });
					step("meeting", initialRoom(), offered);
					return;
				}

				if (landing.at === "open") {
					// Minted here rather than on load, which is what used to put a
					// generated name in the address bar of a page that had not
					// decided to be a room yet — somebody signing in read their own
					// URL and found a room they had not asked for.
					if ("mint" in landing) setRoom((held) => held || generateRoomName());

					setFront({ at: "open" });
					return;
				}

				setFront(landing.at === "lobby" && account ? { at: "lobby", me: account } : { at: "sign in" });
			},
		);

		return () => {
			live = false;
		};
	}, []);

	// Held in a ref as well so the unmount cleanup can reach it without making
	// the effect depend on it, which would disconnect on every render.
	const current = useRef<LiveRoom>();

	useEffect(
		() => () => {
			void current.current?.disconnect();
			current.current = undefined;
		},
		[],
	);

	// The address follows the room, so the link somebody copies is the room they
	// are looking at, and the back button moves between rooms rather than
	// between edits to a name.
	useEffect(() => {
		if (!room) return;

		if (window.location.hash !== `#/${room}`) {
			window.history.replaceState(null, "", `#/${room}`);
		}
	}, [room]);

	// Someone else may have changed it: a pasted link, or the back button.
	useEffect(() => {
		const onHashChange = () => {
			const raw = normaliseRoomName(window.location.hash.replace(/^#\/?/, ""));
			if (validRoomName(raw)) setRoom(raw);
		};

		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	/*
	 * The passphrase, for as long as this tab is in this call.
	 *
	 * Not stored. This is a ref, so it lives in the tab's memory, dies when the
	 * tab does, and never reaches local storage — which is the rule, and the rule
	 * is about storage: the browser's own password manager is where a passphrase
	 * belongs, because it is encrypted, behind the machine's lock, and deletable
	 * by its owner.
	 *
	 * It is here because a rejoin is not a new join. When a room is moved to
	 * another machine, or somebody is placed on one, the call ends and this tab
	 * comes straight back — and it used to come back with an empty passphrase,
	 * which mints a mark drawn from nothing. So the host of a meeting who moved
	 * their own meeting arrived on the new machine as somebody else, with the
	 * room still answering to the mark they no longer had. Every control they
	 * had a moment ago answered 403, and the only way back was to leave and join
	 * again with the passphrase they had typed two minutes earlier.
	 */
	const said = useRef("");

	// And the sealing word, for the same reason and with the same rule: memory
	// only, gone with the tab. A room that comes back unsealed after being moved
	// is a room whose participants can no longer hear each other, which reads as
	// the call being broken rather than as a key having been dropped.
	const sealed = useRef("");

	const onJoin = useCallback(
		async ({ name, passphrase, secret, camera, microphone, relay }: Choices) => {
			said.current = passphrase;
			sealed.current = secret;

			const made = create(secret);

			try {
				const grant = await requestJoin(room, name, passphrase, relay, inviteToken());
				// Kept so the call can say where it is being held, in the words
				// the picker used rather than as an address.
				setHolding(grant.relay);
				setCarrying(grant.holding);
				setEntry(grant.region);
				await connect(made, grant, secret);

				// The microphone, camera and speakers last picked in a call, where
				// they are still there. Before either is started, so that the first
				// track is the right device rather than the default for a moment and
				// then a switch. It cannot fail the join: anything it cannot do
				// leaves the browser's default, which is where everybody was before
				// the choice was remembered at all.
				await restoreDevices(made);

				// After connecting rather than before, so somebody appears in the
				// room the moment they join and their devices come up a beat
				// later, instead of the room waiting on a camera that may never
				// be granted.
				//
				// Each on its own, and never through the catch below. They used
				// to sit in the same try as the connection, so a device that
				// failed failed the join: a refused microphone, or a camera held
				// by another tab's call, disconnected somebody who was already in
				// and told them the room would not open. A device is one person's
				// problem with their own machine; it is said as one, and the call
				// goes on with that button off.
				await made.localParticipant
					.setMicrophoneEnabled(microphone)
					.catch((err: unknown) => deviceFailed("microphone", err));
				await made.localParticipant
					.setCameraEnabled(camera)
					.catch((err: unknown) => deviceFailed("camera", err));

				// A shared screen is asked for at the size it covers here, like a
				// face, and paused where nobody can see it (see `create`). What is
				// added for a share is the pixels a pinch or a denser display gives
				// it, which the measurement does not see by itself (live/lens.ts);
				// one viewer's way out of a freeze the server does not notice — a
				// rung lower for a while, never anything the person sharing sends;
				// see live/freeze.ts — and a fifth of a second's cushion under the
				// share's picture and sound, never anybody's face or voice; see
				// live/delay.ts.
				const unmagnify = magnifyShares(made);
				made.once(RoomEvent.Disconnected, unmagnify);
				const thaw = watchShareFreezes(made);
				made.once(RoomEvent.Disconnected, thaw);
				const cushion = cushionShares(made);
				made.once(RoomEvent.Disconnected, cushion);

				current.current = made;
				setLive(made);

				// The meeting link has done its work: the invitation it produced is
				// kept for the tab and is the shorter way back in. Left in place, a
				// reload during the call would land on the waiting screen again and
				// ask the host to start what they are in.
				forgetMeeting();

				// Back. Whatever this was, it is over.
				setMoving(undefined);

				// A handle for the browser scripts in dev/twobrowsers, which check
				// things no unit test can reach: whether frames are actually
				// encrypted, what the media server thinks is in the room. Only in
				// a development build — a page that hands its room object to
				// anything on the page is a page where an extension can end the
				// call.
				if (import.meta.env.DEV) {
					(window as unknown as { __room?: LiveRoom }).__room = made;
				}
			} catch (err) {
				void made.disconnect();

				// The overlay goes with it. A move that failed leaves somebody
				// on the screen they can act from; leaving "you will be back in
				// a moment" over it would be a promise this just broke, drawn
				// over the button that is the way out of it.
				setMoving(undefined);

				joinFailed(err instanceof Error ? err.message : String(err));

				// And thrown on, which it was not.
				//
				// Saying it is not the same as answering it. The pre-join screen
				// turns one refusal — a room that asks for an invitation — into
				// an offer to knock on the door, and it can only do that if the
				// rejection reaches the button somebody pressed. It never did:
				// this caught it, said it, and returned normally, so the screen
				// saw a join that had worked and left nothing to press. The
				// waiting room was written, wired and dead on arrival for a week
				// before two browsers found it.
				//
				// The message stays here because every caller wants it said and
				// none of them should have to. Only the answering moves out.
				throw err;
			}
		},
		[room],
	);

	/**
	 * A join the page started by itself, where nobody is waiting on an answer.
	 *
	 * Three of them: coming back after a reload, an account walking into its own
	 * lobby, and the far side of a move. onJoin reports its own failures and
	 * then rethrows for whoever pressed something; these three pressed nothing,
	 * so the rejection is discarded here rather than left to surface as a red
	 * line in a console.
	 */
	const unattended = useCallback(() => {}, []);

	const onLeave = useCallback(() => {
		void current.current?.disconnect();
		current.current = undefined;
		setLive(undefined);

		// Forgotten, or leaving and then reloading would be rejoining — which is
		// the one case where walking somebody back into a call is exactly wrong.
		leftRoom();

		// A guest has nowhere to be sent back to.
		//
		// Everybody else came from a lobby or from a page they can use again, and
		// returning them there is right. Somebody who arrived on a link has no
		// account, and the screens behind this one are a sign-in they cannot
		// satisfy and a room they were not invited to twice — offering either is
		// offering a door that does not open. So the call ends and the page says
		// so, and there is nothing else on it, because there is nothing else they
		// can usefully do here.
		setFront((was) => {
			if (was.at === "invited") return { at: "done" };
			if (was.at === "arranged") {
				forgetMeeting();
				window.history.replaceState(null, "", window.location.pathname);
				return was.me ? { at: "lobby", me: was.me } : { at: "done" };
			}

			// And back to the lobby rather than to the device screen, which is a
			// page for a room they have just left. The address goes with them,
			// or the next reload would land on that same page again.
			if (was.at === "ready") {
				window.history.replaceState(null, "", window.location.pathname);
				return { at: "lobby", me: was.me };
			}

			return was;
		});
	}, []);

	// Why the call ended, when it did not end because somebody pressed leave.
	//
	// Three endings, and they are not the same thing: a room that was closed
	// ended for everybody, being removed happened to them alone, and a
	// connection that failed happened to nobody on purpose. Each one ends the
	// call — a room somebody cannot reach is not a room they are in — and each
	// one says which it was, because from the outside all three are a call that
	// simply stopped, and the reading somebody lands on then is that it broke.
	useEffect(() => {
		if (!live) return;

		/*
		 * A room being moved, said before it happens.
		 *
		 * The media server disconnects everybody the same way whether a meeting
		 * is over or is being put up on another machine, and the two want
		 * opposite answers. So the server says which, and this remembers it for
		 * the two seconds between the message and the disconnection.
		 *
		 * A ref rather than state, because the disconnection handler reads it
		 * and a re-render between the warning and the disconnection would be a
		 * chance for the two to disagree. What is on screen is driven by
		 * `carrying` below, which is set from this.
		 */
		const moving = { soon: false, at: 0 };

		/*
		 * Only from the server, and only for as long as it takes.
		 *
		 * Every participant may publish data — they have to, since this is how
		 * the watching list and the chat travel — and this listener used to
		 * ignore who sent what. So anybody in the room could send one empty
		 * message on this topic and every other tab would quietly arm itself to
		 * rejoin. Nothing visible happened at the time. It happened later, when
		 * the host legitimately ended the meeting: instead of being told so,
		 * everybody's client read the closure as a move and put the room back up
		 * on the same machine, with the notice swallowed on the way past.
		 *
		 * The sender settles it. The media server stamps every client packet
		 * with the identity it authenticated, and the client library resolves
		 * that identity against the people in the room, so a packet from a
		 * participant always arrives with one attached. The room service sends
		 * as nobody — there is no participant called "tomoshibi" — and that is
		 * the only way to arrive with none.
		 *
		 * The deadline covers the one case the sender cannot: a participant who
		 * leaves in the instant between the media server forwarding their packet
		 * and this running has no entry left to resolve to, and would look like
		 * the server. A move follows its warning within about two seconds, so a
		 * warning older than this is not the one being acted on.
		 */
		const MOVING_HOLDS_FOR = 15_000;

		// Two topics and one meaning: this call is about to end and coming back
		// is the right thing to do. "moving" is the whole room being put on
		// another machine; "placing" is one person being put on another machine,
		// and is addressed to them rather than said to the room, so a tab that
		// receives it is a tab it is about.
		//
		// They end differently, which is why both are needed. A room being moved
		// is closed, so everybody in it gets ROOM_CLOSED. One person being placed
		// is let go of, so they get REMOVED — the same code a host throwing
		// somebody out produces, and before this the only thing that person was
		// told was that they had been removed from the room. An operator putting
		// somebody on a healthier relay sent them an ejection notice and a dead
		// call.
		const told = (payload: Uint8Array, who: unknown, _kind: unknown, topic?: string) => {
			if (who !== undefined) return;
			if (topic !== "moving" && topic !== "placing") return;

			moving.soon = true;
			moving.at = Date.now();

			// And on screen, before the disconnection rather than after it.
			//
			// The rejoin has always worked; what it looked like was being thrown
			// out. The room came down, the join screen appeared, and a moment
			// later the call came back — which reads as having been removed and
			// then somehow let back in, and is the reason somebody watching it
			// would say the meeting ended.
			//
			// The payload is where it is going, which the server has always sent
			// and this used to discard. Somebody told "moving to Tokyo" has been
			// told what happened; somebody shown a blank join screen has been
			// told nothing.
			const where = new TextDecoder().decode(payload).trim();
			setMoving(where || " ");
		};

		live.on(RoomEvent.DataReceived, told);

		const ended = (reason?: number) => {
			// Moved rather than ended: straight back in, to the machine the room
			// has been put on. The address still names the room and this tab is
			// still the tab that was in it, so the ordinary rejoin does the rest.
			if (
				moving.soon &&
				Date.now() - moving.at < MOVING_HOLDS_FOR &&
				(reason === DISCONNECT_ROOM_CLOSED || reason === DISCONNECT_REMOVED)
			) {
				// The room object is dead and cannot be left in place — every
				// hook attached to it would go on asking a disconnected client
				// for a roster. What stays is the overlay, which is drawn above
				// whatever the room resolves to while the new one is built.
				setLive(undefined);
				current.current = undefined;

				onJoin({
					name: front.at === "lobby" || front.at === "ready" ? front.me.name : rememberedName(),
					// Carried, so somebody comes back as who they were rather than
					// as a stranger with their name.
					passphrase: said.current,
					secret: sealed.current,
					relay: "",
					...rememberedDevices(),
				}).catch(unattended);

				return;
			}

			// The room is gone for this person either way, so the call goes with
			// it. Saying so and leaving them sitting in it was the old behaviour
			// and it read as the notice being wrong: the tiles were still there,
			// the controls still worked, and nothing they pressed did anything.
			if (reason === DISCONNECT_ROOM_CLOSED) {
				joinFailed(t("The host closed this room."));
				onLeave();
				return;
			}

			if (reason === DISCONNECT_REMOVED) {
				joinFailed(t("You were removed from this room."));
				onLeave();
				return;
			}

			// Anything else is the connection failing, and by the time this fires
			// the client has already retried and given up — RoomEvent.Disconnected
			// is the end of that, not the start.
			//
			// The call ends, but this is not a departure. onLeave is not called,
			// because it forgets the room, and forgetting it here would mean a
			// reload after a drop landed on the front page rather than walking
			// back in. Front is left where it was too, which puts them on the
			// device screen for the room they were just in, with its Join button:
			// one press back, devices already chosen, and nothing automatic that
			// could loop against a relay that is genuinely down.
			//
			// Before this, a drop left the room on screen with a pill in the
			// corner reading "Connecting…" forever. On a deployment where the
			// path to the media server is the thing most likely to fail, that was
			// the most common ending a call had, and it was the one that looked
			// like the software was broken.
			// And the measurement goes, so that the one press back is not a press
			// back onto the same machine.
			//
			// The reading is held for five minutes, which is right while things
			// are working and exactly wrong here: a relay that has just dropped a
			// call is the one thing this now knows about the fleet, and without
			// this it would go on naming that relay as the fastest for another
			// five minutes. A relay filtered off the network — the failure this
			// deployment exists to survive — answers nothing, so a fresh
			// measurement picks somebody else. Keeping the stale one turned a
			// single drop into a loop that looked like the software refusing to
			// work, with the way out being a picker most people never open.
			//
			// Only the measurement. A machine somebody chose by hand stays chosen:
			// they asked for it, the picker still says so, and quietly moving them
			// off it would be answering a question they did not ask.
			forgetTimings();

			joinFailed(t("The connection to this room was lost."));
			void current.current?.disconnect();
			current.current = undefined;
			setLive(undefined);
		};

		live.on(RoomEvent.Disconnected, ended);

		return () => {
			live.off(RoomEvent.Disconnected, ended);
			live.off(RoomEvent.DataReceived, told);
		};
	}, [live, t, onLeave, onJoin, front]);


	/*
	 * Every screen arrives, and none of them simply appears.
	 *
	 * Sign-in to lobby to devices to call is four steps, each one a decision
	 * somebody has just made, and a screen replaced between two frames reads as
	 * the page having reloaded rather than as having moved. Keyed on which screen
	 * it is, so React discards the old tree and mounts the new one — without the
	 * key it reuses the node, the animation never restarts, and every step after
	 * the first is exactly as bare as it was before.
	 */
	/*
	 * Every screen goes through here, which is why the move overlay does too.
	 *
	 * A move takes the room down and puts it back, and in between the page
	 * underneath is whatever the front door resolves to — the device screen,
	 * usually. Drawing the overlay per screen would mean remembering it at each
	 * of them and would still leave the gap between two of them uncovered.
	 * Drawn here, it is above all of them and above the gap.
	 */
	const page = (at: string, screen: ReactNode) => (
		<>
			<div key={at} className="animate-page h-full">
				{screen}
			</div>

			<Moving to={moving} />
		</>
	);

	if (live) {
		return page("call", <Room room={live} relay={holding} carrying={carrying} entry={entry} onLeave={onLeave} />);
	}

	// Nothing rather than a spinner. The two requests behind this take one round
	// trip on a warm connection, and a spinner shown for that long is a flash
	// somebody notices without being able to read.
	if (front.at === "asking") return <div className="min-h-full bg-bg" />;

	// The app offered, in front of the join screen it leads to, and only in
	// front of a first arrival on a link: after the call above, so never over
	// one. Choosing the browser is remembered for the tab, so a reload of the
	// join screen with the invitation still in the address is not offered the
	// app again.
	if (door && (front.at === "invited" || front.at === "arranged")) {
		return page(
			"landing",
			<Landing
				{...door}
				onBrowser={() => {
					pass(door.link.token);
					setDoor(undefined);
				}}
			/>,
		);
	}

	if (front.at === "done") {
		return page(
			"done",
			<main className="grid min-h-full place-items-center bg-bg p-6">
				<p className="animate-rise text-fg-muted text-sm">{t("You have left the room.")}</p>
			</main>,
		);
	}

	if (front.at === "sign in") {
		return page(
			"sign in",
			<SignIn onSignedIn={(account) => setFront({ at: "lobby", me: account })} />,
		);
	}

	if (front.at === "lobby") {
		return page(
			"lobby",
			<Lobby
				me={front.me}
				onOpen={(wanted, relay) => {
					setRoom(wanted);
					rememberRelay(relay);
					setFront({ at: "ready", me: front.me, relay });
				}}
				onSignedOut={() => setFront({ at: "sign in" })}
			/>,
		);
	}

	return page(
		"devices",
		<PreJoin
			room={room}
			onRoomChange={setRoom}
			onJoin={onJoin}
			// Somebody who arrived on a link has no passphrase and was not meant
			// to need one. Showing the field would be showing them a question
			// they cannot answer, next to a name they did choose.
			guest={front.at === "invited"}
			invitation={front.at === "invited" ? front.invitation : undefined}
			arranged={front.at === "arranged" ? { token: front.token } : undefined}
			as={
				front.at === "ready"
					? { name: front.me.name, relay: front.relay }
					: // Somebody signed in on a meeting link — its host, or anybody
						// else with an account — joins as themselves. The room is held
						// where it was arranged whatever is sent, but the machine they
						// dial is the one they choose and the call is forwarded from it
						// to the one holding the meeting, so the picker is offered all
						// the same (PreJoin, `picks`), starting from the one this tab
						// last chose.
						front.at === "arranged" && front.me
						? { name: front.me.name, relay: chosenRelay() }
						: undefined
			}
			onBack={(() => {
				// Somebody with a lobby to go back to: signed in, whether they came
				// through it or straight to their own meeting link.
				const me = front.at === "ready" || front.at === "arranged" ? front.me : undefined;
				if (!me) return undefined;
			
				return () => {
					forgetMeeting();
					window.history.replaceState(null, "", window.location.pathname);
					setFront({ at: "lobby", me });
				};
			})()}
		/>,
	);
}
