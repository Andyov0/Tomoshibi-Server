import { useT } from "@/hooks/useT";
import { LOCALES, type Locale, type Phrase, type Values, locale, tIn } from "@/live/i18n";
import { cn } from "@/lib/utils";

/*
 * Words drawn at the size of the longest language they are said in.
 *
 * The owner chose Simplified Chinese and watched the page change size: the
 * corner's buttons narrowed and slid sideways, a card's description that took
 * two lines in English took one, so the card shrank and the cards below it
 * rose, and a button narrowed and widened the field beside it. Measured, the
 * fonts were not the cause (Latin is set in the same face whatever the page's
 * language); the words were, being shorter or longer. Wherever their length
 * moves something else, the words are drawn in every language at once, one
 * over another in a single grid cell, and all but the reader's hidden: the
 * space they take is the largest any language needs, and changing the language
 * changes what is read and not where anything is.
 *
 * The hidden ones are invisible rather than absent, so that they keep their
 * space, and hidden from a screen reader, so that only the reader's language
 * is read and a button's name is its words once. Each is marked with its own
 * language, so that it is broken into lines and set as that language is.
 */

/** Any words, given in each language: a notice's, the languages' own names. */
export function SteadyText({
	texts,
	block = false,
	className,
}: {
	texts: Partial<Record<Locale, string>>;
	/** A paragraph that may run to several lines, rather than words in a line. */
	block?: boolean;
	className?: string;
}) {
	useT();
	const now = locale();
	const said = LOCALES.filter((language) => texts[language] !== undefined);

	// Words in a line are mostly a button's, and centred in the space the
	// longest language takes, where at the start they left a strip of nothing
	// after "管理后台" in a button as wide as "Admin console". A heading or a
	// label says justify-items-start for itself. A paragraph starts its lines
	// at the start, as text does.
	return (
		<span className={cn(block ? "grid" : "inline-grid justify-items-center", className)}>
			{said.map((language) => (
				<span
					key={language}
					lang={language}
					aria-hidden={language === now ? undefined : true}
					className={cn("col-start-1 row-start-1", language !== now && "invisible")}
				>
					{texts[language]}
				</span>
			))}
		</span>
	);
}

/** A phrase of the interface's own, in every language its dictionaries hold. */
export function Steady({
	phrase,
	values,
	block = false,
	className,
}: {
	phrase: Phrase;
	values?: Values;
	block?: boolean;
	className?: string;
}) {
	const texts = Object.fromEntries(LOCALES.map((language) => [language, tIn(language, phrase, values)])) as Record<
		Locale,
		string
	>;
	return <SteadyText texts={texts} block={block} className={className} />;
}
