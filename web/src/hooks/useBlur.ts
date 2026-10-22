import { blur, possible, remember, wanted, warm } from "@/live/blur";
import {
	type LocalVideoTrack,
	type TrackPublication,
	type Room,
	RoomEvent,
	Track,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Blurring the background, for as long as somebody is in a call.
 *
 * Held here rather than in the menu that has the switch, for the same reason
 * the door is watched from the room rather than from the panel: the menu is a
 * dropdown, so anything living inside it exists only while it is open. A
 * preference read there would be read once, when somebody happened to look.
 *
 * What this has to survive is a camera going off and coming back on, and a
 * different camera being chosen. Both replace the track, and a processor is a
 * property of a track — so the blur somebody turned on before the call would
 * quietly stop applying at the first device change, which is the failure this
 * watches for. The publication is re-read on every local track change and the
 * choice is applied again.
 */
export function useBlur(room: Room) {
	const [on, setOn] = useState(() => wanted());
	const [busy, setBusy] = useState(false);

	/**
	 * Whether a processor is being installed right now.
	 *
	 * The toggle and the effect below both apply the choice to the track, and
	 * they raced. The toggle sets the choice first so the switch answers the
	 * press immediately; the choice is a dependency of the effect, so the effect
	 * re-ran while the toggle's own setProcessor was still in flight, asked the
	 * track whether it had a processor, and got no — because it did not have one
	 * yet. It installed a second, tearing down the first mid-build.
	 *
	 * The result was not an error. The call went on and the person's own picture
	 * became two pixels across, which reads as a black tile, and turning blur off
	 * again left it there.
	 *
	 * It cannot happen in development, which is why it shipped: the first blur
	 * fetches two and a half megabytes of runtime and model, instant off
	 * localhost and seconds over a network, so the window only exists on a real
	 * deployment. A ref rather than state because the effect must see the change
	 * without being restarted by it, which is the whole shape of the fault.
	 */
	const applying = useRef(false);

	// Fetched for somebody who already blurs, and for nobody else.
	//
	// This used to run on every call. It is two and a half megabytes, and on the
	// connections most of the people here are on that is a real cost, charged to
	// everybody for a feature most of them never turn on — a head start bought
	// with somebody else's data. The switch is not what needs the runtime to
	// have arrived: the republish above is what makes a cold install safe. So
	// the fetch is for the person whose next call will use it anyway, and the
	// menu asks for it when somebody opens the menu.
	useEffect(() => {
		if (wanted()) void warm();
	}, []);

	const camera = useCallback(
		(): LocalVideoTrack | undefined =>
			room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as
				| LocalVideoTrack
				| undefined,
		[room],
	);

	// Applied to whatever camera track is live now, whenever that changes.
	//
	// A track arriving already blurred is left alone: setProcessor on a track
	// that has one tears the old one down and builds another, which is a visible
	// stutter for no change.
	useEffect(() => {
		let live = true;

		// Given the publication the event carries, and only asked the participant
		// where there is none. LocalTrackPublished arrives before the track is
		// necessarily findable through getTrackPublication, so a handler that
		// only asks finds nothing, returns, and is never called again — which is
		// a switch that turns on and does nothing at all.
		const apply = (published?: TrackPublication) => {
			const track = (published?.videoTrack as LocalVideoTrack | undefined) ?? camera();
			if (!track || !on || applying.current) return;
			if (track.getProcessor()) return;

			applying.current = true;

			void blur(track, true)
				.then((worked) => {
					if (live && !worked) setOn(false);
				})
				.finally(() => {
					applying.current = false;
				});
		};

		apply();

		room.on(RoomEvent.LocalTrackPublished, apply);
		room.on(RoomEvent.TrackMuted, apply);
		room.on(RoomEvent.TrackUnmuted, apply);

		return () => {
			live = false;
			room.off(RoomEvent.LocalTrackPublished, apply);
			room.off(RoomEvent.TrackMuted, apply);
			room.off(RoomEvent.TrackUnmuted, apply);
		};
	}, [camera, on, room]);

	const toggle = useCallback(async () => {
		const track = camera();
		const wants = !on;

		// Remembered whether or not there is a camera to apply it to. Somebody
		// turning this on with their camera off has said what they want, and the
		// track that comes up later is the one that has to honour it.
		remember(wants);
		setOn(wants);

		if (!track) return;

		setBusy(true);
		applying.current = true;

		try {
			if (!wants) {
				await blur(track, false);
				return;
			}

			/*
			 * Turning it on republishes the camera rather than swapping the
			 * source underneath it.
			 *
			 * Installing a processor on a track that is already encoding and
			 * being sent produces, when the install is slow, a canvas track that
			 * never draws: the call goes on, the install reports success, and
			 * the person's own picture is black until they rejoin. Installing at
			 * the moment a track is published does not — that path was measured
			 * cold, over a network, and came up blurred every time.
			 *
			 * So the switch takes the path that works. The camera goes off and
			 * on, the effect above applies the choice to the new track as it is
			 * published, and the cost is about a second of one's own tile being
			 * empty. That is the whole of the difference between this and a
			 * black picture nobody can clear.
			 *
			 * The guard is held across the camera going off and dropped before it
			 * comes back, which is not fussiness. Dropped any earlier, the effect
			 * — already re-running because the choice changed — takes hold of the
			 * track that is being torn down and installs on that. It fails, the
			 * failure puts the switch back to off, and blur reads as a control
			 * that does nothing at all.
			 */
			await room.localParticipant.setCameraEnabled(false);

			applying.current = false;
			await room.localParticipant.setCameraEnabled(true);
		} catch {
			// A camera that would not come back. The switch says what happened.
			remember(false);
			setOn(false);
		} finally {
			applying.current = false;
			setBusy(false);
		}
	}, [camera, on, room]);

	return { possible: possible(), on, busy, toggle };
}
