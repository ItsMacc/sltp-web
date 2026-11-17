// usePageTitle.ts — Browser tab title, one per top-level page.
//
// The tab label is part of the product's voice: it names a page the same way
// the nav does, so the two never disagree. Titles live in one table instead
// of being set inside each page, which keeps them consistent and makes the
// full list reviewable at a glance.

import { useEffect } from 'react';

const SITE = 'SLTP';

const PAGE_TITLES: Record<string, string> = {
  // Kept word for word in step with index.html: the static title is what a
  // crawler sees first, and this one replaces it on mount. Two different
  // strings for the same page is one signal contradicting another.
  home: `${SITE} - Market Research, Backtests and Investing Insights`,
  docs: `Docs — ${SITE}`,
  research: `Research — ${SITE}`,
  strategies: `Strategies — ${SITE}`,
  lab: `Lab — ${SITE}`,
  watchlist: `Watchlist — ${SITE}`,
  learn: `Learn — ${SITE}`,
  settings: `Settings — ${SITE}`,
  guide: `Tour — ${SITE}`,
};

/** Sets document.title for the lifetime of the calling component. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** Looks up the tab title for a route id, falling back to the bare brand. */
export function pageTitleFor(route: string): string {
  return PAGE_TITLES[route] ?? SITE;
}
