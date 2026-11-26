# text-kit: six small helpers

Date: 2026-11-26. A synthetic spec for the benchmark: six tasks in two chains and two independent tasks, each owning
files no other task touches.

## End goal

`src/` holds six small helper modules, each with its own tests, and `npm run check` passes.

## Invariants

1. Never commit to the default branch; merge only through a pull request with a green check.
2. A task edits only the files it owns.
3. No dependencies: Node's built-in modules only.

## Budget

No paid calls. The cost is agent time.

## Decision envelope

A choice is the loop's own when it is reversible by one revert PR, costs nothing and touches no invariant. Anything else
is a question for a human.

## Fixed decisions

- **Language and tests.** Node ESM, plain JavaScript, `node:test` and `node:assert/strict`. Test files are `tests/*.test.js`.
- **Exports.** One named export per helper, as the task names it; no default exports and no index file.

## Human checklist

None: the benchmark runs the whole wave without a human step, and a human is needed only when a task escalates.

## Wave 1: helpers (1.2 after 1.1, 1.4 after 1.3; the rest in parallel)

- **1.1 Slug.** Owns `src/slug.js`, `tests/slug.test.js`. Exports `slugify(text)`: lower case, runs of characters other
  than a-z and 0-9 become one hyphen, no leading or trailing hyphen. Test: accents-free words, punctuation, repeated
  separators, an empty string.
- **1.2 Title slug.** Depends on 1.1. Owns `src/title-slug.js`, `tests/title-slug.test.js`. Exports
  `titleSlug(title, maxLength)`: `slugify` of the title cut to at most `maxLength` characters without ending in a hyphen.
  Test: a short title, a long title cut mid-word, a cut that would end in a hyphen.
- **1.3 Statistics.** Owns `src/stats.js`, `tests/stats.test.js`. Exports `mean(values)` and `median(values)`; both throw a
  `RangeError` for an empty array. Test: odd and even lengths, one value, the empty array.
- **1.4 Summary.** Depends on 1.3. Owns `src/summary.js`, `tests/summary.test.js`. Exports `summarize(values)`: an object
  `{ n, mean, median, min, max }` using `src/stats.js`. Test: a small array, one value, the empty array throws.
- **1.5 Word wrap.** Owns `src/wrap.js`, `tests/wrap.test.js`. Exports `wrap(text, width)`: breaks on spaces so that no line is
  longer than `width` unless a single word is; returns an array of lines. Test: a short text, an exact fit, a word longer
  than the width, an empty string.
- **1.6 CSV line.** Owns `src/csv.js`, `tests/csv.test.js`. Exports `parseCsvLine(line)`: splits on commas, a field in double
  quotes may hold commas, and a doubled quote inside quotes is one quote. Test: plain fields, a quoted comma, a doubled
  quote, an empty field.

## Later (not in this spec)

Nothing.
