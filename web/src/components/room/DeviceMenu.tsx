import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBlur } from "@/hooks/useBlur";
import { warm } from "@/live/blur";
import type { Placement } from "@/live/controls";
import { useT } from "@/hooks/useT";
import { deviceFailed } from "@/live/notices";
import { type ChosenKind, rememberDeviceChoice } from "@/live/preferences";
import { applyOriginalSound, rememberedOriginal } from "@/live/sound";
import { type Room, supportsAudioOutputSelection } from "livekit-client";
import { ChevronUp, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Device pickers.
 *
 * Noise suppression, echo cancellation, and gain control are left to the
 * browser's own audio pipeline, which every other call app relies on when it is
 * not shipping a model of its own. They are not exposed as switches because the
 * defaults are right for a meeting, and the one case where they are wrong
 * (playing music) is better served by sharing a tab with its audio.
 *
 * Where sound comes out is here too, and was not. Somebody who plugs in
 * headphones part-way through a call had no way to move the call onto them from
 * inside the application: the only route was to leave, change the machine's
 * setting, and come back. Offered only where the browser can act on it — Safari
 * cannot, and a control that silently does nothing is worse than its absence.
 */
export function DeviceMenu({
	room,
	where,
	onPlace,
}: { room: Room; where: Placement; onPlace: (where: Placement) => void }) {
	const t = useT();
	const background = useBlur(room);
	const original = useOriginalSound(room);

	return (
		<DropdownMenu
			// Opening this is the first moment anybody is plausibly about to
			// blur, and the last moment the runtime can be fetched without the
			// press waiting on it. Free for everybody who never opens it.
			onOpenChange={(open) => {
				if (open && background.possible) void warm();
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="round" aria-label={t("Devices")}>
					<ChevronUp />
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="center" side="top">
				<DropdownMenuLabel>{t("Microphone")}</DropdownMenuLabel>
				<Devices room={room} kind="audioinput" />
				{/* Under the microphone because it is a property of the voice,
				    the way blur is a property of the picture. Kept open on a
				    press so the person can hear the difference before deciding;
				    the change is applied to the live microphone, not the next
				    one. */}
				<DropdownMenuCheckboxItem
					checked={original.on}
					disabled={original.busy}
					onSelect={(event) => event.preventDefault()}
					onCheckedChange={() => void original.toggle()}
					className="flex-col items-start gap-0"
				>
					<span className="text-fg">{t("Original sound")}</span>
					<span className="max-w-64 whitespace-normal text-fg-muted text-xs">
						{t("No noise suppression or automatic volume. For headphones and music.")}
					</span>
				</DropdownMenuCheckboxItem>

				{supportsAudioOutputSelection() && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>{t("Speakers")}</DropdownMenuLabel>
						<Devices room={room} kind="audiooutput" />
					</>
				)}

				<DropdownMenuSeparator />
				<DropdownMenuLabel>{t("Camera")}</DropdownMenuLabel>
				<Devices room={room} kind="videoinput" />

				{/* Where the controls themselves are, which is the one setting in
				    this menu that is not about a device. It is here because this
				    is the only menu in the room, and because a control that
				    covers what somebody is looking at has to be adjustable from
				    the control itself — anywhere else is a setting nobody finds
				    while being annoyed by the thing it fixes. */}
				<DropdownMenuSeparator />
				<DropdownMenuLabel>{t("Controls")}</DropdownMenuLabel>

				{(
					[
						["always", t("Always shown")],
						["idle", t("Hide when nothing is happening")],
						["side", t("At the side")],
					] as const
				).map(([which, said]) => (
					<DropdownMenuCheckboxItem
						key={which}
						checked={where === which}
						onCheckedChange={() => onPlace(which)}
					>
						{said}
					</DropdownMenuCheckboxItem>
				))}

				{/* Under the camera, because it is a property of the picture and
				    not a thing of its own. Absent entirely where the browser
				    cannot do it: an option that explains why it does not work is
				    an option somebody reads once and resents. */}
				{background.possible && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>{t("Background")}</DropdownMenuLabel>

						<DropdownMenuCheckboxItem
							checked={background.on}
							disabled={background.busy}
							onSelect={(event) => {
								// Kept open. Turning this on takes a moment the first
								// time — the model has to be fetched — and a menu that
								// closes over that looks like a press that did nothing.
								event.preventDefault();
							}}
							onCheckedChange={() => void background.toggle()}
						>
							{background.busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
							{background.on ? t("Blurred") : t("Not blurred")}
						</DropdownMenuCheckboxItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function Devices({ room, kind }: { room: Room; kind: ChosenKind }) {
	const t = useT();
	const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
	const [active, setActive] = useState<string | undefined>(() => room.getActiveDevice(kind));

	useEffect(() => {
		let live = true;

		const refresh = () => {
			navigator.mediaDevices
				.enumerateDevices()
				.then((all) => {
					if (live) setDevices(all.filter((device) => device.kind === kind));
				})
				.catch(() => {
					// Enumeration fails before permission is granted, which is a
					// state the empty list already describes.
				});
		};

		refresh();
		navigator.mediaDevices.addEventListener("devicechange", refresh);

		return () => {
			live = false;
			navigator.mediaDevices.removeEventListener("devicechange", refresh);
		};
	}, [kind]);

	if (devices.length === 0) {
		return <DropdownMenuLabel>{t("No devices found")}</DropdownMenuLabel>;
	}

	// The tick moves at once, because a menu that waits on the device before
	// acknowledging the press feels broken. So it has to move back when the
	// device will not come: the switch was once left unawaited, and a device that
	// failed to start left the menu ticking one thing while the call used
	// another, with nothing said about either.
	//
	// Remembered once it took, and not before, for the next call to start on.
	// This menu used only to switch, so somebody whose call wants the headset
	// rather than the laptop picked it again at the start of every one — and a
	// choice remembered before the device came up would bring back the one that
	// failed.
	const select = async (deviceId: string) => {
		const before = active;
		setActive(deviceId);

		try {
			// A false answer is the SDK saying some track did not take the new
			// device, which is the same failure without an error to carry it.
			if (!(await room.switchActiveDevice(kind, deviceId))) throw new Error("not switched");

			rememberDeviceChoice(kind, deviceId);
		} catch (err) {
			setActive(before);
			if (kind !== "audiooutput") deviceFailed(kind === "audioinput" ? "microphone" : "camera", err);
		}
	};

	return (
		<>
			{devices.map((device, index) => (
				<DropdownMenuCheckboxItem
					key={device.deviceId}
					checked={device.deviceId === active}
					onCheckedChange={() => void select(device.deviceId)}
				>
					{/* Labels are empty until permission is granted, and a blank
					    row is worse than a generic one. */}
					{device.label || t("Device {number}", { number: index + 1 })}
				</DropdownMenuCheckboxItem>
			))}
		</>
	);
}

/**
 * Whether the voice is sent as it is, and the switch for it.
 *
 * Busy while the microphone restarts with the new constraints, so a second press
 * cannot start a second restart halfway through the first. A restart that fails
 * leaves the choice where it was and says so the way any device failure does.
 */
function useOriginalSound(room: Room) {
	const [on, setOn] = useState(rememberedOriginal);
	const [busy, setBusy] = useState(false);

	const toggle = async () => {
		if (busy) return;
		setBusy(true);
		const next = !on;

		try {
			await applyOriginalSound(room, next);
			setOn(next);
		} catch (err) {
			deviceFailed("microphone", err);
		} finally {
			setBusy(false);
		}
	};

	return { on, busy, toggle };
}
