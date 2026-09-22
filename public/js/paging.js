// The arithmetic behind a paged table, with no DOM in it.
//
// It lives apart from core.js so it can be tested in Node. That is not
// ceremony: the very first version of `readPageSize` read an empty
// localStorage as `Number(null)`, which is 0, which is the code for "show
// all" — so every table opened with all 52 rows on screen and no pager at
// all, which is the exact bug the pager was built to fix. A browser caught
// it. A test should have.

/// The sizes the control offers. 0 is not one of them: it means "show all",
/// and is handled apart so a stored 0 cannot be confused with a missing value.
export const PAGE_SIZES = [10, 25, 50, 100];

/// Every row on one page.
export const SHOW_ALL = 0;

/// Where the reader's choice is remembered, so it holds across tables and
/// across visits.
export const PAGE_SIZE_KEY = 'portal.pageSize';

/// The remembered page size, or `fallback` when there is nothing trustworthy.
///
/// `getItem` is `(key) => string | null`. It is allowed to throw: storage is
/// unavailable in a private window and can be turned off outright, and a table
/// that will not draw because of that would be a poor trade for remembering a
/// preference.
export function readPageSize(getItem, fallback) {
  let raw;
  try {
    raw = getItem(PAGE_SIZE_KEY);
  } catch {
    return fallback;
  }

  // Nothing stored. Checked before any conversion, because `Number(null)` and
  // `Number('')` are both 0, and 0 means something here.
  if (raw === null || raw === undefined || raw === '') return fallback;

  const stored = Number(raw);
  if (stored === SHOW_ALL) return SHOW_ALL;
  return PAGE_SIZES.includes(stored) ? stored : fallback;
}

/// Remembers a page size. Returns whether it stuck, which the caller is free
/// to ignore — nothing about the table depends on it.
export function writePageSize(setItem, size) {
  if (size !== SHOW_ALL && !PAGE_SIZES.includes(size)) return false;
  try {
    setItem(PAGE_SIZE_KEY, String(size));
    return true;
  } catch {
    return false;
  }
}

/// Where a page sits in a list: which page it really is once clamped, the
/// 1-based range it covers, and how many pages there are.
///
/// `total` of 0 still has one page — an empty one — because a table with
/// nothing in it is still a table, and "page 0 of 0" is not a thing to show
/// anybody.
export function pageSlice(total, page, size) {
  const count = Math.max(0, Math.floor(total) || 0);
  const perPage = size === SHOW_ALL ? Math.max(count, 1) : Math.max(1, Math.floor(size));

  const last = Math.max(1, Math.ceil(count / perPage));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), last);

  const from = (current - 1) * perPage;
  const to = Math.min(from + perPage, count);

  return {
    page: current,
    last,
    perPage,
    // Zero-based, for slicing an array.
    start: from,
    end: to,
    // 1-based and inclusive, for saying "Showing 26–50 of 52" to a person.
    // Both are 0 when there is nothing, which reads as "no rows" rather than
    // as the nonsense "showing 1–0".
    firstRow: count ? from + 1 : 0,
    lastRow: to,
  };
}

/// The page buttons to draw: a window around the current page, with `null`
/// where a run of numbers is skipped. The first and last are always in it, so
/// either end of a long list stays one click away.
export function pageWindow(current, last) {
  const end = Math.max(1, Math.floor(last) || 1);
  const at = Math.min(Math.max(1, Math.floor(current) || 1), end);

  if (end <= 7) return Array.from({ length: end }, (_, i) => i + 1);

  // Always seven slots wide, whichever page you are on. A row that grew and
  // shrank as you paged would slide the next button out from under the cursor,
  // so each branch below contributes exactly enough to fill it:
  //
  //   near the start   1 2 3 4 5 … 40
  //   in the middle    1 … 19 20 21 … 40
  //   near the end     1 … 36 37 38 39 40
  const wanted = new Set([1, end]);
  if (at <= 4) [2, 3, 4, 5].forEach((n) => wanted.add(n));
  else if (at >= end - 3) [end - 4, end - 3, end - 2, end - 1].forEach((n) => wanted.add(n));
  else [at - 1, at, at + 1].forEach((n) => wanted.add(n));

  const pages = [...wanted].filter((n) => n >= 1 && n <= end).sort((a, b) => a - b);

  const out = [];
  let previous = 0;
  for (const n of pages) {
    // Those branches never leave a gap of exactly one, so an ellipsis here
    // always stands for more than the single page it takes the room of. The
    // tests hold that, rather than this loop papering over it.
    if (previous && n - previous > 1) out.push(null);
    out.push(n);
    previous = n;
  }
  return out;
}
