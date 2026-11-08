import { useT } from "@/hooks/useT";
import { locale } from "@/live/i18n";
import { Button } from "@/components/ui/button";
import type { Said } from "@/live/chat";
import { cn } from "@/lib/utils";
import { ArrowUp, MessageSquareOff, X } from "lucide-react";
import { Linked } from "./Linked";
import { usePanel } from "@/hooks/usePanel";
import { useEffect, useRef, useState } from "react";

/**
 * Everything said this call.
 *
 * Floats over the room rather than pushing it aside. Pushing looks considerate
 * until you try it: the grid is computed from its container, so opening the
 * panel moves and resizes every tile at once because one person wanted to type.
 * Covering one corner is the smaller disturbance, and it is reversible in a way
 * a relayout is not.
 */
export function ChatPanel({
	said,
	onSay,
	sending,
	offline,
	leaving = false,
	onClose,
}: {
	said: Said[];
	onSay: (body: string) => Promise<unknown>;
	/** A message is in flight. */
	sending?: boolean;
	/** The connection is down, so nothing can leave. */
	offline?: boolean;
	/** On its way out; see useLingering. */
	leaving?: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const panel = usePanel(onClose);
	const [draft, setDraft] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	const log = useRef<HTMLDivElement>(null);

	useEffect(() => field.current?.focus(), []);

	// Stay at the newest. A conversation is read from where it left off.
	useEffect(() => {
		const view = log.current;
		if (view) view.scrollTop = view.scrollHeight;
	}, [said.length]);

	const send = () => {
		const body = draft.trim();
		if (!body || sending || offline) return;

		// Cleared optimistically and put back if it did not leave. Losing what
		// somebody typed is worse than showing it twice, and a send that failed
		// silently looks exactly like one that worked.
		setDraft("");
		onSay(body).catch(() => setDraft(body));
	};

	return (
		<aside
			ref={panel}
			aria-label={t("Messages")}
			className={cn(
				"absolute z-20 flex flex-col overflow-hidden border border-border",
				// Opaque: what is in it is what people wrote, and words over a
				// moving picture change contrast while they are being read. The
				// blurred material is for the controls that float, not for this.
				"bg-surface shadow-2xl",
				leaving ? "max-sm:animate-sheet-leave sm:animate-depart" : "max-sm:animate-sheet sm:animate-arrive",
				"sm:origin-bottom-right",
				// A sheet up the bottom edge while narrow. As a card it is
				// sixteen and a half rems wide, which is two thirds of a phone,
				// and it is anchored lower than the controls — so it covers them.
				// Nothing about it is wrong on a laptop; it was never asked this.
				"inset-x-0 bottom-0 h-[55%] rounded-t-[22px] border-x-0 border-b-0",
				// Room for the controls, which float over this sheet's bottom
				// edge rather than beside it. Without this, the box somebody types in
				// sits underneath them.
				"pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:pb-0",
				// A card again once there is room beside the pictures.
				"sm:inset-x-auto sm:right-3 sm:bottom-3 sm:h-auto sm:w-72 sm:rounded-[22px] sm:border-x sm:border-b sm:pb-0",
				"sm:max-h-[min(26rem,calc(100%-5.5rem))]",
			)}
		>
			<header className="flex items-center justify-between border-border border-b py-1.5 pr-1.5 pl-4">
				<strong className="font-semibold text-[14px]">{t("Messages")}</strong>
				{/* Thirty-two for a cursor, forty-four for a finger. It was twenty-
				    four, with a fourteen-pixel cross in it, in the corner of a
				    sheet that a phone can close no other way. */}
				<Button
					variant="ghost"
					size="icon"
					className="size-8 rounded-full text-fg-muted hover:text-fg pointer-coarse:size-11"
					aria-label={t("Close messages")}
					onClick={onClose}
				>
					<X />
				</Button>
			</header>

			{said.length === 0 ? (
				<Empty />
			) : (
				<div ref={log} className="flex flex-1 flex-col justify-end gap-2.5 overflow-y-auto p-3">
					{said.map((one, index) => {
						// A run from one person drops the name: the column is
						// narrow and repeating it says nothing new.
						const run = index > 0 && said[index - 1]?.from === one.from;

						return (
							<div key={one.id} className={cn("flex flex-col gap-0.5", run && "-mt-2")}>
								{!run && (
									<span className="flex items-baseline gap-1.5 font-medium text-[12px]">
										{/* Through the same phrase the tile uses. It was written out
										    in English here, the one place in the call that
										    never changed language. */}
										{one.mine ? t("{name} (you)", { name: one.name }) : one.name}
										<span className="readout text-[10.5px] text-fg-muted">{clock(one.at)}</span>
									</span>
								)}
								{/* Somebody's words, so they are theirs to take away. A
								    call is furniture and is not selectable for it; this
								    is the one thing in one that is prose. */}
								<span className="select-text break-words text-[13.5px] leading-normal">
									<Linked text={one.body} />
								</span>
							</div>
						);
					})}
				</div>
			)}

			{/* A well rather than an outline: the raised grey that every field
			    inside a surface wears, which is visible in either appearance.
			    The faint white wash it had was nothing at all on a white panel. */}
			<div className="m-3 flex items-end gap-2 rounded-xl bg-surface-hi py-1.5 pr-1.5 pl-3 focus-within:ring-2 focus-within:ring-fg/25">
				<textarea
					ref={field}
					rows={1}
					value={draft}
					disabled={offline}
					placeholder={offline ? t("Reconnecting…") : t("Say something")}
					aria-label={t("Say something")}
					maxLength={2000}
					onChange={(event) => {
						setDraft(event.target.value);
						// Grows with the message and stops: past a few lines this
						// is a document, and a call is not where one gets written.
						event.target.style.height = "auto";
						event.target.style.height = `${Math.min(event.target.scrollHeight, 96)}px`;
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							send();
						}
					}}
					className={cn(
						"flex-1 resize-none bg-transparent py-1 text-[13.5px] text-fg outline-none",
						// Sixteen where a finger types it. Safari on a phone zooms
						// the whole page in on a field set any smaller, and leaves
						// the call zoomed after the message is sent.
						"pointer-coarse:py-2.5 pointer-coarse:text-base",
						"placeholder:text-fg-muted",
					)}
				/>

				<Button
					variant="primary"
					size="icon"
					className="size-7 shrink-0 rounded-full pointer-coarse:size-11 [&_svg]:size-3.5 pointer-coarse:[&_svg]:size-4"
					aria-label={t("Send")}
					disabled={!draft.trim() || sending || offline}
					onClick={send}
				>
					<ArrowUp className="stroke-[2.5]" />
				</Button>
			</div>
		</aside>
	);
}

/**
 * Nothing has been said yet.
 *
 * The empty state carries the one fact somebody needs before they type: this is
 * not written down anywhere. Whether that is true and whether it looks true are
 * different things, and only the second one stops a person posting something
 * they would rather not leave behind.
 */
function Empty() {
	const t = useT();

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
			<MessageSquareOff className="size-6 text-fg-muted/60" />
			<p className="max-w-[24ch] text-[12.5px] text-fg-muted leading-relaxed">
				{t("Messages disappear when the call ends.")}
			</p>
		</div>
	);
}

/**
 * Wall-clock time, to the minute: seconds are noise in a conversation.
 *
 * Formatted for the language in use rather than for the system, and without an
 * opinion about the twelve-hour clock. Whether a time reads as 14:30 or 2:30 PM
 * is a regional habit, and forcing one on somebody is a decision that was never
 * this application's to make.
 */
function clock(at: number): string {
	return new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}
