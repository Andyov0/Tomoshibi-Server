import { useT } from "@/hooks/useT";
import { locale } from "@/live/i18n";
import { Button } from "@/components/ui/button";
import type { Said } from "@/live/chat";
import { cn } from "@/lib/utils";
import { ArrowUp, MessageSquareOff, X } from "lucide-react";
import { Linked } from "./Linked";
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
	onClose,
}: {
	said: Said[];
	onSay: (body: string) => Promise<unknown>;
	/** A message is in flight. */
	sending?: boolean;
	/** The connection is down, so nothing can leave. */
	offline?: boolean;
	onClose: () => void;
}) {
	const t = useT();
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
			className={cn(
				"absolute z-20 flex flex-col overflow-hidden border border-border",
				"bg-surface/95 shadow-2xl backdrop-blur-md",
				// A sheet up the bottom edge while narrow. As a card it is
				// sixteen and a half rems wide, which is two thirds of a phone,
				// and it is anchored lower than the controls — so it covers them.
				// Nothing about it is wrong on a laptop; it was never asked this.
				"inset-x-0 bottom-0 h-[55%] rounded-t-2xl",
				// Room for the controls, which float over this sheet's bottom
				// edge rather than beside it. Without this, the box somebody types in
				// sits underneath them.
				"pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:pb-0",
				// A card again once there is room beside the pictures.
				"sm:inset-x-auto sm:right-3 sm:bottom-3 sm:h-auto sm:w-66 sm:rounded-xl sm:pb-0",
				"sm:max-h-[min(26rem,calc(100%-5.5rem))]",
			)}
		>
			<header className="flex items-center justify-between border-border border-b px-3 py-2">
				<strong className="font-semibold text-[12.5px]">{t("Messages")}</strong>
				<Button variant="ghost" size="icon" className="size-6" aria-label={t("Close messages")} onClick={onClose}>
					<X className="size-3.5" />
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
									<span className="flex items-baseline gap-1.5 font-medium text-[11.5px]">
										{/* Through the same phrase the tile uses. It was written out
										    in English here, the one place in the call that
										    never changed language. */}
										{one.mine ? t("{name} (you)", { name: one.name }) : one.name}
										<span className="readout text-[9.5px] text-fg-muted">{clock(one.at)}</span>
									</span>
								)}
								{/* Somebody's words, so they are theirs to take away. A
								    call is furniture and is not selectable for it; this
								    is the one thing in one that is prose. */}
								<span className="select-text break-words text-[12.5px] leading-normal">
									<Linked text={one.body} />
								</span>
							</div>
						);
					})}
				</div>
			)}

			<div className="m-3 flex items-end gap-2 rounded-lg border border-border bg-white/2 px-2.5 py-1.5">
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
						"flex-1 resize-none bg-transparent py-1 text-[12.5px] text-fg outline-none",
						"placeholder:text-fg-muted",
					)}
				/>

				<Button
					size="icon"
					className="size-6 shrink-0 rounded-md"
					aria-label={t("Send")}
					disabled={!draft.trim() || sending || offline}
					onClick={send}
				>
					<ArrowUp className="size-3" />
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
			<MessageSquareOff className="size-6 text-border" />
			<p className="max-w-[24ch] text-[11.5px] text-fg-muted leading-relaxed">
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
