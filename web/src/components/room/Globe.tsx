import { Flagged } from "@/components/room/Flag";
import { useT } from "@/hooks/useT";
import type { Relay } from "@/live/relays";
import { LAND } from "@/live/world";
import { cn } from "@/lib/utils";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

/*
Where the servers are, as a globe you can turn.

The list they replaced answered "which of these is quickest" well and "where are
these" not at all — eleven rows of text with a flag on each, and the flag is the
only thing on the row that says anything about the world. Somebody choosing where
to hold a call with people in three countries is thinking about the world.

Hand-drawn rather than a mapping library, and the coastlines are a fourteen
kilobyte file in this repository. A globe is a circle, an orthographic
projection, and some lines: the projection is nine lines of arithmetic, and every
library that would do it arrives with a tile loader, a layer system and several
hundred kilobytes of things this does not need.

The sphere is the point. A flat map puts Los Angeles and Shanghai at opposite
edges when they are neighbours across the Pacific, which is exactly the
relationship somebody is trying to see. Turning it is how you look at the other
side, and it starts turned to wherever the fastest relay is, because that is the
side the person looking is on.
*/

/** The radius the globe is drawn at, in its own coordinates. */
const R = 100;

/**
 * How fast it turns on its own, in degrees a second, and how long it waits
 * before starting again after somebody has had hold of it.
 *
 * A degree and a half a second is four minutes for a full turn — about as slow
 * as movement can be and still be movement. Fast enough to read as a thing that
 * is alive, slow enough that a marker somebody is reaching for has not gone
 * anywhere by the time they arrive, which at any real speed it has.
 *
 * The direction is the one the planet actually turns. Seen from a fixed point in
 * space the land drifts eastward, which means the longitude at the centre goes
 * down — and the wrong way round looks wrong to people who could not tell you
 * why.
 */
const SPIN_RATE = 1.5;
const SPIN_AFTER = 3000;

/**
 * The most it advances in one step.
 *
 * A tab that has been in the background gets one enormous delta when it comes
 * back, and the globe would snap through half a turn on the frame somebody
 * returned to the page. Clamped to a fifth of a second, so a pause looks like a
 * pause rather than like a jump.
 */
const MOST = 0.2;

/** Degrees of longitude and latitude between the guide lines. */
const GRATICULE = 30;

/**
 * How far in it zooms: six times, where the four relays within a few degrees of
 * Hong Kong are dots apart rather than one blot, and the coastline still says
 * where they are.
 */
export const ZOOM_MOST = 6;

/**
 * How much a wheel or a pinch zooms, per pixel it reports. A trackpad's pinch
 * arrives as a run of small deltas and a mouse wheel as a few large ones, so the
 * pinch is given the larger rate; a notch of the wheel (a hundred pixels) is
 * then about a fifth, and a pinch of the fingers apart about doubles it.
 */
const PER_WHEEL_PIXEL = 0.002;
const PER_PINCH_PIXEL = 0.01;

/** Degrees a two-finger swipe turns the globe per pixel, at no zoom. */
const PER_SWIPE_PIXEL = 0.25;

function clampZoom(zoom: number): number {
	return Math.min(ZOOM_MOST, Math.max(1, zoom));
}

/**
 * What a wheel event means here. A pinch on a trackpad is sent by Chrome and
 * Firefox as a wheel with ctrlKey set, and zooms. A mouse wheel turns in lines,
 * or in whole steps of forty pixels or more straight up and down, and zooms. The
 * rest is two fingers moving on a trackpad, which turn the globe the way they
 * move a map in the system's own maps, rather than zooming it, which is what a
 * pinch is for.
 */
export function wheelSays(event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "ctrlKey">):
	| { zoom: number }
	| { turn: { x: number; y: number } } {
	const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
	const x = event.deltaX * unit;
	const y = event.deltaY * unit;

	if (event.ctrlKey) return { zoom: Math.exp(-y * PER_PINCH_PIXEL) };
	if (event.deltaMode !== 0 || (x === 0 && Number.isInteger(y) && Math.abs(y) >= 40)) {
		return { zoom: Math.exp(-y * PER_WHEEL_PIXEL) };
	}
	return { turn: { x, y } };
}

interface Spin {
	/** Degrees of longitude at the centre, and how far the pole is tipped. */
	lon: number;
	lat: number;
}

/**
 * Orthographic projection: the globe as seen from very far away.
 *
 * Returns the point and whether it is on the near side. The far side is not
 * clipped by a mask — everything is asked whether it faces us, which is one
 * comparison and is also what makes a marker behind the world disappear rather
 * than showing through it.
 */
function project(lon: number, lat: number, spin: Spin, zoom = 1) {
	const λ = ((lon - spin.lon) * Math.PI) / 180;
	const φ = (lat * Math.PI) / 180;
	const φ0 = (spin.lat * Math.PI) / 180;

	const cosφ = Math.cos(φ);
	const facing = Math.sin(φ0) * Math.sin(φ) + Math.cos(φ0) * cosφ * Math.cos(λ);

	// Zoomed by drawing the sphere larger than the picture and letting the
	// picture cut it off, about its centre. The markers and the lines are drawn
	// at their own sizes whatever the zoom: a marker that grew with it would fill
	// the gap between neighbours that zooming in was meant to open.
	const r = R * zoom;
	return {
		x: r * cosφ * Math.sin(λ),
		y: -r * (Math.cos(φ0) * Math.sin(φ) - Math.sin(φ0) * cosφ * Math.cos(λ)),
		facing: facing >= 0,
	};
}

/*
 * Two decimal places, which is not a detail.
 *
 * One was enough for a globe somebody drags — a drag moves things by whole
 * pixels — and is far too coarse for one that turns by itself. At a degree and a
 * half a second the land advances about a twelfth of a unit per frame, so at one
 * decimal several frames in a row round to the same coordinates and produce the
 * same path, and then one of them steps by a tenth. The motion is perfectly
 * even and looks like a stutter, because it is being drawn on a grid coarser
 * than the movement.
 */

/** One coastline, as the path of whichever of its points face us. */
function outline(ring: readonly number[], spin: Spin, zoom = 1): string {
	let path = "";
	let drawing = false;

	for (let i = 0; i + 1 < ring.length; i += 2) {
		const at = project(ring[i] as number, ring[i + 1] as number, spin, zoom);

		if (!at.facing) {
			// Broken rather than wrapped. A coastline that runs over the horizon
			// and back would otherwise be closed with a straight line across the
			// face of the globe, which reads as a river nobody can find.
			drawing = false;
			continue;
		}

		path += `${drawing ? "L" : "M"}${at.x.toFixed(2)} ${at.y.toFixed(2)}`;
		drawing = true;
	}

	return path;
}

function meridians(spin: Spin, zoom = 1): string {
	let path = "";

	for (let lon = -180; lon < 180; lon += GRATICULE) {
		let drawing = false;

		for (let lat = -90; lat <= 90; lat += 5) {
			const at = project(lon, lat, spin, zoom);

			if (!at.facing) {
				drawing = false;
				continue;
			}

			path += `${drawing ? "L" : "M"}${at.x.toFixed(2)} ${at.y.toFixed(2)}`;
			drawing = true;
		}
	}

	for (let lat = -60; lat <= 60; lat += GRATICULE) {
		let drawing = false;

		for (let lon = -180; lon <= 180; lon += 5) {
			const at = project(lon, lat, spin, zoom);

			if (!at.facing) {
				drawing = false;
				continue;
			}

			path += `${drawing ? "L" : "M"}${at.x.toFixed(2)} ${at.y.toFixed(2)}`;
			drawing = true;
		}
	}

	return path;
}

export function Globe({
	relays,
	value,
	measured,
	onChange,
}: {
	relays: Relay[];
	value: string;
	measured?: Map<string, number | undefined>;
	onChange: (name: string) => void;
}) {
	const t = useT();

	// Turned to whichever relay answers fastest, because that is the side of the
	// world the person looking is on. Only until they touch it — after that it is
	// theirs, and a globe that kept correcting itself would be a globe fighting
	// whoever is holding it.
	const [spin, setSpin] = useState<Spin>({ lon: 110, lat: 20 });
	const [turned, setTurned] = useState(false);
	const [over, setOver] = useState<string>();
	const drag = useRef<{ x: number; y: number; from: Spin }>();

	/*
	 * Zoomed with a mouse's wheel, a trackpad's pinch (Chrome and Firefox send
	 * it as a wheel with ctrlKey, Safari as gesture events of its own), or two
	 * fingers apart on a touch screen; turned with two fingers moving on a
	 * trackpad as well as by dragging. The owner asked for the wheel and the Mac
	 * trackpad both. While it is zoomed in it does not turn by itself: whoever
	 * zoomed in is looking at something, and a world drifting out from under a
	 * close look moves six times as fast on screen.
	 */
	const [zoom, setZoom] = useState(1);
	const zoomNow = useRef(1);
	zoomNow.current = zoom;
	const picture = useRef<SVGSVGElement>(null);
	// Seen through the globe's own round outline when zoomed in, as through a
	// lens: cut off by the picture's square edges instead, a zoomed globe read as
	// a map torn out of a page.
	const lens = useId();
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const pinch = useRef<{ apart: number; from: number }>();

	// When it may start turning by itself again. Somebody with hold of it, or
	// reaching for a marker, is doing something the globe must not fight.
	const idle = useRef(0);

	// Whether it has already been pointed at the quickest relay. Once is the
	// point: doing it twice is the globe correcting itself out from under
	// whoever is looking at it.
	const aimed = useRef(false);

	/*
	 * Turning on its own.
	 *
	 * Through requestAnimationFrame rather than a timer, for two reasons that
	 * both matter more than smoothness: the browser stops calling it when the tab
	 * is not visible, so a page left open in the background is not a page turning
	 * a globe nobody can see, and it hands over the real elapsed time, so the
	 * speed is the same on a slow machine as on a fast one instead of being
	 * whatever the frame rate happens to be.
	 *
	 * Every callback rather than every other one. The throttle that was here
	 * halved the work and cost more than it saved: requestAnimationFrame already
	 * runs at the display's rate, so a gate of "at least a thirtieth of a second"
	 * lands on some frames and not others depending on how the two rates drift
	 * past each other, and uneven frames are exactly what somebody means when
	 * they say motion is not smooth.
	 */
	useEffect(() => {
		// Somebody who has asked not to be shown movement is not asking for a
		// slower globe; they are asking for a still one.
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

		let frame = 0;
		let last = 0;

		const step = (now: number) => {
			frame = requestAnimationFrame(step);

			if (!last) {
				last = now;
				return;
			}

			const since = (now - last) / 1000;
			last = now;

			if (drag.current || now < idle.current || zoomNow.current > 1) return;

			setSpin((was) => ({ ...was, lon: was.lon - SPIN_RATE * Math.min(since, MOST) }));
		};

		frame = requestAnimationFrame(step);

		return () => cancelAnimationFrame(frame);
	}, []);

	const placed = useMemo(
		() => relays.filter((relay) => relay.lat !== undefined && relay.lon !== undefined),
		[relays],
	);

	/*
	 * Where to look, before anybody has said otherwise.
	 *
	 * Once, when the measurements land, and never again — which is the whole of
	 * the fix rather than a refinement of it. This ran on every render and aimed
	 * the globe at the quickest relay whenever it had drifted a degree away from
	 * it, so the moment the globe started turning by itself the two were fighting:
	 * the rotation moved it a fraction, this pulled it back, sixty times a second.
	 * What that looks like is a twitch, and nothing about it looks like an
	 * argument between two pieces of code that each work.
	 *
	 * A ref rather than state because nothing on screen depends on whether it has
	 * happened, and setting state here would be a render that exists to record
	 * that a render happened.
	 */
	useEffect(() => {
		if (aimed.current || turned || !measured) return;

		let best: Relay | undefined;
		let quickest = Number.POSITIVE_INFINITY;

		for (const relay of placed) {
			const ms = measured.get(relay.name);
			if (ms !== undefined && ms < quickest) {
				quickest = ms;
				best = relay;
			}
		}

		if (best?.lon === undefined || best.lat === undefined) return;

		aimed.current = true;
		setSpin({ lon: best.lon, lat: Math.max(-60, Math.min(60, best.lat)) });
	}, [placed, measured, turned]);

	const apart = () => {
		const [a, b] = [...pointers.current.values()];
		return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
	};

	const grab = (event: ReactPointerEvent<SVGSVGElement>) => {
		event.currentTarget.setPointerCapture(event.pointerId);
		pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
		aimed.current = true;
		setTurned(true);

		// A second finger down is a pinch, and the drag the first began is over.
		if (pointers.current.size === 2) {
			drag.current = undefined;
			pinch.current = { apart: apart(), from: zoomNow.current };
			return;
		}

		drag.current = { x: event.clientX, y: event.clientY, from: spin };
	};

	// Held still for a moment after anything somebody did, rather than stopped
	// for good. A globe that never moves again after one stray drag is a globe
	// somebody broke by touching it; one that carries on the instant they let go
	// is one that will not let them read it.
	const rest = () => {
		idle.current = performance.now() + SPIN_AFTER;
	};

	const turn = (event: ReactPointerEvent<SVGSVGElement>) => {
		if (pointers.current.has(event.pointerId)) {
			pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
		}

		const pinched = pinch.current;
		if (pinched && pointers.current.size >= 2 && pinched.apart > 0) {
			setZoom(clampZoom((pinched.from * apart()) / pinched.apart));
			return;
		}

		const held = drag.current;
		if (!held) return;

		// A degree of rotation per pixel and a bit, which makes a drag across the
		// globe about a quarter turn — enough to feel like turning a thing rather
		// than scrubbing a slider. Latitude is clamped short of the poles: past
		// them the world turns upside down under the pointer and nobody means
		// that.
		// Slower as it is zoomed, so that a drag moves the land about as far as
		// the pointer moved rather than six times as far.
		const rate = 0.6 / zoomNow.current;
		setSpin({
			lon: held.from.lon - (event.clientX - held.x) * rate,
			lat: Math.max(-75, Math.min(75, held.from.lat + (event.clientY - held.y) * rate)),
		});
	};

	const release = (event: ReactPointerEvent<SVGSVGElement>) => {
		pointers.current.delete(event.pointerId);
		if (pointers.current.size < 2) pinch.current = undefined;
		// The finger left behind after a pinch does not start a drag from where
		// it is, which would jump the globe to wherever that is.
		drag.current = undefined;
		rest();
	};

	/*
	 * The wheel, and Safari's pinch, listened for directly rather than through
	 * React: React listens for wheels passively, and a listener that cannot call
	 * preventDefault cannot stop the page scrolling, or the browser zooming the
	 * whole page, under a wheel or a pinch that was meant for the globe.
	 */
	useEffect(() => {
		const svg = picture.current;
		if (!svg) return;

		let gesturing = false;
		let gestureFrom = 1;

		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			// Safari's pinch comes as gesture events; a wheel it sends alongside
			// one is the same pinch said twice.
			if (gesturing && event.ctrlKey) return;

			const said = wheelSays(event);
			aimed.current = true;
			setTurned(true);
			rest();

			if ("zoom" in said) {
				setZoom((was) => clampZoom(was * said.zoom));
				return;
			}

			const rate = PER_SWIPE_PIXEL / zoomNow.current;
			setSpin((was) => ({
				lon: was.lon + said.turn.x * rate,
				lat: Math.max(-75, Math.min(75, was.lat - said.turn.y * rate)),
			}));
		};

		const gestureStart = (event: Event) => {
			event.preventDefault();
			gesturing = true;
			gestureFrom = zoomNow.current;
			aimed.current = true;
			setTurned(true);
		};
		const gestureChange = (event: Event) => {
			event.preventDefault();
			const scale = (event as Event & { scale?: number }).scale ?? 1;
			setZoom(clampZoom(gestureFrom * scale));
			rest();
		};
		const gestureEnd = (event: Event) => {
			event.preventDefault();
			gesturing = false;
		};

		svg.addEventListener("wheel", wheel, { passive: false });
		svg.addEventListener("gesturestart", gestureStart);
		svg.addEventListener("gesturechange", gestureChange);
		svg.addEventListener("gestureend", gestureEnd);
		return () => {
			svg.removeEventListener("wheel", wheel);
			svg.removeEventListener("gesturestart", gestureStart);
			svg.removeEventListener("gesturechange", gestureChange);
			svg.removeEventListener("gestureend", gestureEnd);
		};
	}, []);

	return (
		<div className="relative select-none">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the globe is a picture; every relay on it is a button */}
			<svg
				ref={picture}
				viewBox={`${-R - 6} ${-R - 6} ${(R + 6) * 2} ${(R + 6) * 2}`}
				className="w-full cursor-grab touch-none active:cursor-grabbing"
				onPointerDown={grab}
				onPointerMove={turn}
				onPointerUp={release}
				onPointerCancel={release}
				aria-hidden
			>
				<title>{t("Where the servers are")}</title>

				<defs>
					<clipPath id={lens}>
						<circle r={R} />
					</clipPath>
				</defs>

				<g clipPath={`url(#${lens})`}>

				{/* The ocean, and a rim to give the sphere an edge. Without the rim
				    the coastlines float and the thing reads as a scatter of shapes
				    rather than as a ball. */}
				<circle r={R * zoom} className="fill-surface stroke-border" strokeWidth={1} />

				<path d={meridians(spin, zoom)} className="stroke-fg-muted/15" strokeWidth={0.5} fill="none" />

				<path
					d={LAND.map((ring) => outline(ring, spin, zoom)).join("")}
					className="fill-none stroke-fg-muted/55"
					strokeWidth={0.9}
					strokeLinejoin="round"
				/>

				{placed.map((relay) => {
					const at = project(relay.lon as number, relay.lat as number, spin, zoom);

					if (!at.facing) return null;

					const chosen = value === relay.name;
					const ms = measured?.get(relay.name);

					return (
						<g key={relay.name}>
							{/* A halo on the chosen one, drawn under it so the dot
							    keeps its edge. */}
							{chosen && <circle cx={at.x} cy={at.y} r={7} className="fill-tally/25" />}

							<circle
								cx={at.x}
								cy={at.y}
								r={chosen || over === relay.name ? 4 : 3}
								className={cn(
									"cursor-pointer transition-[r]",
									relay.maintenance
										? "fill-fg-muted/40"
										: chosen
											? "fill-tally"
											: ms === undefined
												? "fill-fg-muted"
												: ms <= 150
													? "fill-good"
													: ms <= 400
														? "fill-tally"
														: "fill-danger",
								)}
								onPointerDown={(event) => event.stopPropagation()}
								onPointerEnter={() => {
									// Still while somebody is reading a marker, or the
									// label in the corner belongs to whichever dot has
									// drifted under the pointer since.
									rest();
									setOver(relay.name);
								}}
								onPointerLeave={() => setOver((was) => (was === relay.name ? undefined : was))}
								onClick={() => !relay.maintenance && onChange(relay.name)}
							/>
						</g>
					);
				})}
				</g>

				{zoom > 1 && <circle r={R} className="pointer-events-none fill-none stroke-border" strokeWidth={1} />}
			</svg>

			{/*
			 * What the pointer is on, in the corner rather than beside the dot.
			 * A label that follows a marker around a sphere collides with the
			 * other markers, and there are four of them within a few degrees of
			 * Hong Kong.
			 */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center">
				<span
					className={cn(
						"rounded-full border border-border bg-surface-hi/90 px-2.5 py-1 backdrop-blur afloat",
						"text-[11.5px] transition-opacity",
						over || value ? "opacity-100" : "opacity-0",
					)}
				>
					<Flagged text={label(relays, over ?? value, measured)} />
				</span>
			</div>
		</div>
	);
}

function label(
	relays: Relay[],
	name: string | undefined,
	measured?: Map<string, number | undefined>,
): string {
	const relay = relays.find((one) => one.name === name);

	if (!relay) return "";

	const ms = measured?.get(relay.name);

	return ms === undefined
		? (relay.label ?? relay.name)
		: `${relay.label ?? relay.name}  ${Math.round(ms)} ms`;
}
