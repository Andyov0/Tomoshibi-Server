import { useEffect, useMemo, useState } from "react";

export interface Pagination<T> {
	/** Only the items on the current page. Everything else stays unmounted. */
	items: T[];
	page: number;
	pages: number;
	next: () => void;
	previous: () => void;
}

/**
 * Split a list across pages.
 *
 * The point is not the arrows; it is that off-page items are **not rendered**.
 * Every tile subscribes on mount and unsubscribes on unmount, so a page nobody
 * is looking at costs no bandwidth and no decode. Rendering them hidden would
 * keep the whole call downloading.
 */
export function usePagination<T>(items: T[], perPage: number): Pagination<T> {
	const pages = Math.max(1, Math.ceil(items.length / perPage));
	const [page, setPage] = useState(0);

	// People leaving can shrink the list out from under the current page.
	useEffect(() => {
		setPage((current) => Math.min(current, pages - 1));
	}, [pages]);

	const visible = useMemo(() => {
		const start = Math.min(page, pages - 1) * perPage;
		return items.slice(start, start + perPage);
	}, [items, page, pages, perPage]);

	return {
		items: visible,
		page: Math.min(page, pages - 1),
		pages,
		next: () => setPage((current) => (current + 1) % pages),
		previous: () => setPage((current) => (current - 1 + pages) % pages),
	};
}
