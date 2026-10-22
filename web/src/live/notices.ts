import type { Participant, Room } from "livekit-client";
import { RoomEvent, Track } from "livekit-client";
import { toast } from "sonner";
import { t } from "./i18n";
import { soundOnly } from "./sound";

/**
 * What is worth interrupting somebody for.
 *
 * Most of what happens in a call is not. A button somebody pressed does not
 * need to be reported back to the person who pressed it; a copied link answers
 * on the button itself; a connection that is down is a standing condition and
 * belongs in the banner over the stage, not in something that fades. What is
 * left is other people arriving and leaving, somebody else taking the stage
 * with a share, and the two failures a person can actually act on.
 *
 * One rule decides two things at once, and they are the same thing. A notice
 * about something that is over fades, and carries no way to close it: a target
 * that lives two seconds is one nobody hits, and pressing it would save nobody
 * anything. A notice about something still true does not leave on its own — so
 * it has to be possible to decide not to deal with it, which is the close
 * button, and it belongs to exactly those.
 */

/** How long an ordinary notice stays. Long enough to read four words. */
const BRIEFLY = 2200;

/** A share is longer, because the picture is about to change under you. */
const A_MOMENT = 3000;

/**
 * The longest any notice stays.
 *
 * Some of these used to stay for good, on the reasoning that something still
 * true is not an event: a refused camera is a state, and a state that fades
 * leaves somebody looking at a working-looking page with no camera in it.
 *
 * The reasoning was sound and the result was not. A notice that never leaves
 * sits in the corner through a whole meeting, over the pictures, long after the
 * person read it and either dealt with it or decided not to — and by the third
 * one nobody reads any of them. Ten seconds has been seen; forever has been
 * ignored. The ones worth acting on keep their close button so they can go
 * sooner.
 *
 * Two are not held to it, and both are taken down by their caller the moment
 * they stop being true rather than left to the clock: somebody waiting at the
 * door, and sound the browser is holding back. Neither can sit through a meeting
 * unread, because each ends with the thing it asks for.
 */
const AT_MOST = 10_000;


/**
 * Watch a room and report the handful of things worth reporting.
 *
 * Returns a function that stops watching. Nothing is queued: a notice missed
 * because the tab was hidden is a notice about something that already happened.
 */
export function watch(room: Room): () => void {
	const named = (participant: Participant) => participant.name || participant.identity;

	const onJoin = (participant: Participant) => {
		raised(toast(t("{name} joined", { name: named(participant) }), { duration: BRIEFLY, ...followed }));
	};

	const onLeave = (participant: Participant) => {
		raised(toast(t("{name} left", { name: named(participant) }), { duration: BRIEFLY, ...followed }));
	};

	const onPublished = (publication: { source: Track.Source; trackName: string }, participant: Participant) => {
		// Sound shared on its own has no picture to announce it, so it is said:
		// otherwise music simply starts, from nowhere anybody can see.
		const sound = soundOnly(publication);
		if (publication.source !== Track.Source.ScreenShare && !sound) return;
		raised(
			toast(
				sound
					? t("{name} is sharing sound", { name: named(participant) })
					: t("{name} started sharing", { name: named(participant) }),
				{ duration: A_MOMENT, className: "is-signal", ...followed },
			),
		);
	};

	room.on(RoomEvent.ParticipantConnected, onJoin);
	room.on(RoomEvent.ParticipantDisconnected, onLeave);
	room.on(RoomEvent.TrackPublished, onPublished);

	return () => {
		room.off(RoomEvent.ParticipantConnected, onJoin);
		room.off(RoomEvent.ParticipantDisconnected, onLeave);
		room.off(RoomEvent.TrackPublished, onPublished);
	};
}

/**
 * A device that would not start.
 *
 * Given no duration, so it stays: unlike everything else here it is a thing
 * somebody has to go and fix, and it tells them where.
 *
 * Two causes, told apart because they have different remedies. A refusal is
 * undone from the address bar. Anything else -- the camera held by another
 * application, which is what a video call already open in another tab looks
 * like, or no device there at all -- is not, and pointing somebody at a
 * permission they have already granted sends them looking in the one place the
 * fault is not. That second case used to say nothing whatsoever: the button
 * stayed off and the reason went to the console.
 */
export function deviceFailed(kind: "camera" | "microphone", err: unknown): void {
	const refused = err instanceof DOMException && err.name === "NotAllowedError";

	// Two whole phrases rather than one with the device substituted in. A
	// sentence built around a noun has to agree with it in most languages, and
	// the one place that would break is the one nobody tests: the error.
	raised(
		toast.error(kind === "camera" ? t("Can't use your camera") : t("Can't use your microphone"), {
			description: refused
				? t("Allow access from the icon in the address bar.")
				: t("Something else may be using it."),
			duration: AT_MOST,
			closeButton: true,
			...followed,
		}),
	);
}

/**
 * A newer version of the page is available.
 *
 * Said rather than done: in a call, reloading is leaving it. The button is the
 * reload, for whoever wants it now; anybody else gets the new page the next time
 * they open the link.
 */
export function newerVersion(): void {
	raised(
		toast(t("A new version is ready"), {
			description: t("Refresh to use it."),
			duration: AT_MOST,
			closeButton: true,
			action: { label: t("Refresh"), onClick: () => window.location.reload() },
			...followed,
		}),
	);
}

/**
 * A sound share that came back with no sound.
 *
 * The picker was answered, so nothing failed as far as the browser is concerned;
 * whether a window's sound can be shared depends on the browser, its version and
 * the system, and the checkbox that shares it is easy to leave unticked. Said,
 * with the choice that always works, rather than left as music nobody hears.
 */
export function noSoundShared(): void {
	raised(
		toast.error(t("No sound was shared"), {
			description: t("Tick the sound option in the picker, or pick the browser tab that is playing."),
			duration: AT_MOST,
			closeButton: true,
			...followed,
		}),
	);
}

/**
 * The lossless stream of shared sound was given up on.
 *
 * Said to the person sharing, because it is their upload that could not keep
 * up and they are the one who might do something about it. Everybody listening
 * goes on hearing the sound, in real time, with nothing for them to do; the
 * share itself carries on.
 */
export function losslessGaveUp(): void {
	raised(
		toast(t("Lossless sound stopped"), {
			description: t("Your connection could not keep up. Everyone still hears the sound in real time."),
			duration: AT_MOST,
			closeButton: true,
			...followed,
		}),
	);
}

/**
 * A room that would not open.
 *
 * The one failure between deciding to join and being in a call, and it used to
 * be shown by a red bar the page kept for itself — because the notices lived
 * inside the room, and this happens before there is one. They live at the root
 * now, so this can be said the same way as everything else.
 *
 * Given no duration, like a refused device: it is a thing somebody has to act
 * on, and a message about why they are not in the meeting should not disappear
 * while they are reading it.
 */
export function joinFailed(reason: string): void {
	raised(toast.error(reason, { duration: AT_MOST, closeButton: true, ...followed }));
}

/**
 * Something somebody just pressed, which did not take.
 *
 * The management pages raise these, and they are the reason the notices moved
 * to the root: those pages had grown a third way of saying it, on top of the
 * client's toasts and the red bar its first screen kept for itself.
 *
 * It fades, unlike the two above, and the difference is the whole rule. A
 * refused device and a room that would not open are things somebody has to go
 * and do something about. A press that did not take is over: the room is still
 * there, the panel still works, and pressing again is the whole of the remedy.
 *
 * The words come from the caller because the server already sent a reason and
 * the client already turned it into a sentence. Rewriting it here would be a
 * second place for the same message to drift.
 */
export function actionFailed(reason: string): void {
	raised(toast.error(reason, { duration: AT_MOST, ...followed }));
}

/**
 * Something that worked, where working is not visible on its own.
 *
 * Most actions here show their own result: a muted track goes quiet, a removed
 * participant disappears. A few do not, and stopping the invitations is the one
 * that matters — the panel looks the same afterwards whether three links stopped
 * working or none did, and the reason to press it is not being sure which.
 *
 * Fades, like everything else about something that has already happened. A
 * notice that stays is for a condition somebody has to act on.
 */
export function actionDone(said: string): void {
	raised(toast.success(said, { duration: AT_MOST, ...followed }));
}

/**
 * Sound the browser refused to start on its own.
 *
 * Something still true, and the one notice that is held to that rather than to
 * the ten seconds: it stays until sound plays, and the caller takes it down
 * then. It was held to the limit for a while, and it went while the call was
 * still silent — somebody moved to another relay heard nobody, saw a corner of
 * the screen say so for ten seconds, and was then left with silence and no
 * sentence at all. The limit exists so that a notice nobody needs does not sit
 * through a meeting, and this one cannot: any press anywhere on the page, its
 * own button and its close among them, starts the sound and takes it down (see
 * live/speakers.ts). Like somebody at the door, it is undismissable only in the
 * sense that the fact is.
 *
 * And kept in sight. Three notices are drawn at once and a fourth pushes the
 * oldest out of view, which was this one, raised when the call came back and
 * therefore before everything said after; see `raised`.
 */
export function audioBlocked(resume: () => void): () => void {
	const show = () =>
		toast(t("You can't hear anyone yet"), {
			description: t("Your browser needs one click first."),
			duration: Number.POSITIVE_INFINITY,
			closeButton: true,
			action: { label: t("Turn on sound"), onClick: resume },
		});

	const mine = { id: show(), show, ahead: new Set<string | number>() };
	standing = mine;

	return () => {
		toast.dismiss(mine.id);
		if (standing === mine) standing = undefined;
	};
}

/** How many notices are drawn at once; Notices.tsx gives the library this. */
export const VISIBLE = 3;

/**
 * The notice that sound is held back, while it is up, and the notices raised
 * since that are still on screen in front of it.
 */
let standing: { id: string | number; show: () => string | number; ahead: Set<string | number> } | undefined;

/**
 * A notice has gone up: if that puts the standing one out of view, bring it
 * back to the front.
 *
 * Only then, and not at every notice. Raising it again is a departure and an
 * arrival, and doing that whenever somebody joined would make the one notice
 * that matters the one that will not keep still.
 */
function raised(id: string | number): void {
	if (!standing || id === standing.id) return;

	standing.ahead.add(id);
	if (standing.ahead.size < VISIBLE) return;

	toast.dismiss(standing.id);
	standing.id = standing.show();
	standing.ahead.clear();
}

/** A notice that has gone, which no longer stands in front of anything. */
function gone(shown: { id: string | number }): void {
	standing?.ahead.delete(shown.id);
}

/** What every notice but the standing one is raised with, so its going is known. */
const followed = { onDismiss: gone, onAutoClose: gone };

/**
 * Somebody is waiting to be let in.
 *
 * This exists because the panel did not reach anybody. Who is at the door was
 * drawn inside the crown, which is a panel the host opens when they already
 * suspect something — so the first time this was tried end to end, a stranger
 * knocked, waited the full two and a half minutes and gave up, while the host
 * sat in the call with no indication that anything had happened at all. A
 * waiting room nobody is told about is a locked door.
 *
 * No duration, because it is still true. Somebody is outside until they are
 * answered or they leave, and a notice that fades after four seconds is one the
 * host misses by looking at a face. Dismissed by the caller the moment the door
 * is empty, which is what makes an undismissable notice bearable.
 *
 * The action opens the panel rather than admitting anybody. Letting somebody in
 * is a decision, and one made from a toast is one made without reading the name
 * or where they came from.
 */
export function atTheDoor(waiting: number, open: () => void): () => void {
	const id = toast(
		waiting === 1
			? t("Somebody is waiting to be let in")
			: t("{count} people are waiting to be let in", { count: String(waiting) }),
		{ duration: Number.POSITIVE_INFINITY, action: { label: t("Answer"), onClick: open }, ...followed },
	);
	raised(id);

	return () => toast.dismiss(id);
}
