import { type Phrase, locale, phraseSegments, subscribe, t } from "@/live/i18n";
import { Fragment, type ReactNode } from "react";
import { useSyncExternalStore } from "react";

/**
 * Say things, and follow the language while it is being said.
 *
 * Returns the translator rather than the language, so that subscribing and
 * translating cannot come apart: a component that forgets to subscribe has no
 * way to say anything either, where a hook returning the current language would
 * let somebody call the plain function and quietly stop re-rendering when it
 * changed.
 */
export function useT(): typeof t {
	useSyncExternalStore(subscribe, locale, locale);
	return t;
}

/**
 * A phrase that carries something which is not text.
 *
 * A name in bold, a key drawn as a key. These cannot be assembled by
 * concatenating translated fragments, because word order is the first thing a
 * translation changes: "Joining as" and "with a signature" only go back together
 * in English, and in Japanese the name has moved before both of them.
 *
 * So the whole sentence is translated first and cut afterwards, at its
 * placeholders. Whatever each placeholder names is dropped in wherever that
 * language decided to put it.
 */
export function Phrased({
	phrase,
	values,
}: {
	phrase: Phrase;
	values: Record<string, ReactNode>;
}) {
	useSyncExternalStore(subscribe, locale, locale);

	return (
		<>
			{phraseSegments(phrase).map((segment, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
				<Fragment key={index}>
					{segment.value === undefined ? segment.text : values[segment.value]}
				</Fragment>
			))}
		</>
	);
}
