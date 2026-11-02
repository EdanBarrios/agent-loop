// Fast-lane check: decides whether a task may skip the critic. Pure functions, no I/O: the workflow
// supplies every input (changed files, added diff text, test counts, Decisions lines, the CI result),
// the worker reports none of them. The rules are the spec's "Fast lane" fixed decision.
// The path matcher here also serves the critic's owned-paths check.

import { HUMAN_ONLY_CATEGORIES, classify } from './envelope.js';

/**
 * @typedef {Object} FastLaneConfig
 * @property {boolean} [enabled]          default false; a human turns it on per project
 * @property {string[]} [denyPaths]       path patterns no fast-lane task may touch (default DEFAULT_DENY_PATHS)
 * @property {number} [maxPerWave]        default 3
 * @property {string} [testCountCommand]  prints the test count; none configured means not eligible
 */

/**
 * @typedef {Object} LaneInput
 * @property {{ id?: string, lane?: string, owns?: string[]|string }} task
 * @property {string[]} changedFiles     from `gh pr view --json files`
 * @property {string} addedText          added lines of `gh pr diff`
 * @property {string[]|string} decisions the PR body's `Decisions:` lines (id | choice | reason | reversible)
 * @property {{ forbiddenStrings?: string[], fastLane?: FastLaneConfig }} project
 * @property {{ state?: string }} ci     the waitForCi result
 * @property {{ before: number, after: number }} testCount  from fastLane.testCountCommand on the default branch and on the PR head
 * @property {number} laneUsedInWave     fast-lane tasks already taken in this wave
 */

export const DEFAULT_MAX_PER_WAVE = 3;

/**
 * Used when the project sets no fastLane.denyPaths: the loop's own workflow files, hookify rules and
 * agent prompts, plus CI definitions. A project that sets denyPaths replaces this list.
 */
export const DEFAULT_DENY_PATHS = Object.freeze([
  'claude/workflows/',
  'claude/agents/',
  'claude/hookify.*',
  '.claude/',
  '.github/workflows/',
]);

/** @param {string} p repo-relative path with forward slashes and no leading './' */
function cleanPath(p) {
  let s = String(p).trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/\/{2,}/g, '/');
}

/** True for paths that must never match anything: absolute, or with a '..' segment. */
function escapes(p) {
  return p.startsWith('/') || p.split('/').includes('..');
}

/** @param {string} pattern */
function patternToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += '[^/]*';
      }
    } else {
      source += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}(?:/.*)?$`);
}

/**
 * The one path matcher. `pattern` is a path prefix made of whole segments: 'scripts/' and 'scripts'
 * both cover everything under scripts/, 'scripts/a.js' covers that file (not 'scripts/a.js.bak'), and
 * '*' inside a segment is a wildcard ('claude/hookify.*', 'tests/fixtures/timings-*.json'; '**'
 * crosses segments). Absolute paths, '..' segments and empty patterns never match.
 * @param {string} file
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesPath(file, pattern) {
  const f = cleanPath(file);
  const p = cleanPath(pattern).replace(/\/+$/, '');
  if (f === '' || p === '' || p === '.' || escapes(f) || escapes(p)) return false;
  return patternToRegExp(p).test(f);
}

/**
 * Owns as the spec writes it is either a list of path prefixes or the task's prose with the paths in
 * backticks; both give a list of patterns.
 * @param {string[]|string|undefined|null} owns
 * @returns {string[]}
 */
export function parseOwns(owns) {
  if (Array.isArray(owns)) return owns.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  if (typeof owns !== 'string') return [];
  const ticked = [...owns.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
  if (ticked.length > 0) return ticked;
  return owns.split(/[,\s]+/).map((x) => x.replace(/[.;]+$/, '')).filter(Boolean);
}

/**
 * Files that no Owns entry covers. Serves the fast-lane check and the critic's owned-paths check.
 * @param {string[]} files
 * @param {string[]|string} owns
 * @returns {string[]}
 */
export function filesOutsideOwns(files, owns) {
  const patterns = parseOwns(owns);
  return (files || []).filter((f) => !patterns.some((p) => matchesPath(f, p)));
}

/** Decisions: lines of `id | choice | reason | reversible`, with list markers, blanks and the heading ignored. */
function decisionLines(decisions) {
  const raw = Array.isArray(decisions) ? decisions : typeof decisions === 'string' ? decisions.split(/\r?\n/) : [];
  return raw
    .map((l) => String(l).trim().replace(/^[-*]\s+/, ''))
    .filter((l) => l !== '' && !/^decisions:?$/i.test(l) && !/^(none|n\/a)\.?$/i.test(l));
}

const HUMAN_ONLY_WORDS = HUMAN_ONLY_CATEGORIES
  // 'invariant' and 'fixed_decision' appear in benign sentences ("touches no invariant"); the deny
  // paths and the forbidden strings guard those, and the critic's STOP rule still applies elsewhere.
  .filter((c) => c !== 'invariant' && c !== 'fixed_decision')
  .map((c) => c.replace(/_/g, ' '));

/**
 * Check the PR's Decisions lines against the envelope (claude/lib/envelope.js). A line carries no
 * category, cost or touches, so those are checked from what it does carry: it must be readable,
 * reversible, give a reason, and name no human-only category as a whole word.
 * @returns {string|null} the first problem, or null
 */
function decisionProblem(decisions) {
  for (const line of decisionLines(decisions)) {
    const parts = line.split('|').map((x) => x.trim());
    if (parts.length !== 4 || !parts[0] || !parts[1]) {
      return `Decisions line cannot be read as "id | choice | reason | reversible": "${line}"`;
    }
    const [id, choice, reason, reversible] = parts;
    const verdict = classify({
      id,
      text: choice,
      evidence: reason,
      // The line has no field for it; CI and the default-branch check are the observation that would show it wrong.
      wouldBeWrongIf: 'CI or the check on the default branch fails',
      reverseCost: 'one revert PR',
      reversible: /^(true|yes|y)$/i.test(reversible),
      costCents: 0,
      touches: [],
      category: '',
    });
    if (verdict.decision !== 'accept') return `decision ${id} is outside the envelope: ${verdict.reason}`;
    const text = `${choice} ${reason}`.toLowerCase();
    const hit = HUMAN_ONLY_WORDS.find((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(text));
    if (hit) return `decision ${id} is outside the envelope: it names the human-only category "${hit}"`;
  }
  return null;
}

/**
 * Decide whether a task may take the fast lane (skip the critic).
 * @param {LaneInput} input
 * @returns {{ eligible: boolean, reason: string }}
 */
export function fastLaneEligible(input) {
  const { task, changedFiles, addedText, decisions, project, ci, testCount, laneUsedInWave } = input || {};
  const no = (reason) => ({ eligible: false, reason });
  const cfg = project?.fastLane ?? {};

  if (cfg.enabled !== true) return no('fastLane.enabled is not true for this project');
  if (task?.lane !== 'fast') return no('the task is not marked Lane: fast (default normal)');

  const cap = Number.isInteger(cfg.maxPerWave) && cfg.maxPerWave >= 0 ? cfg.maxPerWave : DEFAULT_MAX_PER_WAVE;
  const used = Number.isInteger(laneUsedInWave) && laneUsedInWave > 0 ? laneUsedInWave : 0;
  if (used >= cap) return no(`the per-wave fast-lane cap is reached (${used} of ${cap})`);

  if (typeof cfg.testCountCommand !== 'string' || cfg.testCountCommand.trim() === '') {
    return no('no fastLane.testCountCommand is configured, so the test count cannot be compared');
  }

  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length === 0) return no('no changed files were reported for the PR');

  const outside = filesOutsideOwns(files, task.owns);
  if (outside.length > 0) return no(`changed files outside Owns: ${outside.join(', ')}`);

  const deny = Array.isArray(cfg.denyPaths) ? cfg.denyPaths : DEFAULT_DENY_PATHS;
  const denied = files.filter((f) => deny.some((p) => matchesPath(f, p)));
  if (denied.length > 0) return no(`changed files under denyPaths: ${denied.join(', ')}`);

  const haystack = String(addedText ?? '').toLowerCase();
  const forbidden = (project?.forbiddenStrings ?? []).filter((s) => typeof s === 'string' && s !== '' && haystack.includes(s.toLowerCase()));
  if (forbidden.length > 0) return no(`the added text contains a forbidden string: ${forbidden.join(', ')}`);

  if (ci?.state !== 'green') return no(`CI is not green (${ci?.state ?? 'no result'})`);

  const { before, after } = testCount ?? {};
  if (!Number.isFinite(before) || !Number.isFinite(after)) return no('the test count is missing or not a number');
  if (after < before) return no(`test count fell from ${before} to ${after}`);

  const problem = decisionProblem(decisions);
  if (problem) return no(problem);

  return {
    eligible: true,
    reason: `fast lane: ${files.length} file(s) inside Owns, none denied, no forbidden string, CI green, test count ${before} to ${after}, decisions inside the envelope (${used + 1} of ${cap} this wave)`,
  };
}
