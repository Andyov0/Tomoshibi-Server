import { useAppearance } from "@/hooks/useAppearance";
import { useLingering } from "@/hooks/useLingering";
import { useMeasure } from "@/hooks/useMeasure";
import { useT } from "@/hooks/useT";
import { locale } from "@/live/i18n";
import { type Door, PATIENCE, type Turnstile, languageFor, loadTurnstile, siteKey } from "@/live/turnstile";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import {
	type MutableRefObject,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

/**
 * What a sign-in form needs of the human check.
 *
 * `ready` is whether the form may be sent as far as the check is concerned:
 * once the deployment has said there is no check, or once the widget has handed
 * over a token. The submit button waits on it, grey, so that a press cannot
 * reach the server without the one thing it is about to be refused for.
 * `token` goes in the body, `widget` goes in the form, and `reset` is called
 * after every refused attempt, because a token is good once and the one just
 * sent was spent whether the passphrase was right or not.
 *
 * `className` is for the widget's own space, for a form whose children each
 * carry their entrance (the front page's rise in turn).
 */
export interface HumanCheck {
	ready: boolean;
	token: string;
	reset: () => void;
	widget: ReactNode;
}

export function useHumanCheck(door: Door, className?: string): HumanCheck {
	// Undefined while the deployment is being asked, empty where it asks for
	// no check.
	const [key, setKey] = useState<string>();
	const [token, setToken] = useState("");
	const resetting = useRef<() => void>(undefined);
	const live = useRef(true);

	useEffect(() => {
		live.current = true;
		void siteKey().then((said) => live.current && setKey(said));
		return () => {
			live.current = false;
		};
	}, []);

	const reset = useCallback(() => {
		setToken("");
		resetting.current?.();

		// And the deployment asked again, where the page was told of no
		// widget. siteKey forgets an asking that failed, so this is a second
		// question only where the first had no answer: a page that could not
		// reach /api/deployment when it loaded showed no widget, and the
		// server's refusal for want of a token is the moment to find out there
		// is one. Where the answer was had, it is the same answer again.
		void siteKey().then((said) => live.current && setKey(said));
	}, []);

	return {
		ready: key === "" || (key !== undefined && token !== ""),
		token,
		reset,
		widget: key ? (
			<Widget siteKey={key} door={door} onToken={setToken} resetting={resetting} className={className} />
		) : null,
	};
}

/**
 * The flexible widget is a hundred per cent wide and never narrower than this,
 * so a column narrower than this takes the compact one instead. A sign-in on a
 * 320-pixel phone is 272 to 288 pixels wide inside its gutters, and a widget
 * three hundred wide there is twelve to twenty-eight pixels of it cut off by
 * the page's overflow.
 */
const FLEXIBLE_MIN = 300;

/** The heights Cloudflare draws each size at, held open before it draws. */
const HEIGHT = { flexible: 65, compact: 140 } as const;

/**
 * How wide the compact widget is drawn. The line saying the check is coming
 * is kept inside it, so that the widget covers all of it once it draws.
 */
const COMPACT_WIDTH = 150;

/**
 * How long the script may take before the space says it is coming.
 *
 * Not at once: from most places Cloudflare's script is drawn inside this, and
 * a line that flickers up and away on every load is one more thing moving on
 * a form that should be still. Past it, the empty space needs a reason, since
 * from mainland China the script can take many seconds and a blank where a
 * box should be, over a grey button, reads as a page that broke.
 */
const QUIET = 700;

function Widget({
	siteKey,
	door,
	onToken,
	resetting,
	className,
}: {
	siteKey: string;
	door: Door;
	onToken: (token: string) => void;
	resetting: MutableRefObject<(() => void) | undefined>;
	className?: string;
}) {
	const t = useT();
	const theme = useAppearance() === "day" ? "light" : "dark";
	const language = languageFor(locale());

	const [measureColumn, column] = useMeasure();
	const [measureInside, inside] = useMeasure();
	const size = column.width > 0 && column.width < FLEXIBLE_MIN ? "compact" : "flexible";
	const placed = column.width > 0;

	const root = useRef<HTMLDivElement | null>(null);
	const place = useCallback(
		(element: HTMLDivElement | null) => {
			root.current = element;
			return measureColumn(element);
		},
		[measureColumn],
	);

	const host = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"loading" | "drawn" | "unreachable">("loading");
	// Whether Cloudflare's frame has said anything since the widget was drawn.
	//
	// Drawn is only Cloudflare's script having put an empty frame in the
	// page; the frame then loads the challenge from Cloudflare's servers,
	// which is a second request that can fail where the first did not. From
	// mainland China the script can arrive, from a cache or a path that
	// works, while the challenge does not, and then nothing at all happens: a
	// review blocked the challenge alone and watched for forty seconds, and
	// Cloudflare called none of the widget's callbacks, error or timeout
	// included, while the form showed a blank and a grey button. Whatever the
	// frame says first — a token, an error it shows in itself, a challenge to
	// press, a browser it cannot work in — is the frame having arrived.
	const [heard, setHeard] = useState(false);
	// Bumped by "Try again", which is the one thing that should load the
	// script again after it failed.
	const [attempt, setAttempt] = useState(0);

	// Drawn again whenever what it is drawn with changes: the size, when a
	// phone turns; the theme, when the page goes from day to night; the
	// language, when somebody picks another. A widget cannot be told any of
	// these after it is drawn, so it is removed and drawn afresh, and the token
	// it held goes with it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the trigger for trying again
	useEffect(() => {
		if (!placed) return;

		let gone = false;
		let drawn: { api: Turnstile; id: string } | undefined;

		onToken("");
		setState("loading");
		setHeard(false);

		const arrived = () => {
			if (!gone) setHeard(true);
		};

		loadTurnstile()
			.then((api) => {
				const container = host.current;
				if (gone || !container) return;

				const id = api.render(container, {
					sitekey: siteKey,
					action: door,
					theme,
					language,
					size,
					// Handled here rather than by the widget, so that an expired
					// token is taken out of the form the moment it expires and a
					// fresh challenge started, the same as after a refusal.
					"refresh-expired": "never",
					callback: (token: string) => {
						arrived();
						onToken(token);
					},
					"expired-callback": () => {
						onToken("");
						api.reset(id);
					},
					"timeout-callback": () => {
						onToken("");
						api.reset(id);
					},
					// The widget retries by itself after an error; what this has to
					// do is stop the form offering a token it no longer holds.
					"error-callback": () => {
						arrived();
						onToken("");
					},
					"before-interactive-callback": arrived,
					"unsupported-callback": arrived,
				});

				if (!id) {
					setState("unreachable");
					return;
				}

				drawn = { api, id };
				resetting.current = () => api.reset(id);
				setState("drawn");
			})
			.catch(() => {
				if (!gone) setState("unreachable");
			});

		return () => {
			gone = true;
			resetting.current = undefined;
			if (drawn) drawn.api.remove(drawn.id);
		};
	}, [placed, siteKey, door, theme, language, size, onToken, resetting, attempt]);

	// A frame that has said nothing for as long as the script is given to
	// arrive is said to be unreachable, as the script is, with the same way to
	// try again. The widget is left where it is, out of sight, so that a frame
	// that was only slow and speaks after all puts the form back as it would
	// have been; "Try again" draws a fresh one.
	const [stalled, setStalled] = useState(false);
	useEffect(() => {
		setStalled(false);
		if (state !== "drawn" || heard) return;

		const timer = setTimeout(() => setStalled(true), PATIENCE);
		return () => clearTimeout(timer);
	}, [state, heard]);

	const shown = state === "drawn" && !stalled;
	const failed = useLingering(state === "unreachable" || stalled, 180);
	// The sentence is in the column only while it is arriving or staying; on
	// its way out it is laid over the widget's space, which has already opened
	// again beneath it, so that the column changes height once, smoothly,
	// rather than once for the widget and again when the sentence goes.
	const failing = failed.mounted && !failed.leaving;

	// Coming while the script is on its way, and while the frame it drew has
	// said nothing. The line sits under the widget rather than over it: a
	// frame that has arrived covers it, so it is seen only over an empty
	// space, and a frame still loading behind it is not hidden by it.
	const coming = (state === "loading" || (state === "drawn" && !heard)) && !stalled;

	const [slow, setSlow] = useState(false);
	useEffect(() => {
		setSlow(false);
		if (!coming) return;

		const timer = setTimeout(() => setSlow(true), QUIET);
		return () => clearTimeout(timer);
	}, [coming]);
	const waiting = useLingering(coming && slow, 160);

	// The gap the form puts between its children, which this cancels while it
	// is closed.
	//
	// The space is a child of a column with a gap, and the gap above a child
	// is there whatever the child's height: opened from nothing, the space
	// still put the gap under the field at once, and the button jumped by it
	// in one frame before the height began to move — eight pixels on the
	// account page and twelve on the management one, wherever /api/deployment
	// answered after the form had finished arriving. A negative margin of the
	// same size while closed makes the space exactly nothing, and it opens
	// with the height. Read from the parent, so that each form's own gap is
	// the one cancelled; before paint, so that no frame shows it.
	const [gap, setGap] = useState(0);
	useLayoutEffect(() => {
		const parent = root.current?.parentElement;
		if (!parent) return;

		const said = Number.parseFloat(getComputedStyle(parent).rowGap);
		setGap(Number.isFinite(said) ? said : 0);
	}, []);

	// Opened from nothing two frames after it arrives, so that the closed
	// space has been drawn once and the browser has something to move from.
	const [opened, setOpened] = useState(false);
	useEffect(() => {
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => setOpened(true));
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	return (
		<div
			ref={place}
			data-human-check-space=""
			className={cn(
				"w-full overflow-hidden duration-300 ease-[var(--ease-settle)] motion-reduce:transition-none",
				// The margin is moved only once the space opens. Measuring the
				// column on arrival makes the browser style the space before the
				// gap is known, with no margin; moved from there, the cancelling
				// margin arrived over three frames and the button dropped by the
				// gap and climbed back, which is the jump this exists to prevent.
				opened ? "transition-[height,margin-top]" : "transition-[height]",
				className,
			)}
			// The whole of what is inside, measured, and moved to rather than
			// jumped to: the widget's space, the sentence that replaces it when
			// Cloudflare cannot be reached, and either of them going. Every
			// change of what is shown here is a change of this one height, so
			// the button under it slides whichever way it goes.
			style={{ height: opened ? inside.height : 0, marginTop: opened ? 0 : -gap }}
		>
			<div ref={measureInside} className="relative">
				<div className="relative" style={{ height: failing ? 0 : HEIGHT[size] }}>
					{/*
					 * Before the widget in the page, and positioned like it, so
					 * that the widget is drawn over it.
					 */}
					{waiting.mounted && (
						<div
							role="status"
							className={cn(
								"pointer-events-none absolute inset-0 flex items-center justify-center",
								waiting.leaving ? "animate-fade-out" : "animate-fade-in",
							)}
						>
							<div
								className={cn(
									"flex items-center justify-center gap-2 text-center text-[13px] text-fg-muted",
									size === "compact" && "flex-col",
								)}
								style={size === "compact" ? { maxWidth: COMPACT_WIDTH } : undefined}
							>
								<Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
								{t("Loading the human check…")}
							</div>
						</div>
					)}

					{/*
					 * Cloudflare's to draw into, at the height it draws, and faded
					 * in once it has.
					 */}
					<div
						ref={host}
						data-human-check={stalled ? "stalled" : state}
						aria-hidden={state === "unreachable" || stalled || undefined}
						className={cn(
							"relative flex h-full justify-center transition-opacity duration-300 ease-[var(--ease-settle)] motion-reduce:transition-none",
							// The flexible widget is the column's width; only the
							// compact one has a width of its own to be centred at.
							size === "flexible" && "[&>*]:w-full",
							shown ? "opacity-100" : "opacity-0",
						)}
					/>
				</div>

				{failed.mounted && (
					<div
						role="status"
						className={cn(
							"flex flex-col items-center gap-2 py-2 text-center",
							failed.leaving ? "absolute inset-x-0 top-0 animate-fade-out" : "animate-fade-in",
						)}
					>
						<p className="text-[13px] text-fg-muted">
							{t("The human check can't be reached right now. Try again later.")}
						</p>
						<button
							type="button"
							onClick={() => setAttempt((was) => was + 1)}
							className="pressable rounded-[10px] px-3 py-1.5 text-[13px] text-fg outline-none hover:bg-wash focus-visible:ring-2 focus-visible:ring-fg/70 active:bg-wash-press"
						>
							{t("Try again")}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
