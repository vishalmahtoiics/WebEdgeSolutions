// The arithmetic behind a paged table.
//
// These are here because the first version of readPageSize shipped a bug that
// no server test could have seen: with nothing in localStorage, `getItem`
// returns null, `Number(null)` is 0, and 0 is the code for "show all" — so
// every table opened with every row on screen and no pager at all, which is
// the exact thing the pager was added to fix. A browser caught it. Now these
// do.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE_SIZES,
  SHOW_ALL,
  PAGE_SIZE_KEY,
  readPageSize,
  writePageSize,
  pageSlice,
  pageWindow,
} from '../public/js/paging.js';

/// A stand-in for localStorage, which can also be told to misbehave the way a
/// real one does in a private window.
function fakeStorage(initial = {}, { throws = false } = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: (k) => {
      if (throws) throw new Error('storage is not available');
      return k in store ? store[k] : null;
    },
    setItem: (k, v) => {
      if (throws) throw new Error('storage is not available');
      store[k] = v;
    },
  };
}

// --- Remembering the page size ----------------------------------------------

test('nothing stored yet means the default, not "show all"', () => {
  const s = fakeStorage();
  assert.equal(readPageSize(s.getItem, 25), 25);
});

test('an empty string is treated as nothing stored', () => {
  // Number('') is also 0, so this is the same trap by a different route.
  const s = fakeStorage({ [PAGE_SIZE_KEY]: '' });
  assert.equal(readPageSize(s.getItem, 25), 25);
});

test('a stored size is honoured', () => {
  const s = fakeStorage({ [PAGE_SIZE_KEY]: '50' });
  assert.equal(readPageSize(s.getItem, 25), 50);
});

test('"show all" is remembered, because it was chosen on purpose', () => {
  const s = fakeStorage({ [PAGE_SIZE_KEY]: '0' });
  assert.equal(readPageSize(s.getItem, 25), SHOW_ALL);
});

test('a size the control does not offer falls back to the default', () => {
  for (const junk of ['7', '-10', 'abc', '1e9', '25.5', 'null']) {
    const s = fakeStorage({ [PAGE_SIZE_KEY]: junk });
    assert.equal(readPageSize(s.getItem, 25), 25, `"${junk}" should not be honoured`);
  }
});

test('storage that throws costs a preference, never the table', () => {
  const s = fakeStorage({}, { throws: true });
  assert.equal(readPageSize(s.getItem, 25), 25);
  assert.equal(writePageSize(s.setItem, 50), false, 'it failed, and says so');
});

test('a size is written back in the form it is read from', () => {
  const s = fakeStorage();
  assert.equal(writePageSize(s.setItem, 100), true);
  assert.equal(readPageSize(s.getItem, 25), 100, 'a write must survive the read');

  assert.equal(writePageSize(s.setItem, SHOW_ALL), true);
  assert.equal(readPageSize(s.getItem, 25), SHOW_ALL);

  assert.equal(writePageSize(s.setItem, 7), false, 'not an offered size');
  assert.equal(readPageSize(s.getItem, 25), SHOW_ALL, 'and the old value stands');
});

test('every offered size survives a round trip', () => {
  for (const size of PAGE_SIZES) {
    const s = fakeStorage();
    writePageSize(s.setItem, size);
    assert.equal(readPageSize(s.getItem, 10), size);
  }
});

// --- Where a page sits ------------------------------------------------------

test('a full list divides into pages, and the last one is the short one', () => {
  const first = pageSlice(52, 1, 25);
  assert.deepEqual(
    { page: first.page, last: first.last, firstRow: first.firstRow, lastRow: first.lastRow },
    { page: 1, last: 3, firstRow: 1, lastRow: 25 },
  );

  const final = pageSlice(52, 3, 25);
  assert.deepEqual(
    { page: final.page, last: final.last, firstRow: final.firstRow, lastRow: final.lastRow },
    { page: 3, last: 3, firstRow: 51, lastRow: 52 },
  );
  assert.equal(final.end - final.start, 2, 'two rows left over');
});

test('the pages cover every row exactly once', () => {
  const rows = Array.from({ length: 52 }, (_, i) => i);
  const seen = [];
  const { last } = pageSlice(rows.length, 1, 25);
  for (let p = 1; p <= last; p += 1) {
    const at = pageSlice(rows.length, p, 25);
    seen.push(...rows.slice(at.start, at.end));
  }
  assert.deepEqual(seen, rows, 'nothing skipped, nothing shown twice');
});

test('a page past the end lands on the last page rather than on nothing', () => {
  // This is what happens when a search narrows the list while the reader is
  // on page 4: page 4 no longer exists, and an empty table would look like
  // "no results" when there are plenty.
  const at = pageSlice(12, 9, 25);
  assert.equal(at.page, 1);
  assert.equal(at.lastRow, 12);
});

test('"show all" is one page holding everything', () => {
  const at = pageSlice(52, 1, SHOW_ALL);
  assert.equal(at.last, 1);
  assert.equal(at.start, 0);
  assert.equal(at.end, 52);
});

test('an empty list is one empty page, not page 0 of 0', () => {
  const at = pageSlice(0, 1, 25);
  assert.equal(at.last, 1);
  assert.equal(at.page, 1);
  assert.equal(at.firstRow, 0, 'saying "showing 1-0" would be worse than saying nothing');
  assert.equal(at.lastRow, 0);
});

test('an exact multiple does not invent a trailing empty page', () => {
  assert.equal(pageSlice(50, 1, 25).last, 2);
  assert.equal(pageSlice(25, 1, 25).last, 1);
});

// --- Which page buttons to draw ---------------------------------------------

test('a short list shows every page', () => {
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(2, 3), [1, 2, 3]);
  assert.deepEqual(pageWindow(4, 7), [1, 2, 3, 4, 5, 6, 7]);
});

test('a long list keeps the ends one click away', () => {
  for (const at of [1, 7, 20, 40]) {
    const window = pageWindow(at, 40);
    assert.ok(window.includes(1), 'the first page is always reachable');
    assert.ok(window.includes(40), 'so is the last');
    assert.ok(window.includes(at), 'and the page you are on is in it');
  }
});

test('a long list never repeats a page or runs backwards', () => {
  for (let at = 1; at <= 40; at += 1) {
    const numbers = pageWindow(at, 40).filter((n) => n !== null);
    assert.deepEqual(numbers, [...new Set(numbers)], `page ${at} repeats a number`);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), `page ${at} is out of order`);
  }
});

test('a gap is marked only where more than one page is skipped', () => {
  for (let at = 1; at <= 40; at += 1) {
    const window = pageWindow(at, 40);
    for (let i = 1; i < window.length; i += 1) {
      const before = window[i - 1];
      const after = window[i];
      if (before === null || after === null) continue;
      assert.ok(
        after - before === 1,
        `page ${at}: ${before} then ${after} with nothing between them to say so`,
      );
    }
    // An ellipsis standing in for a single page would take the same room as
    // the page number itself, so it never should.
    for (let i = 1; i < window.length - 1; i += 1) {
      if (window[i] !== null) continue;
      assert.ok(
        window[i + 1] - window[i - 1] > 2,
        `page ${at}: an ellipsis hiding only page ${window[i - 1] + 1}`,
      );
    }
  }
});

test('the row of buttons does not change width as you page', () => {
  // A row that grows and shrinks moves the button under the reader's cursor.
  const widths = new Set();
  for (let at = 1; at <= 40; at += 1) widths.add(pageWindow(at, 40).length);
  assert.equal(widths.size, 1, `the row takes ${[...widths].join(', ')} slots depending on the page`);
});

test('nonsense page numbers are clamped rather than obeyed', () => {
  assert.deepEqual(pageWindow(0, 3), [1, 2, 3]);
  assert.deepEqual(pageWindow(99, 3), [1, 2, 3]);
  assert.deepEqual(pageWindow(1, 0), [1]);
});
