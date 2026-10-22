import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/useT";
import type { Phrase } from "@/live/i18n";
import {
	SHARE_QUALITIES,
	type ShareFrameRate,
	type ShareQuality,
	type ShareSetting,
	ratesFor,
	rememberFrameRate,
	rememberQuality,
	rememberedFrameRate,
	rememberedQuality,
} from "@/live/room";
import { AudioLines, CircleStop, MonitorOff, MonitorUp, Music } from "lucide-react";
import { useState } from "react";

/**
 * Starting and stopping a screen share.
 *
 * The choice of what the screen is for lives inside this button rather than
 * beside it. As a control of its own it was a bare pair of numbers sitting among
 * the microphone and the camera, and it could not answer either of the two
 * questions anybody would ask of it: whose setting is this, and which picture
 * does it govern. Nothing about a capsule reading "30 | 60" says screen, and
 * nothing says sending.
 *
 * Placed here, both answers are structural rather than written down. It is under
 * the screen button, so it is about the screen; it is on the controls for one's
 * own devices, so it is about what is being sent. Neither fact needs a label,
 * and a label would not have made them true.
 *
 * It also puts the question where the answer is known. Asked in advance it is a
 * setting to remember and get wrong later; asked at the moment of sharing, it is
 * the same question as which window to share, and somebody about to share a
 * terminal knows they are about to share a terminal.
 */
export function ShareButton({
	sharing,
	running,
	listening,
	onStart,
	onAdjust,
	onStop,
	onListen,
	onStopListening,
	lossless = true,
	losslessUnavailable,
	sendingLossless = false,
	onLossless = () => {},
}: {
	sharing: boolean;
	/**
	 * What the running share is actually sending, where something says.
	 *
	 * Shown in place of the menu's own choice while sharing, because the menu
	 * is no longer the only thing that changes a share: the hint that the line
	 * cannot carry it switches the setting from outside, and a menu still ticking
	 * the old one would be a menu describing a share nobody is sending. Not
	 * written down as the remembered choice either — the next share starts from
	 * what was chosen here, since what one afternoon's line could carry is not a
	 * thing to keep.
	 */
	running?: ShareSetting;
	/** Sound is being shared on its own, without a picture. */
	listening: boolean;
	/** Whether sound shared on its own is to be sent losslessly as well. */
	lossless?: boolean;
	/** Why it cannot be, where it cannot. */
	losslessUnavailable?: "encrypted" | "browser";
	/** Whether the sound being shared now is going out losslessly. */
	sendingLossless?: boolean;
	onLossless?: (on: boolean) => void;
	/** Share one app's or tab's sound and nothing else, to listen together. */
	onListen: () => void;
	onStopListening: () => void;
	/** Begin, in the manner chosen. */
	onStart: (frameRate: ShareFrameRate, quality: ShareQuality) => void;
	/**
	 * Change a share that is already running.
	 *
	 * Separate from onStart because it must not be onStart: publishing again
	 * would make the browser ask for the screen a second time, and somebody who
	 * has already chosen a window would be shown the picker for having adjusted
	 * a number — with the meeting watching them choose.
	 */
	onAdjust: (frameRate: ShareFrameRate, quality: ShareQuality) => void;
	onStop: () => void;
}) {
	const t = useT();

	// Before the early return below, and it has to stay there. A hook after a
	// conditional return is called on some renders and not others, and React
	// counts them: the render where sharing first becomes true finds fewer hooks
	// than the one before it and throws. The failure is not subtle — the button
	// crashes at the moment somebody starts sharing — but it is invisible to
	// anything that only renders the component once.
	const [quality, setQuality] = useState<ShareQuality>(rememberedQuality);
	const [frameRate, setFrameRate] = useState<ShareFrameRate>(rememberedFrameRate);

	// Everything below reads these rather than the state, so that a press
	// mid-share starts from what is being sent and not from what was last
	// picked here.
	const shown = sharing && running ? running : { quality, frameRate };

	const rates = ratesFor(shown.quality);
	const rate = rates.includes(shown.frameRate) ? shown.frameRate : (rates[rates.length - 1] ?? 30);

	// The rate a size can actually carry. Changing the size mid-share while
	// 240 was chosen would otherwise ask 4K for 240 frames a second, which the
	// menu already refuses to offer and which nothing else would catch.
	const clamp = (wanted: ShareFrameRate, size: ShareQuality): ShareFrameRate => {
		const allowed = ratesFor(size);

		return allowed.includes(wanted) ? wanted : (allowed[allowed.length - 1] ?? 30);
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{/* The same control either way, and it changes what it shows
				    rather than what it is. It used to become a plain stop button
				    the moment a share began, which settled the question of how to
				    stop and removed the only place the settings live — so a
				    picture that turned out too soft or too jerky could not be
				    fixed without stopping, reopening the picker, and choosing the
				    window again in front of everybody. */}
				<Button
					variant={sharing || listening ? "default" : "secondary"}
					size="round"
					aria-label={
						sharing ? t("Screen sharing settings") : listening ? t("Sharing sound") : t("Share your screen")
					}
					aria-pressed={sharing || listening}
					className={sharing || listening ? undefined : "text-fg-muted"}
				>
					{sharing ? <MonitorOff /> : listening ? <AudioLines /> : <MonitorUp />}
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="center" side="top" className="min-w-56">
				{/* The two settings first, because they are what somebody came to
				    change, and the button that starts the share last — pressing it
				    is the end of the errand rather than the middle of it. */}
				<DropdownMenuLabel>{t("Picture")}</DropdownMenuLabel>

				{SHARE_QUALITIES.map((option) => (
					<DropdownMenuCheckboxItem
						key={option}
						checked={shown.quality === option}
						onSelect={(event) => {
							// Kept open: this is a setting, and closing the menu would
							// make somebody reopen it to do the thing they came for.
							event.preventDefault();
							setQuality(option);
							rememberQuality(option);

							// Applied at once where there is something to apply it
							// to. A setting that takes effect on the next share is
							// a setting nobody can judge: the whole reason to
							// change it mid-share is that the picture in front of
							// you is wrong now.
							if (sharing) onAdjust(clamp(rate, option), option);
						}}
						className="flex-col items-start gap-0"
					>
						<span className="text-fg">{t(QUALITY_LABELS[option].label)}</span>
						<span className="text-fg-muted text-xs">{t(QUALITY_LABELS[option].describes)}</span>
					</DropdownMenuCheckboxItem>
				))}

				{/* Absent for automatic, which chooses the rate as well. A control
				    that did nothing would be a control somebody set and believed. */}
				{shown.quality !== "auto" && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>{t("Frames a second")}</DropdownMenuLabel>

						<div className="flex flex-wrap gap-1 px-2 pb-1.5">
							{rates.map((option) => (
								<button
									key={option}
									type="button"
									onClick={() => {
										setFrameRate(option);
										rememberFrameRate(option);
										if (sharing) onAdjust(option, shown.quality);
									}}
									className={cn(
										"rounded-md border px-2 py-1 text-[12px] tabular-nums transition-colors",
										option === rate
											? "border-tally/50 bg-tally/15 text-fg"
											: "border-border text-fg-muted hover:bg-surface-hi hover:text-fg",
									)}
								>
									{option}
								</button>
							))}
						</div>
					</>
				)}

				<DropdownMenuSeparator />

				{sharing ? (
					<DropdownMenuItem onSelect={onStop} className="gap-2">
						<MonitorOff className="size-4" />
						<span className="text-fg">{t("Stop sharing")}</span>
					</DropdownMenuItem>
				) : (
					<DropdownMenuItem onSelect={() => onStart(rate, quality)} className="gap-2">
						<MonitorUp className="size-4" />
						<span className="text-fg">{t("Share your screen")}</span>
					</DropdownMenuItem>
				)}

				{/* Sound on its own, to listen to something together. In this menu
				    because it is the same picker and the same kind of decision --
				    what of this machine everybody else gets -- and not offered while
				    the screen is shared, because a share already sends its sound
				    and two copies of one song a beat apart is nobody's idea of
				    listening together. */}
				{!sharing &&
					(listening ? (
						<DropdownMenuItem onSelect={onStopListening} className="items-start gap-2">
							<CircleStop className="mt-0.5 size-4" />
							<span className="flex flex-col">
								<span className="text-fg">{t("Stop sharing sound")}</span>
								{/* Which of the two is going out, because the switch that
								    chose it is not shown while it is: it takes effect when
								    the sharing starts, and a setting shown mid-share would
								    look as if changing it changed something. */}
								<span className="text-fg-muted text-xs">
									{t(sendingLossless ? "Lossless" : "Real time")}
								</span>
							</span>
						</DropdownMenuItem>
					) : (
						<>
							<DropdownMenuItem onSelect={onListen} className="items-start gap-2">
								<Music className="mt-0.5 size-4" />
								<span className="flex flex-col">
									<span className="text-fg">{t("Share only sound")}</span>
									<span className="text-fg-muted text-xs">{t("Pick the app or tab that is playing")}</span>
								</span>
							</DropdownMenuItem>

							{/* Beneath what it qualifies, and decided before the picker
							    opens rather than after. Off where it cannot work, with
							    the reason in place of the description, so nobody ticks
							    a box and gets real time without being told. */}
							<DropdownMenuCheckboxItem
								checked={lossless && !losslessUnavailable}
								disabled={losslessUnavailable !== undefined}
								onSelect={(event) => {
									event.preventDefault();
									onLossless(!lossless);
								}}
								className="flex-col items-start gap-0"
							>
								<span className="text-fg">{t("Lossless")}</span>
								<span className="text-fg-muted text-xs">
									{t(
										losslessUnavailable === "encrypted"
											? "Not available in an encrypted call"
											: losslessUnavailable === "browser"
												? "Not available in this browser"
												: "Every sample as it is played, about a second behind",
									)}
								</span>
							</DropdownMenuCheckboxItem>
						</>
					))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The sizes, in what somebody is choosing between rather than in pixels.
 *
 * The resolution is named because whoever is choosing is looking at a display
 * and knows what it is. What is worth saying beside it is the part they cannot
 * see: automatic is the only setting that will quietly send less, and every
 * other one is a promise to send what was asked for.
 */
const QUALITY_LABELS: Record<ShareQuality, { label: Phrase; describes: Phrase }> = {
	auto: { label: "Automatic", describes: "Adjusts to the connection" },
	"1080p": { label: "1080p", describes: "Up to 240 frames a second" },
	"1440p": { label: "1440p", describes: "Up to 120 frames a second" },
	"4k": { label: "4K", describes: "Up to 60 frames a second" },
};

