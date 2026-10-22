import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLingering } from "@/hooks/useLingering";
import { Phrased, useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { t as say } from "@/live/i18n";
import { actionFailed } from "@/live/notices";
import { ExternalLink, Loader2, MailCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { IOSOffer } from "./shelves";

type Outcome = "sent" | "already_invited";

/**
 * The iOS app, by TestFlight invitation to an address: the form and what came
 * of it.
 *
 * Somebody types an address and the server asks Apple to invite it, there and
 * then. What came of it stays on screen, because it is something to act on —
 * install TestFlight, open the mail — and a notice that faded would leave
 * somebody halfway through the App Store wondering what it said. What went
 * wrong with a press is a notice, as everywhere else, because it is over.
 *
 * Two answers change what is drawn rather than saying something: an account
 * that has used its invitations, and a server that turns out to have no key.
 * Both are still true after the notice would have gone, so they are drawn.
 *
 * One form wherever it appears — the iOS card on the download page, the row
 * that stands for it under another platform's card, and the page an
 * invitation opens for somebody signed in — so the three cannot come to say
 * different things about the same answer.
 */
export interface InviteProps {
	ios: IOSOffer;
	onChanged: (ios: IOSOffer) => void;
	onSignedOut: () => void;
}

export function Invite({ ios, onChanged, onSignedOut }: InviteProps) {
	const t = useT();
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<{ outcome: Outcome; email: string }>();
	const said = useLingering(done !== undefined);
	const [shown, setShown] = useState(done);

	// Kept while it leaves, so the words do not vanish before the box does.
	useEffect(() => {
		if (done) setShown(done);
	}, [done]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();

		if (busy) return;

		setBusy(true);
		setDone(undefined);

		try {
			const response = await fetch("/api/apps/ios/invite", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ email }),
			});

			const answer = (await response.json().catch(() => ({}))) as {
				result?: Outcome;
				left?: number;
				error?: string;
			};

			if (response.ok && answer.result) {
				setDone({ outcome: answer.result, email: email.trim() });
				setEmail("");
				onChanged({ ...ios, left: answer.left ?? ios.left });
				return;
			}

			switch (answer.error) {
				case "signed_out":
					onSignedOut();
					return;
				case "not_configured":
					onChanged({ ...ios, invites: false, left: 0 });
					return;
				case "too_many_addresses":
					onChanged({ ...ios, left: 0 });
					return;
			}

			actionFailed(refusal(answer.error));
		} catch {
			actionFailed(say("Something went wrong. Try again."));
		} finally {
			setBusy(false);
		}
	};

	const usedUp = ios.left <= 0;

	return (
		<>
			{usedUp ? (
				<p className="animate-arrive rounded-lg border border-border border-dashed px-3 py-2.5 text-[12px] text-fg-muted leading-snug">
					{t("This account has invited as many addresses as one account may.")}
				</p>
			) : (
				<>
					<p className="text-[11.5px] text-fg-muted leading-snug">
						{t("Apple emails an invitation to the address you give. Install TestFlight from the App Store first, then open the invitation on your iPhone or iPad.")}
					</p>

					{/*
					 * Not validated by the browser. Its own bubble speaks the
					 * browser's language rather than the page's, and says
					 * something different in each browser; the server's answer
					 * is said here in the reader's.
					 */}
					{/* Side by side where the field keeps room for the address,
					    and one above the other on the narrowest phones, where
					    the button took two thirds of the row and the field
					    could not show its own placeholder. */}
					<form noValidate onSubmit={submit} className="flex flex-col gap-2 min-[360px]:flex-row">
						<Input
							type="email"
							inputMode="email"
							autoComplete="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							placeholder={t("Email address")}
							aria-label={t("Email address")}
							maxLength={254}
							className="min-w-0 bg-surface-hi min-[360px]:flex-1"
						/>

						<Button type="submit" variant="secondary" disabled={busy || !email.trim()} className="shrink-0">
							{busy ? <Loader2 className="animate-spin" /> : t("Send invitation")}
						</Button>
					</form>

					<p className="text-[11px] text-fg-muted">
						{ios.left === 1
							? t("You can invite one more address.")
							: t("You can invite {count} more addresses.", { count: String(ios.left) })}
					</p>
				</>
			)}

			{said.mounted && shown && (
				<div
					role="status"
					className={cn(
						"flex items-start gap-2.5 rounded-lg bg-surface-hi px-3 py-2.5",
						said.leaving ? "animate-depart" : "animate-arrive",
					)}
				>
					<MailCheck className="mt-0.5 size-4 shrink-0 text-tally" />
					<p className="min-w-0 text-[12px] text-fg leading-snug [overflow-wrap:anywhere]">
						{shown.outcome === "sent" ? (
							<Phrased
								phrase="Sent to {email}. Install TestFlight first, then look in that inbox for the invitation."
								values={{ email: <span className="readout">{shown.email}</span> }}
							/>
						) : (
							<Phrased
								phrase="{email} was already invited. Install TestFlight, then look in that inbox for the invitation Apple sent."
								values={{ email: <span className="readout">{shown.email}</span> }}
							/>
						)}
					</p>
				</div>
			)}
		</>
	);
}

/** Apple's name for its beta service, which no language here translates. */
export const TESTFLIGHT = "TestFlight";

/**
 * The beta's public link, for whoever is not invited by address: somebody
 * holding an invitation who has no account, or an account on a deployment
 * that cannot invite anybody.
 *
 * A new tab rather than this one. The link opens TestFlight's own page, which
 * hands over to the TestFlight app, and the page that offered it is the one
 * somebody has to come back to — to join in the browser if they give up, or to
 * open the meeting in the app once it is installed.
 */
export function PublicLink({ link, prominent = false }: { link: string; prominent?: boolean }) {
	const t = useT();

	return (
		<>
			<a
				href={link}
				target="_blank"
				rel="noreferrer"
				className={cn(buttonVariants({ variant: "primary", size: prominent ? "lg" : "default" }), "w-full")}
			>
				{t("Get it on TestFlight")}
				<ExternalLink />
			</a>

			{/* Two sentences on two lines rather than one paragraph. As one, the
			    Chinese broke inside 安装 at 1280, since a line of Chinese may
			    break between any two characters and nothing kept the word
			    whole; a sentence to a line puts the break where a reader
			    pauses anyway. */}
			<p className="text-pretty text-[11.5px] text-fg-muted leading-snug">
				<span className="block">{t("TestFlight is Apple's app for trying apps before they are released.")}</span>
				<span className="block">{t("If it asks, install TestFlight from the App Store first.")}</span>
			</p>
		</>
	);
}

/*
 * Said at the moment a press fails rather than drawn, so it reads the language
 * as it is then through the plain translator, as the account page's own do.
 */

/** What an invitation could not be sent for, in the reader's language. */
function refusal(reason: string | undefined): string {
	switch (reason) {
		case "invalid_email":
			return say("That is not an email address.");
		case "rate_limited":
			return say("Too many attempts. Try again in a moment.");
		case "testflight_refused":
			return say("App Store Connect did not accept the invitation. Try again later.");
		default:
			return say("Something went wrong. Try again.");
	}
}
