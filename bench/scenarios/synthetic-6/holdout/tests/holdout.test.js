import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slug.js';
import { titleSlug } from '../src/title-slug.js';
import { mean, median } from '../src/stats.js';
import { summarize } from '../src/summary.js';
import { wrap } from '../src/wrap.js';
import { parseCsvLine } from '../src/csv.js';

// The held-out tests of the synthetic-6 scenario: the agents never see this file.

test('slugify lower-cases and joins words with single hyphens', () => {
  assert.equal(slugify('  Hello,   World!! '), 'hello-world');
  assert.equal(slugify(''), '');
});

test('titleSlug cuts at the limit and never ends in a hyphen', () => {
  assert.equal(titleSlug('Short title', 40), 'short-title');
  assert.equal(titleSlug('A very long title for a page', 10), 'a-very-lon');
  assert.equal(titleSlug('abcd efgh', 5), 'abcd');
});

test('mean and median agree on odd and even lengths', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('mean and median reject an empty array', () => {
  assert.throws(() => mean([]), RangeError);
  assert.throws(() => median([]), RangeError);
});

test('summarize builds on the statistics', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { n: 4, mean: 2.5, median: 2.5, min: 1, max: 4 });
  assert.throws(() => summarize([]), RangeError);
});

test('wrap breaks on spaces and keeps a long word whole', () => {
  assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox']);
  assert.deepEqual(wrap('extraordinary day', 5), ['extraordinary', 'day']);
  assert.deepEqual(wrap('', 5), []);
});

test('parseCsvLine handles quoted commas and doubled quotes', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
});

test('parseCsvLine keeps empty fields', () => {
  assert.deepEqual(parseCsvLine('a,,c,'), ['a', '', 'c', '']);
});
