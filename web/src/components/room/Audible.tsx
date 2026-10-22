import { musicArrived, musicFactor, musicLeft, subscribeDuck, watchSpeech } from "@/live/duck";
import { SOUNDS, SOURCE, type Sound, settingFor, subscribe } from "@/live/hearing";
import { holdsBack, receiveLossless } from "@/live/lossless-receiver";
import { audioBlocked } from "@/live/notices";
import { isMusic } from "@/live/sound";
import { sound, whenUnlocked } from "@/live/speakers";
import { useAudioPlayback } from "@livekit/components-react";
import { type RemoteParticipant, type Room, RoomEvent, Track } from "livekit-client";
import { useEffect } from "react";

/**
 * Everything the room sounds like.
 *
 * Voices are not part of the layout, so nothing on screen renders them, and
 * without this the call is silent while every other sign of life — the tally,
 * the microphone icon, the level on somebody's own meter — says it is working.
 * That is the worst shape a fault can take, so the sound gets its own component
 * rather than being tucked inside a tile that might not be on the page.
 *
 * The elements it plays through belong to the page rather than to the room; see
 * live/speakers.ts. The library's own renderer made new ones for every room,
 * and a room the page joined by itself — after a placing, a move, a reload — had
 * elements nobody had pressed anything for, which a browser that asks
 * permission of each element will not play. What that renderer followed is
 * kept: the microphones, a screen's sound and the song desk's music of everybody
 * but this person, playing whether or not their tile is on the page, with no
 * volume of its own over the settings below.
 *
 * Passed the room directly rather than through a provider, which is what makes
 * it usable here at all — this application holds its room itself and puts no
 * context above the tree.
 */
export function Audible({ room }: { room: Room }) {
	const { canPlayAudio } = useAudioPlayback(room);

	// Browsers refuse to play sound a person did not ask for. Joining is
	// normally gesture enough, so this stays quiet in the ordinary case and
	// speaks up only where the browser actually held the audio back.
	//
	// Any press anywhere on the page starts it, not only the notice's button:
	// the notice is in a corner, and the press the browser wants is accepted
	// from anywhere. Run inside the press, because that is the only place the
	// room's elements and its context are allowed to start.
	useEffect(() => {
		if (canPlayAudio) return;

		const start = () => void room.startAudio().catch(() => {});
		const stop = whenUnlocked(start);
		const takeDown = audioBlocked(start);

		return () => {
			stop();
			takeDown();
		};
	}, [canPlayAudio, room]);

	// What anybody has decided about hearing other people, kept applied.
	useEffect(() => {
		const put = () => apply(room);

		// At once, because a participant already in the room when this mounts
		// announces nothing: the events below are all about things that change
		// afterwards.
		put();

		for (const event of HEARING_EVENTS) room.on(event, put);
		const stop = subscribe(put);

		// Every remote sound on one of the page's elements, and the settings
		// put back whenever one is handed out; see `sound` for why after.
		const silence = sound(room, put);

		// Shared sound offered losslessly is played from its own stream, and
		// its Opus track held back while it is; whenever which tracks those are
		// changes, the settings are put back with that taken into account.
		const unlisten = receiveLossless(room, put);

		// The music turned down under speech, and faded in when it starts; see
		// live/duck.ts. Only the music's volume moves, many times a second while
		// it does, so only that is put back then.
		const unwatch = watchSpeech(room);
		const unduck = subscribeDuck(() => applyMusic(room));

		return () => {
			for (const event of HEARING_EVENTS) room.off(event, put);
			stop();
			silence();
			unlisten();
			unwatch();
			unduck();
		};
	}, [room]);

	return null;
}

/**
 * When the media library may have forgotten what it was told.
 *
 * A volume is kept on the participant and a block on the publication, and both
 * of those are rebuilt from nothing more often than one would think: a full
 * reconnect disconnects and re-adds every remote participant, and a share
 * stopped and started again is a new publication. Every one of those arrives as
 * one of these.
 *
 * Muting is not among them. Somebody covering their microphone does not replace
 * a publication, so nothing is lost and re-applying would be a message to the
 * media server for no reason.
 */
const HEARING_EVENTS = [
	RoomEvent.ParticipantConnected,
	RoomEvent.TrackPublished,
	RoomEvent.TrackSubscribed,
] as const;

/**
 * Put every setting back on the room.
 *
 * All of them, every time, rather than working out which one this event was
 * about. The book holds an entry per person per sound and is nearly always
 * empty; deciding which entry a given event invalidated would be more code than
 * this and would be wrong in the case nobody thought of.
 */
function apply(room: Room): void {
	for (const participant of room.remoteParticipants.values()) {
		for (const sound of SOUNDS) {
			const source = SOURCE[sound];
			const setting = settingFor(participant.identity, sound);

			// Kept on the participant rather than the track, so it is waiting
			// for a microphone that has not been turned on yet. The SDK's type
			// names two sources, but what it does -- file the volume by source
			// and apply it to that source's track when one arrives -- is the same
			// for any, and the music's is Unknown; see hearing.ts.
			participant.setVolume(volumeOf(participant, sound), source as Parameters<typeof participant.setVolume>[1]);

			const publication = participant.getTrackPublication(source);

			// Held back as well while the same sound is arriving losslessly:
			// asked of the media server like a block, so it is not downloaded
			// alongside, and given back the moment the lossless stream ends.
			const off = setting.blocked || (sound !== "voice" && holdsBack(room, participant.identity, sound));

			// Only where it differs, because this one leaves the machine: every
			// call with a new answer sends the media server a settings update,
			// and this runs for everybody in the room on every arrival.
			if (publication && publication.isEnabled === off) {
				publication.setEnabled(!off);
			}
		}
	}
}

/** How loud one sound from one person is to be: their setting, and for music the duck and the fade-in. */
function volumeOf(participant: RemoteParticipant, sound: Sound): number {
	const volume = settingFor(participant.identity, sound).volume;
	if (sound !== "music") return volume;

	if ([...participant.trackPublications.values()].some((publication) => isMusic(publication))) {
		musicArrived(participant.identity);
	} else {
		musicLeft(participant.identity);
	}
	return volume * musicFactor(participant.identity);
}

/** Only the music's volumes, for the many times a second they move. */
function applyMusic(room: Room): void {
	for (const participant of room.remoteParticipants.values()) {
		participant.setVolume(volumeOf(participant, "music"), Track.Source.Unknown as Parameters<typeof participant.setVolume>[1]);
	}
}
