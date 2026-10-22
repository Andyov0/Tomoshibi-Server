import { useLingering } from "@/hooks/useLingering";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { actionFailed } from "@/live/notices";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { api } from "./api";
import { Choice, Note } from "./OpeningCard";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";
import { size } from "./units";

/**
 * What this deployment relays of watching together.
 *
 * Three switches, each an exception a deployment whose file says to relay
 * nothing (meet.watch.direct_only) can make. One relays a film somebody who was
 * granted Emby picked; one relays YouTube for whoever cannot reach it, which in
 * practice is everybody watching from mainland China; and one relays Bilibili's
 * bangumi for everybody, since an episode's whole, and anything above 720p,
 * comes no other way. The first two start off and the third on, the owner's
 * choice (2026-10-14). Nothing else is relayed under any of them: Bilibili's
 * videos and pasted links play from where each viewer is. "Relay everything" is
 * not offered: that is the file's direct_only turned off, by somebody who meant
 * it, for the same reason that letting anybody open a room is the file's and not
 * a button's.
 *
 * A radio group for each rather than one group of every combination, because
 * the switches are independent, and a single group would have needed a row for
 * every combination and made turning one off a matter of finding which row
 * still held the others.
 *
 * Beside the cards for who may open and enter a room because it is the same
 * kind of decision. It goes on deciding after whoever made it has left, it
 * decides for everybody, and the Emby switch is the one place every grant can
 * be stopped at once without finding and unticking each person.
 *
 * The figures underneath are there because a switch alone says nothing about
 * cost. Emby on with nobody granted relays nothing; on with twelve people
 * granted is twelve people each able to put a film through the CDN for a whole
 * room. YouTube and bangumi have no grant to count, so what each has actually
 * carried since the server started is shown instead: they relay for everybody
 * who needs them, with nobody to withdraw them from but the switch.
 */
export function WatchCard({
	canSettings,
	onSignedOut,
}: {
	canSettings: boolean;
	onSignedOut: () => void;
}) {
	const t = useT();

	const [saving, setSaving] = useState(false);

	const { value, error, refresh } = usePoll(api.settings, { every: 30_000, onSignedOut });

	const failure = useRef(error);
	if (error) failure.current = error;

	// Who holds the grant, counted from the lists the other two panels draw.
	// Slowly: these change when somebody ticks a box, and the box is on another
	// panel.
	const { value: accounts } = usePoll(api.accounts, { every: 60_000, onSignedOut });
	const { value: admins } = usePoll(api.admins, { every: 60_000, onSignedOut });

	// Absent from a server older than the switch, which relays no YouTube.
	const youtube = value?.youtubeRelay ?? false;
	const youtubeSpent = value?.youtubeSpent ?? 0;
	// The same for bangumi: a server without the switch relays none, whatever
	// the switch starts as on one that has it.
	const bangumi = value?.bangumiRelay ?? false;
	const bangumiSpent = value?.bangumiSpent ?? 0;

	const choose = useCallback(
		async (which: "emby" | "youtube" | "bangumi", on: boolean) => {
			if (saving || !value) return;
			const now =
				which === "emby"
					? value.embyRelay
					: which === "youtube"
						? (value.youtubeRelay ?? false)
						: (value.bangumiRelay ?? false);
			if (now === on) return;

			setSaving(true);

			try {
				// One switch per request: the server changes only what a
				// request names, so the others stay where they are whatever
				// this page last read of them.
				await (which === "emby"
					? api.setEmbyRelay(on)
					: which === "youtube"
						? api.setYouTubeRelay(on)
						: api.setBangumiRelay(on));
				await refresh();
			} catch (err) {
				// The switch stays where it was, because nothing moved. Said the
				// way every other press that did not take is said here.
				actionFailed(err instanceof Error ? err.message : String(err));
			} finally {
				setSaving(false);
			}
		},
		[refresh, saving, value],
	);

	// Counted as the relay counts them: a grant on an account that is blocked,
	// or that may not watch together at all, relays nothing — the server holds
	// a blocked account to nothing, and every film is picked through watching
	// together — and counted, it said a switch was costing something while
	// nothing could be spent, and hid the sentence saying so.
	const granted = (accounts ?? []).filter(
		(one) => one.effective?.emby && one.effective?.watch && !one.blocked,
	).length;
	const grantedAdmins = (admins ?? []).filter((one) => one.effective?.emby).length;

	// What the switches are set against. Without a gateway there is nothing to
	// relay, and where the file relays everything the switches hold nothing
	// back; either way the radios still say what is stored, and these say
	// why it does not matter.
	const noGateway = value !== undefined && !value.configured;
	const relaysAll = value !== undefined && value.configured && !value.directOnly;
	const idle = value !== undefined && value.embyRelay && accounts !== undefined && granted + grantedAdmins === 0;
	// What stays unrelayed whatever any switch says, said once for all: it
	// used to ride on the Emby answer's own sentence, which became untrue the
	// moment YouTube had a switch of its own, and then said Bilibili was never
	// relayed, which became untrue when its bangumi had one.
	const neverRelayed = value !== undefined && value.configured && value.directOnly;

	const locked = !canSettings || saving || !value || noGateway;

	return (
		<Card title={t("Watching together")} note={t("What this deployment relays")}>
			{/* The last failure kept while it fades, for the reason the
			    accounts page keeps its banner: by then the poll has answered and
			    the message has gone, and a box leaving empty flickers. */}
			<Said show={error !== undefined}>
				<Failed>{failure.current}</Failed>
			</Said>

			<div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
				<Group heading={t("Emby films")}>
					<Choice
						label={t("Relay no Emby films")}
						describes={t("Films from Emby cannot play, since they come only through the relay.")}
						chosen={value !== undefined && !value.embyRelay}
						disabled={locked}
						onChoose={() => void choose("emby", false)}
					/>
					<Choice
						label={t("Relay Emby films picked by granted people")}
						describes={t("A film picked from Emby by somebody granted it is relayed to everybody in the room.")}
						chosen={value?.embyRelay ?? false}
						disabled={locked}
						onChoose={() => void choose("emby", true)}
					/>
				</Group>

				{/* Who could spend it, read as a pair of figures rather than a
				    sentence with a number in it: a plural that is a different word
				    in English and the same word in Japanese is a sentence that can
				    only be assembled in English. */}
				<Said show={accounts !== undefined || admins !== undefined}>
					<p className="readout flex flex-col gap-0.5 text-[11.5px] text-fg-muted">
						<span>{t("Accounts granted Emby: {count}", { count: granted })}</span>
						<span>{t("Administrators granted Emby: {count}", { count: grantedAdmins })}</span>
					</p>
				</Said>

				<Said show={idle}>
					<Note kind="quiet">{t("Nobody is granted Emby yet, so no film is relayed.")}</Note>
				</Said>

				<Group heading={t("YouTube")}>
					<Choice
						label={t("Play YouTube from where each viewer is")}
						describes={t("Somebody who cannot reach YouTube, as in mainland China, does not see it, and is told so.")}
						chosen={value !== undefined && !youtube}
						disabled={locked}
						onChoose={() => void choose("youtube", false)}
					/>
					<Choice
						label={t("Relay YouTube for viewers who cannot reach it")}
						describes={t(
							// Both halves, because both happen: a viewer who came in
							// through a mainland relay is relayed at once, without
							// YouTube being tried (WatchScreen, straightToRelay) — and
							// that includes one whose own proxy would have reached it.
							"Whoever cannot reach YouTube, and whoever came in through a relay in mainland China, is given it through this deployment instead, sized to their player. Nobody needs a grant for it.",
						)}
						chosen={youtube}
						disabled={locked}
						onChoose={() => void choose("youtube", true)}
					/>
				</Group>

				{/* While it is on, and after, for as long as there is a figure: a
				    switch turned off a minute ago has still spent what it spent. */}
				<Said show={youtube || youtubeSpent > 0}>
					<p className="readout text-[11.5px] text-fg-muted">
						{t("{size} relayed since restart", { size: size(youtubeSpent) })}
					</p>
				</Said>

				<Group heading={t("Bilibili bangumi")}>
					<Choice
						label={t("Relay no bangumi")}
						describes={t(
							// Not "plays at 360p": a gateway reading bangumi for the
							// relay hands out no address a page could play instead,
							// so with this off every episode is one that cannot be
							// played here, and the sentence says so.
							"Bangumi episodes cannot be played: a whole episode, and anything above 720p, comes only through the relay.",
						)}
						chosen={value !== undefined && !bangumi}
						disabled={locked}
						onChoose={() => void choose("bangumi", false)}
					/>
					<Choice
						label={t("Relay bangumi for everybody")}
						describes={t(
							"Every viewer plays Bilibili's series and films through this deployment, members' episodes whole and up to 4K, sized to their player. Nobody needs a grant for it.",
						)}
						chosen={bangumi}
						disabled={locked}
						onChoose={() => void choose("bangumi", true)}
					/>
				</Group>

				<Said show={bangumi || bangumiSpent > 0}>
					<p className="readout text-[11.5px] text-fg-muted">
						{t("{size} relayed since restart", { size: size(bangumiSpent) })}
					</p>
				</Said>

				<Said show={neverRelayed}>
					<Note kind="quiet">
						{t("Bilibili videos and pasted links are never relayed: they play from where each viewer is.")}
					</Note>
				</Said>

				<Said show={noGateway}>
					<Note kind="quiet">
						{t("This deployment has no watch-together gateway, so this does nothing.")}
					</Note>
				</Said>

				<Said show={relaysAll}>
					<Note kind="warn">
						{t(
							"The configuration file relays every video (meet.watch.direct_only is off), so these switches change nothing until that is turned on. Emby films still need the grant.",
						)}
					</Note>
				</Said>

				{!canSettings && <Note kind="quiet">{t("You can view this but not change it.")}</Note>}
			</div>
		</Card>
	);
}

/**
 * One switch's answers, under a heading that names what they are about.
 *
 * The heading is the group's accessible name as well, so a screen reader hears
 * "YouTube" before "Relay … for viewers who cannot reach it" rather than two
 * radio groups both called what this deployment relays.
 */
function Group({ heading, children }: { heading: string; children: ReactNode }) {
	return (
		<div role="radiogroup" aria-label={heading} className="flex flex-col">
			<p aria-hidden className="px-3 pb-1 font-medium text-[10.5px] text-fg-muted uppercase tracking-[0.08em]">
				{heading}
			</p>
			{children}
		</div>
	);
}

/** A note that is there while it is true, and fades either way. */
function Said({ show, children }: { show: boolean; children: ReactNode }) {
	const { mounted, leaving } = useLingering(show, 160);
	if (!mounted) return null;

	return <div className={cn(leaving ? "animate-fade-out" : "animate-fade-in")}>{children}</div>;
}
