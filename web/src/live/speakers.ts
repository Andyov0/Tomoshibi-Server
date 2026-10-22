import { type RemoteTrack, type Room, RoomEvent, Track } from "livekit-client";

/**
 * The page's speakers: a handful of audio elements kept for as long as the page
 * is open, and the permission to play them carried from the press that gave it
 * to every call that comes after.
 *
 * A browser will not start sound nobody asked for, and what counts as asking is
 * decided per browser. Chrome by default asks it of the document: one press
 * anywhere and every element on the page may play for as long as the page
 * stays, and a page capturing a microphone may play with no press at all.
 * Measured on a computer and on Android, a person placed on another relay heard
 * everybody after coming back, and so did one who reloaded with their
 * microphone on; one who reloaded with it off heard nobody, and a press on the
 * stage did not change that — only the notice's own button would. Other rules
 * ask it of the element: an element plays with sound only
 * once play() has been called on it during a press, and one made afterwards
 * starts out refused however many presses came before. That is Chrome's
 * user-gesture-required policy, measured here, and by their own documentation
 * Safari on an iPhone and Android's WebView.
 *
 * Each call used to make its own. The renderer was the media library's, which
 * creates an element per track per room, so a call that came back by itself --
 * one person placed on another relay, a whole room moved, a reload that walked
 * straight back in -- came back with elements nobody had pressed anything for.
 * Under the per-element rule the person placed heard nobody while everybody
 * heard them, which was measured in Chrome on Android exactly so, and the only
 * sign was a notice in a corner that left after ten seconds. The person who had
 * stayed fared no better with somebody new: their element for the newcomer was
 * just as new, and was refused just the same.
 *
 * So the elements outlive the call. They are made and played once during a
 * press -- the press on Join is the first -- and handed out to every room after
 * that, and a room gives each back when its track goes. More are made and played
 * at every later press, so there are always some to spare. Where none are left,
 * a fresh one is made and may be refused, and the next press anywhere on the page
 * starts it; the notice that says so stays until something plays.
 *
 * What is not done, and why. The library can mix every remote track through one
 * audio context instead (`webAudioMix`), which would need one unlocking and no
 * elements at all, but remote WebRTC audio sent through Web Audio is taken out of
 * reach of Chrome's echo cancelling, so everybody else in the call would hear
 * themselves come back from this person's speakers. And nothing here can start
 * sound on a page that has had no press at all, because no browser allows that;
 * what it does is make the first press count wherever it lands.
 */

/** Idle elements kept unlocked and ready, beyond the ones in use. */
export const SPARE = 8;

/** Every element made, in use or not, so a press can start the ones that were refused. */
const every = new Set<HTMLAudioElement>();
/** The ones no room holds now, in the order they came back. */
const idle: HTMLAudioElement[] = [];
/** Played during a press without being refused: what may be handed out to play at once. */
const unlocked = new WeakSet<HTMLAudioElement>();
/** Which try at unlocking an element is the latest, so an older answer arriving late does not overrule it. */
const attempts = new WeakMap<HTMLAudioElement, number>();

/*
 * Kept in the document, under one hidden holder of their own.
 *
 * In it rather than loose, for a reason in the library: a track detached from an
 * element pauses it and keeps it in a module-level list of its own, and the
 * library's attach() with no element takes the first one from that list that has
 * no parent. A loose element of this pool could be handed to some other track by
 * the library without this file knowing. One with a parent never is. The cost is
 * that the library's list keeps a reference to one of these at every detach: a
 * pointer per track that ever left, to elements that exist anyway.
 */
let holder: HTMLElement | undefined;

function make(): HTMLAudioElement {
	if (!holder || !holder.isConnected) {
		holder = document.createElement("div");
		holder.hidden = true;
		holder.setAttribute("aria-hidden", "true");
		holder.dataset.speakers = "";
		document.body.append(holder);
	}

	const element = document.createElement("audio");
	holder.append(element);
	every.add(element);
	return element;
}

/**
 * Play an element once, now, so the browser marks it as allowed.
 *
 * Sourceless is enough: both engines decide at the call to play() whether a
 * press is behind it and lift the element's restriction there and then,
 * whatever it is going to play. An idle one is paused again straight away, which
 * leaves it allowed and silent, and its play() then answers AbortError, which is
 * not a refusal. A refusal is NotAllowedError and nothing else.
 */
function tryUnlock(element: HTMLAudioElement, idleAfter: boolean): void {
	const attempt = (attempts.get(element) ?? 0) + 1;
	attempts.set(element, attempt);

	let playing: Promise<void> | undefined;
	try {
		playing = element.play();
	} catch {
		return;
	}

	if (idleAfter) element.pause();

	// Taken as allowed until the browser says otherwise, so that the spares
	// made in this press count at once rather than a frame later.
	unlocked.add(element);

	playing?.catch((err: unknown) => {
		if (attempts.get(element) !== attempt) return;
		if (err instanceof DOMException && err.name === "NotAllowedError") unlocked.delete(element);
	});
}

/** An element for one track: an allowed one where there is one, otherwise a new one that may be refused. */
export function take(): HTMLAudioElement {
	const ready = idle.findIndex((element) => unlocked.has(element));
	if (ready >= 0) return idle.splice(ready, 1)[0] as HTMLAudioElement;

	return idle.shift() ?? make();
}

/**
 * An element a room has finished with, put back the way a new one starts.
 *
 * Its volume especially. The library applies a track's volume to an element it
 * is attached to only where that volume is not nought, so an element coming
 * back from somebody turned down to a fifth would otherwise play the next
 * person at a fifth; see `sound` for the other half of that.
 *
 * And its output, where it was sent to one: a track only sets an output where
 * one was chosen, so an element that had been sent to headphones that have since
 * gone would go on asking for them.
 */
export function giveBack(element: HTMLAudioElement): void {
	element.pause();
	element.srcObject = null;
	element.volume = 1;
	element.muted = false;

	const sink = element as HTMLAudioElement & { sinkId?: string; setSinkId?: (id: string) => Promise<void> };
	if (sink.sinkId && typeof sink.setSinkId === "function") void sink.setSinkId("").catch(() => {});

	if (!idle.includes(element)) idle.push(element);
}

/** Audio contexts that should be started by the next press if they are not running. */
const waiting = new Set<AudioContext>();

/** What else a press should start: the room's own playback, a video that was refused. */
const unlockListeners = new Set<() => void>();

/**
 * Have a press resume this context while it is not running. Returns the
 * function that stops.
 *
 * For the contexts this page makes as it needs them -- a lossless share's,
 * the song desk's, the analysers that duck the music. Made outside a press, a
 * context can start suspended, and resuming it outside one does nothing; the
 * press that turns the call's sound on is the moment all of them can start.
 */
export function wake(context: AudioContext): () => void {
	waiting.add(context);
	return () => waiting.delete(context);
}

/** Be told when a press has unlocked sound, and run inside it. Returns the function that stops. */
export function whenUnlocked(listener: () => void): () => void {
	unlockListeners.add(listener);
	return () => unlockListeners.delete(listener);
}

/**
 * Make everything that plays able to play, from inside a press.
 *
 * Synchronous throughout, and it has to be: a browser that looks for a press
 * looks for one around the call to play() or resume() itself, and an await
 * before either would put it outside.
 */
export function unlock(): void {
	for (const element of every) {
		if (idle.includes(element)) {
			if (!unlocked.has(element)) tryUnlock(element, true);
		} else if (element.paused && element.srcObject) {
			// In use and not playing, which is a refusal: the library plays every
			// element it attaches and pauses one only when it lets go of it.
			tryUnlock(element, false);
		}
	}

	while (idle.length < SPARE) {
		const element = make();
		idle.push(element);
		tryUnlock(element, true);
	}

	for (const context of waiting) {
		if (context.state === "closed") waiting.delete(context);
		else if (context.state !== "running") void context.resume().catch(() => {});
	}

	for (const listener of [...unlockListeners]) {
		try {
			listener();
		} catch {
			// One that throws does not stop the rest starting.
		}
	}
}

/**
 * Whether the event being handled is one a browser counts as a press.
 *
 * Asked because the events heard below include some that are not: on a touch
 * screen a pointerdown comes before the activation and the pointerup carries it,
 * so playing on the first would be refused and, worse, taken as the answer.
 * Where the browser cannot say, everything is tried, which costs nothing but the
 * attempt.
 */
function pressing(): boolean {
	const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
	return activation ? activation.isActive : true;
}

/** The events a press arrives in, on every kind of screen and keyboard. */
const PRESSES = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

let listening = 0;
const onPress = () => {
	if (pressing()) unlock();
};

/**
 * Listen for presses anywhere on the page, from before the first one. Returns
 * the function that stops.
 *
 * Anywhere, not only on the notice's own button. A notice in a corner is easy to
 * miss, and the press it asks for is something the browser accepts from any
 * part of the page; asking for it in one place only was asking somebody who
 * cannot hear to find that place. Captured, so that a control which stops the
 * event from travelling does not swallow the press on its way to this.
 */
export function listenForPresses(): () => void {
	if (listening++ === 0) {
		for (const kind of PRESSES) window.addEventListener(kind, onPress, { capture: true, passive: true });
	}

	return () => {
		if (--listening === 0) {
			for (const kind of PRESSES) window.removeEventListener(kind, onPress, { capture: true });
		}
	};
}

/** Anything that can change which tracks there are to hear. Answered by looking again, so a spare one costs nothing. */
const CHANGES = [
	RoomEvent.TrackSubscribed,
	RoomEvent.TrackUnsubscribed,
	RoomEvent.TrackPublished,
	RoomEvent.TrackUnpublished,
	RoomEvent.ParticipantConnected,
	RoomEvent.ParticipantDisconnected,
	RoomEvent.Reconnected,
	RoomEvent.Disconnected,
] as const;

/**
 * Play a room's remote sound through the pool. Returns the function that stops
 * and gives every element back.
 *
 * `settle` is called after any track has been given an element, and has to put
 * every volume back. Not out of caution: the room announces a new track to this
 * and to the code applying volumes in the same breath, in whichever order they
 * listened, and where the volume came first the library holds it on the track and
 * applies it to an element attached later only if it is not nought. Somebody
 * turned all the way down was heard at full volume whenever their track arrived
 * before it had an element, which is what a rejoin always does.
 */
export function sound(room: Room, settle: () => void): () => void {
	const playing = new Map<RemoteTrack, HTMLAudioElement>();

	const look = () => {
		const heard = new Set<RemoteTrack>();
		let added = false;

		for (const participant of room.remoteParticipants.values()) {
			// Never this person, however they come to be listed. The library keeps
			// them out of this map, but the identity is checked as well: a page that
			// rejoined as the same identity can briefly see the session it replaced,
			// and playing that is somebody hearing their own voice a moment late.
			if (participant.isLocal || participant.identity === room.localParticipant.identity) continue;

			// Every sound, by its kind: a voice, a screen's sound, and the song
			// desk's music, which travels as Unknown (see hearing.ts) and is why
			// the kind is asked rather than the source. Those three are what the
			// library's own renderer followed, and they are every source a sound
			// can have.
			for (const publication of participant.trackPublications.values()) {
				const track = publication.track as RemoteTrack | undefined;
				if (!track || publication.kind !== Track.Kind.Audio) continue;
				if (!publication.isSubscribed) continue;

				heard.add(track);
				if (playing.has(track)) continue;

				const element = take();
				track.attach(element);
				playing.set(track, element);
				added = true;
			}
		}

		for (const [track, element] of playing) {
			if (heard.has(track)) continue;
			track.detach(element);
			giveBack(element);
			playing.delete(track);
		}

		if (added) settle();
	};

	look();
	for (const event of CHANGES) room.on(event, look);

	return () => {
		for (const event of CHANGES) room.off(event, look);
		for (const [track, element] of playing) {
			track.detach(element);
			giveBack(element);
		}
		playing.clear();
	};
}

/** Back to a page that has made nothing. For the tests. */
export function resetSpeakers(): void {
	for (const element of every) element.remove();
	every.clear();
	idle.length = 0;
	waiting.clear();
	unlockListeners.clear();
	holder?.remove();
	holder = undefined;
}
