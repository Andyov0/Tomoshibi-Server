import { useT } from "@/hooks/useT";
import { type Policy, api } from "./api";
import { words } from "./OpeningCard";
import { usePoll } from "./poll";
import { Card, Failed } from "./Shell";

/**
 * What the process is actually running with.
 *
 * What it resolved to, not what the file says. More than one afternoon has gone
 * into working out whether a setting took effect — reading the source of the
 * thing that consumes it to find out that one field is quietly overwritten by
 * another. The process knows. It may as well answer.
 *
 * The API key is here and the secret is not. The key names which credential is
 * in use, which is the question anybody has; the secret signs tokens for every
 * room on this deployment, and no page is a reason to put that on a screen.
 */
export function RuntimePanel({ onSignedOut }: { onSignedOut: () => void }) {
	const t = useT();

	// Once a minute. This changes when somebody restarts the server, and not
	// otherwise.
	const { value, error } = usePoll(api.runtime, { every: 60_000, onSignedOut });

	return (
		<div className="mx-auto grid max-w-4xl gap-4">
			{error && <Failed>{error}</Failed>}

			<Card title={t("Application")}>
				<Rows values={value?.meet} />
			</Card>

			<Card title={t("Media")} note={t("What clients are told to dial")}>
				<Rows values={value?.rtc} />
			</Card>

			<Card title={t("Rooms")} note={t("Who can start one")}>
				<Opening policy={value?.rooms} />
			</Card>

			<Card title={t("Codecs")}>
				<p className="readout px-4 py-3 text-[12px] text-fg-muted">
					{value?.codecs.join("  ·  ") ?? "—"}
				</p>
			</Card>

			<Card title={t("Credentials")} note={t("The secret is never shown")}>
				<Rows values={value?.credentials} />
			</Card>
		</div>
	);
}

/**
 * The one setting on this server that a configuration file no longer decides.
 *
 * Given three lines rather than one because the interesting readings are the
 * disagreements. A file edited after first run is obeyed by nothing and looks
 * exactly like a file that is; a policy naming administrators on a deployment
 * that has none is a rule nothing can satisfy and looks exactly like a rule in
 * force. Both are silent, and this panel exists for the settings whose real
 * value is not the one somebody wrote down.
 */
function Opening({ policy }: { policy?: Policy }) {
	if (!policy) return <p className="px-4 py-3 text-fg-muted text-xs">—</p>;

	return (
		<Rows
			values={{
				"in effect": words(policy.openedBy),
				chosen: words(policy.chosen),
				configured: words(policy.configured),
			}}
		/>
	);
}

function Rows({ values }: { values?: Record<string, unknown> }) {
	if (!values) return <p className="px-4 py-3 text-fg-muted text-xs">—</p>;

	return (
		// Name above value while narrow, beside it once there is room. A label
		// column of nine rems leaves under two hundred points for a value on a
		// phone, and the values here are addresses and lists.
		<dl className="grid gap-x-4 sm:grid-cols-[minmax(9rem,auto)_1fr]">
			{Object.entries(values).map(([name, value]) => (
				<div key={name} className="contents">
					<dt className="px-3 pt-2 text-fg-muted text-xs sm:border-border sm:border-b sm:px-4 sm:py-2">
						{name}
					</dt>
					<dd className="readout border-border border-b px-3 pt-0.5 pb-2 text-[12px] tabular-nums sm:px-4 sm:py-2">
						{show(value)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function show(value: unknown): string {
	if (value === "" || value === null || value === undefined) return "—";
	if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
	if (typeof value === "boolean") return value ? "true" : "false";

	// A setting that is a group of settings, which meet.watch is: whether there
	// is a gateway, whether the file relays nothing, and whether the switch in
	// the store relays Emby anyway. One line of name and value pairs, in the
	// file's own words, because String() of an object is "[object Object]" and
	// that is what this row said the first time it was sent.
	if (typeof value === "object") {
		const pairs = Object.entries(value as Record<string, unknown>);

		return pairs.length === 0 ? "—" : pairs.map(([name, one]) => `${name} ${show(one)}`).join("  ·  ");
	}

	return String(value);
}
