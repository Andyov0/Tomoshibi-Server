import { Fragment } from "react";

/**
 * Only a complete URL, and only over http or https.
 *
 * Guessing at bare hosts turns "e.g. see chapter 3" into a link to a domain
 * nobody meant, and a false link is worse than a missed one: it is clickable,
 * it goes somewhere, and it looks deliberate. Somebody who wants a link pastes
 * one.
 *
 * Trailing punctuation is left out of the match, because a sentence ending in a
 * URL is written with a full stop after it and that stop is not part of the
 * address.
 */
const URLS = /\bhttps?:\/\/[^\s<>()[\]{}]+[^\s<>()[\]{}.,;:!?'"]/gi;

/**
 * Text with its links made clickable.
 *
 * The commonest thing anybody types during a call is an address, and until now
 * it arrived as characters to be copied out by hand.
 */
export function Linked({ text }: { text: string }) {
	const pieces: Array<string | { href: string }> = [];
	let at = 0;

	for (const match of text.matchAll(URLS)) {
		const start = match.index ?? 0;
		if (start > at) pieces.push(text.slice(at, start));

		pieces.push({ href: match[0] });
		at = start + match[0].length;
	}

	if (at < text.length) pieces.push(text.slice(at));

	return (
		<>
			{pieces.map((piece, index) =>
				typeof piece === "string" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: the pieces are positional
					<Fragment key={index}>{piece}</Fragment>
				) : (
					<a
						// biome-ignore lint/suspicious/noArrayIndexKey: the pieces are positional
						key={index}
						href={piece.href}
						target="_blank"
						// The room keeps running in this tab, so a link must never
						// navigate away from it, and the page it opens has no
						// business reaching back through `window.opener`.
						rel="noopener noreferrer"
						onClick={(event) => event.stopPropagation()}
						className="text-tally underline decoration-tally/40 underline-offset-2 hover:decoration-tally"
					>
						{piece.href}
					</a>
				),
			)}
		</>
	);
}
