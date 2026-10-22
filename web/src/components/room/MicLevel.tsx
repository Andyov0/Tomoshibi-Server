import { useT } from "@/hooks/useT";
import { useEffect, useRef, useState } from "react";

/**
 * Whether the microphone is picking anything up, before anybody is in a call.
 *
 * The join screen shows the camera and asked nothing about the microphone, and
 * its own comment says the page exists to answer two questions: whether the
 * camera is pointing at the right thing and whether the microphone is the right
 * one. It could only answer the first. Somebody with the wrong input selected,
 * a muted headset, or a device the browser has decided is a webcam's microphone
 * in another room found out by joining a meeting and being asked whether they
 * were there.
 *
 * A meter rather than a number. What somebody wants to know is "does it move
 * when I speak", which a bar answers instantly and a decibel figure does not.
 *
 * It opens its own stream and closes it, rather than borrowing the one the call
 * will use. Borrowing would mean holding a microphone open across the join,
 * and the track handed to the room is made there with the constraints the room
 * wants; two claims on one device is how a browser ends up handing over silence.
 */
export function MicLevel({ on, deviceId }: { on: boolean; deviceId?: string }) {
	const t = useT();
	const [level, setLevel] = useState(0);
	const [failed, setFailed] = useState(false);

	// Held in a ref rather than in state: it changes sixty times a second and
	// nothing about the component depends on the previous value.
	const bar = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!on) {
			setLevel(0);
			setFailed(false);
			return;
		}

		// Guarded rather than assumed. navigator.mediaDevices is absent outside a
		// secure context and in a good many test environments, and reaching
		// through it throws during render — which does not degrade this control,
		// it takes the whole join screen down with it. The screen already has a
		// page for the case where devices are unavailable; this simply says
		// nothing.
		if (!navigator.mediaDevices?.getUserMedia) {
			setFailed(true);
			return;
		}

		let live = true;
		let stream: MediaStream | undefined;
		let context: AudioContext | undefined;
		let frame = 0;

		void navigator.mediaDevices
			.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true })
			.then((got) => {
				// Closed immediately where the screen went away while the browser
				// was asking. Without this the prompt is answered, the stream is
				// opened, and nothing ever closes it — a microphone light that
				// stays on after the page has gone.
				if (!live) {
					for (const track of got.getTracks()) track.stop();
					return;
				}

				stream = got;

				const AudioContextClass =
					window.AudioContext ??
					(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

				if (!AudioContextClass) {
					setFailed(true);
					return;
				}

				context = new AudioContextClass();

				const analyser = context.createAnalyser();
				// Small, because this is a level and not a spectrum. A larger
				// window costs work sixty times a second to produce a number that
				// is averaged back down to one value.
				analyser.fftSize = 256;
				analyser.smoothingTimeConstant = 0.6;

				context.createMediaStreamSource(got).connect(analyser);

				const amplitudes = new Uint8Array(analyser.frequencyBinCount);

				const read = () => {
					if (!live) return;

					analyser.getByteFrequencyData(amplitudes);

					let sum = 0;
					for (const amplitude of amplitudes) sum += (amplitude / 255) ** 2;

					// Root mean square, then a curve. A linear bar spends most of
					// its length on volumes nobody produces: ordinary speech sits
					// in the bottom fifth of it and reads as a microphone that is
					// barely working.
					const loudness = Math.sqrt(sum / amplitudes.length);
					const shown = Math.min(1, loudness ** 0.5 * 1.6);

					if (bar.current) bar.current.style.transform = `scaleX(${shown})`;

					// State only for whether anything has ever been heard, which is
					// what decides the wording. The bar itself is written straight
					// to the element.
					if (shown > 0.06) setLevel((was) => Math.max(was, shown));

					frame = requestAnimationFrame(read);
				};

				frame = requestAnimationFrame(read);
			})
			.catch(() => {
				// A refused or missing microphone. Said rather than drawn as a
				// meter that never moves, which is indistinguishable from silence.
				if (live) setFailed(true);
			});

		return () => {
			live = false;
			cancelAnimationFrame(frame);

			for (const track of stream?.getTracks() ?? []) track.stop();
			void context?.close();
		};
	}, [on, deviceId]);

	if (!on) return null;

	return (
		<div className="flex items-center gap-2">
			<div
				className="h-1 flex-1 overflow-hidden rounded-full bg-surface-hi"
				role="meter"
				aria-label={t("Microphone level")}
			>
				{/*
				  * Started at nothing with an inline style rather than with
				  * `scale-x-0`, and this is the whole of why the meter never
				  * moved.
				  *
				  * Tailwind v4 writes its scale utilities to the `scale`
				  * property — `.scale-x-0` is `scale: 0% var(--tw-scale-y)` —
				  * and the loop below writes `transform: scaleX(n)`. Those are
				  * two different properties and the browser applies both, so a
				  * class saying "zero" multiplied whatever the loop wrote and the
				  * fill was invisible at every volume. What was left on screen
				  * was the track behind it, which is a full-width bar that never
				  * moves, beside a label reading "Hearing you" — because the
				  * wording is state and only the bar was written this way.
				  *
				  * Set here so that both ends of the animation are the same
				  * property and nothing has to know that.
				  */}
				<div
					ref={bar}
					style={{ transform: "scaleX(0)" }}
					// No transition: the value is written every frame and a
					// transition would make the bar lag behind the voice it is
					// about, which reads as a meter measuring somebody else.
					className="h-full origin-left rounded-full bg-tally"
				/>
			</div>

			<span className="w-24 shrink-0 text-[10.5px] text-fg-muted leading-none">
				{failed
					? t("No sound from it")
					: level > 0
						? t("Hearing you")
						: t("Say something")}
			</span>
		</div>
	);
}
