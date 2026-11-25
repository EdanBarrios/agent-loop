import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { bundleSource } from '../../scripts/bundle-workflows.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { classifyFailure, pausePlan } from './pause.js';

// v2.4 task 1.3: a usage limit that resets far out pauses the wave instead of parking a dozen tasks. These tests are pure
// (no clock, no network, no agent): the clock is always passed in.

const here = dirname(fileURLToPath(import.meta.url));
const WARDEN_WAVE_4 =
  "failed: usage limit; resets Nov 19 at 12pm (America/Los_Angeles), too far out to wait for: You've hit your weekly limit · resets Nov 19 at 12pm (America/Los_Angeles)";

describe('classifyFailure', () => {
  it('reads the Warden wave 4 message: reset time from the date and zone, far out', () => {
    expect(classifyFailure(WARDEN_WAVE_4, Date.UTC(2026, 10, 16, 20))).toEqual({
      kind: 'usage_limit',
      resetsAt: 1795118400000,
      farOut: true,
    });
  });

  it('with a null clock gives no reset time, and far out only from the text', () => {
    expect(classifyFailure(WARDEN_WAVE_4, null)).toEqual({ kind: 'usage_limit', resetsAt: null, farOut: true });
  });

  it('a short reset 10 minutes out is not far out', () => {
    const now = Date.UTC(2026, 10, 16, 20, 0);
    const near = classifyFailure('usage limit reached, resets 8:10pm (UTC)', now);
    expect(near).toEqual({ kind: 'usage_limit', resetsAt: Date.UTC(2026, 10, 16, 20, 10), farOut: false });
  });

  it('a message with no reset time has a null resetsAt and is not far out', () => {
    expect(classifyFailure(new Error('Claude usage limit reached'), Date.UTC(2026, 10, 16, 20))).toEqual({
      kind: 'usage_limit',
      resetsAt: null,
      farOut: false,
    });
  });

  it('a non-limit error is other', () => {
    expect(classifyFailure(new Error('ENOENT: no such file'), Date.UTC(2026, 10, 16, 20))).toEqual({
      kind: 'other',
      resetsAt: null,
      farOut: false,
    });
    expect(classifyFailure(undefined, null).kind).toBe('other');
  });

  it('matches the limit pattern of isUsageLimit plus weekly limit', () => {
    for (const t of ['rate limit', 'rate-limited', 'ratelimit', 'quota exceeded', 'HTTP 429', 'weekly limit', 'Limit Reached']) {
      expect(classifyFailure(t, null).kind).toBe('usage_limit');
    }
    expect(classifyFailure('exit code 4290', null).kind).toBe('other');
  });

  it('parses the date form with and without comma, at, minutes and 12am', () => {
    const now = Date.UTC(2026, 10, 16, 20);
    expect(classifyFailure('usage limit; resets Nov 19, 12:30am (UTC)', now).resetsAt).toBe(Date.UTC(2026, 10, 19, 0, 30));
    expect(classifyFailure('usage limit; resets NOV 19, at 12PM (utc)', now).resetsAt).toBe(Date.UTC(2026, 10, 19, 12));
    expect(classifyFailure('usage limit; resets Nov 19 7pm (America/New_York)', now).resetsAt).toBe(Date.UTC(2026, 10, 20, 0));
  });

  it('a date without a year is the next such date on or after the clock', () => {
    expect(classifyFailure('usage limit; resets Jan 2 at 9am (UTC)', Date.UTC(2026, 11, 30)).resetsAt).toBe(Date.UTC(2027, 0, 2, 9));
    expect(classifyFailure('usage limit; resets Dec 30 at 9am (UTC)', Date.UTC(2026, 11, 30, 9)).resetsAt).toBe(Date.UTC(2026, 11, 30, 9));
    expect(classifyFailure('usage limit; resets Dec 30 at 9am (UTC)', Date.UTC(2026, 11, 30, 10)).resetsAt).toBe(Date.UTC(2027, 11, 30, 9));
  });

  it('the time-only form is the next such time, today or tomorrow', () => {
    expect(classifyFailure('usage limit; resets at 3pm (UTC)', Date.UTC(2026, 10, 16, 10))).toEqual({
      kind: 'usage_limit',
      resetsAt: Date.UTC(2026, 10, 16, 15),
      farOut: true,
    });
    expect(classifyFailure('usage limit; resets 3pm (UTC)', Date.UTC(2026, 10, 16, 16)).resetsAt).toBe(Date.UTC(2026, 10, 17, 15));
    expect(classifyFailure('usage limit; resets 3pm (UTC)', null).resetsAt).toBeNull();
  });

  it('the time-only form follows the zone, across a day boundary', () => {
    // 2026-11-17T03:00Z is 7pm on Nov 16 in Los Angeles (UTC-8), so 9pm there is two hours away.
    expect(classifyFailure('usage limit; resets 9pm (America/Los_Angeles)', Date.UTC(2026, 10, 17, 3))).toEqual({
      kind: 'usage_limit',
      resetsAt: Date.UTC(2026, 10, 17, 5),
      farOut: true,
    });
  });

  it('parses the relative forms and needs a clock for them', () => {
    const now = Date.UTC(2026, 10, 16, 20);
    expect(classifyFailure('usage limit; resets in 3h', now)).toEqual({
      kind: 'usage_limit',
      resetsAt: now + 3 * 3600 * 1000,
      farOut: true,
    });
    expect(classifyFailure('usage limit; resets in 2 hr 30 min', now).resetsAt).toBe(now + 150 * 60 * 1000);
    expect(classifyFailure('usage limit; resets in 25 min', now)).toEqual({ kind: 'usage_limit', resetsAt: now + 25 * 60 * 1000, farOut: false });
    expect(classifyFailure('usage limit; resets in 3h', null).resetsAt).toBeNull();
  });

  it('far out is over 30 minutes, not exactly 30', () => {
    const now = Date.UTC(2026, 10, 16, 20);
    expect(classifyFailure('usage limit; resets in 30 min', now).farOut).toBe(false);
    expect(classifyFailure('usage limit; resets in 31 min', now).farOut).toBe(true);
  });

  it('a zone the runtime rejects gives a null resetsAt', () => {
    expect(classifyFailure('usage limit; resets Nov 19 at 12pm (Mars/Olympus)', Date.UTC(2026, 10, 16, 20))).toEqual({
      kind: 'usage_limit',
      resetsAt: null,
      farOut: false,
    });
  });

  it('an impossible date or time gives a null resetsAt', () => {
    const now = Date.UTC(2026, 10, 16, 20);
    expect(classifyFailure('usage limit; resets Nov 31 at 12pm (UTC)', now).resetsAt).toBeNull();
    expect(classifyFailure('usage limit; resets 13pm (UTC)', now).resetsAt).toBeNull();
  });
});

describe('pausePlan', () => {
  it('pauses unstarted and failed-on-limit tasks, keeps other parked tasks parked, ignores the rest', () => {
    const plan = pausePlan({
      tasks: ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.T'],
      state: { '1.1': 'merged', '1.2': 'parked', '1.3': 'parked', '1.4': 'reverted', '1.5': 'running' },
      failedOnLimit: ['1.3'],
    });
    expect(plan).toEqual({ paused: ['1.3', '1.6', '1.T'], parked: ['1.2'] });
  });

  it('a merged task is never paused, even when listed as failed on the limit', () => {
    expect(pausePlan({ tasks: ['a'], state: { a: 'merged' }, failedOnLimit: ['a'] })).toEqual({ paused: [], parked: [] });
  });

  it('keeps the order of tasks and ignores failed ids that are not tasks', () => {
    expect(pausePlan({ tasks: ['b', 'a'], state: {}, failedOnLimit: ['z', 'a'] })).toEqual({ paused: ['b', 'a'], parked: [] });
  });

  it('with nothing started, every task is paused', () => {
    expect(pausePlan({ tasks: ['x', 'y'], state: {}, failedOnLimit: [] })).toEqual({ paused: ['x', 'y'], parked: [] });
  });
});

describe('bundling', () => {
  const lib = readFileSync(join(here, 'pause.js'), 'utf8');

  it('bundleSource reports no problem on the lib source', () => {
    expect(bundleSource(lib, new Set()).problems).toEqual([]);
  });

  it('declares no top-level name that the wave-loop workflow already declares', () => {
    const decl = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|var\s+|class\s+)([A-Za-z_$][\w$]*)/;
    const names = (src: string) =>
      src
        .split('\n')
        .map((l) => decl.exec(l)?.[1])
        .filter((n): n is string => Boolean(n));
    const mine = names(lib);
    expect(mine.length).toBeGreaterThan(0);
    const workflow = readFileSync(join(here, '..', 'workflows', 'wave-loop.js'), 'utf8');
    const theirs = new Set(names(workflow));
    expect(mine.filter((n) => theirs.has(n))).toEqual([]);
  });
});
