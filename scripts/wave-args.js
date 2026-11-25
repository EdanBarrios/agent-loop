#!/usr/bin/env node
// wave-args: build the wave-loop Workflow args for one wave straight from the spec, so the session never hand-copies
// task text, owned paths or dependencies.
//
//   node scripts/wave-args.js --repo <path> --wave <id> [--spec <path>] [--tail <task id>] [--notes <text>]
//                             [--scorecards <dir>]
//
// Prints { project, wave, tasks, tail, budget } as JSON on stdout: project is <repo>/.claude/loop.local.json, whole; each task
// is { id, title, branch, deps, text, owns, notes, lane } as docs/OPERATING.md "Running a wave" describes. The spec is
// project.spec (relative to the repo) unless --spec is given. text is the task bullet verbatim (continuation lines
// joined with newlines, the leading "- " dropped); owns is the Owns clause's backticked paths; deps keeps only ids in
// the same wave (earlier waves are merged before a wave runs); lane is the `Lane:` value or 'normal'; branch is
// task/<id>-<title slug>. The tail is the task named by --tail, else the wave's task whose id ends in ".T", else null.
// Tasks keep spec order: list the longest first in the spec.
// budget is null, or with --scorecards <dir> (relative to the repo, like --spec) { tasks, tokensPerTask, estimate, basis }:
// the <dir>/*-loop.md scorecards give tokens per task (the "Total tokens" signal divided by the rows of the "## Tasks"
// section); scorecards whose total is 0 or missing are skipped, then the newest three (by date prefix, then wave id as
// text) are taken, and tokensPerTask is their median (the mean of two). estimate is tasks (the wave's, tail included)
// times that, to the nearest thousand. The estimate is printed on stderr; with no usable scorecard budget is null and
// nothing is printed.
// Exit 0: printed. Exit 1: the spec fails spec-lint, the wave has no task, or --tail names no task of the wave
// (stderr says which). Exit 2: usage, or a file that cannot be read.
//
// Reads or writes: reads (the config and the spec).

import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANE_LINE, lintSpec, ownedPaths, specTasks, taskDeps } from './spec-lint.js';

const USAGE = 'usage: node scripts/wave-args.js --repo <path> --wave <id> [--spec <path>] [--tail <task id>] [--notes <text>] [--scorecards <dir>]';

/** A branch-safe slug of a task title, at most 40 characters. */
export function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/** Newest-first order for scorecard names: the date prefix, then the rest (the wave id) as text, by code unit. */
function scorecardOrder(a, b) {
  const key = (name) => {
    const m = /^(\d{4}-\d{2}-\d{2})-(.*)$/.exec(name);
    return m ? [m[1], m[2]] : ['', name];
  };
  const [da, wa] = key(a.file);
  const [db, wb] = key(b.file);
  if (da !== db) return da < db ? 1 : -1;
  if (wa !== wb) return wa < wb ? 1 : -1;
  return 0;
}

/**
 * Tokens and task rows of one scorecard, or null when it has no usable total (0 or missing) or no task row.
 * @param {string} text
 * @returns {{ tokens: number, tasks: number } | null}
 */
export function scorecardUsage(text) {
  const m = /^[-*]?\s*Total tokens:\s*(\d[\d,]*)/m.exec(text);
  const tokens = m ? Number(m[1].replaceAll(',', '')) : 0;
  if (!(tokens > 0)) return null;
  let inTasks = false;
  let header = 0; // table lines seen in the section: the header row and the separator row come first
  let tasks = 0;
  for (const line of text.split('\n')) {
    if (/^## /.test(line)) {
      inTasks = /^## Tasks\s*$/.test(line);
      header = 0;
      continue;
    }
    if (!inTasks || !line.trim().startsWith('|')) continue;
    if (header < 2) header++;
    else tasks++;
  }
  return tasks > 0 ? { tokens, tasks } : null;
}

/**
 * The token budget of a wave of `tasks` tasks, from scorecards; null when none is usable.
 * @param {{ name: string, text: string }[]} scorecards the *-loop.md files, any order
 * @param {number} tasks the wave's task count, tail included
 */
export function waveBudget(scorecards, tasks) {
  const usable = [];
  for (const { name, text } of scorecards) {
    if (!/-loop\.md$/.test(name)) continue;
    const u = scorecardUsage(text);
    if (u) usable.push({ file: name, tokens: u.tokens, tasks: u.tasks, tokensPerTask: u.tokens / u.tasks });
  }
  const basis = usable.sort(scorecardOrder).slice(0, 3);
  if (basis.length === 0) return null;
  const values = basis.map((b) => b.tokensPerTask).sort((x, y) => x - y);
  const tokensPerTask = values.length === 2 ? (values[0] + values[1]) / 2 : values[Math.floor(values.length / 2)];
  return { tasks, tokensPerTask, estimate: Math.round((tasks * tokensPerTask) / 1000) * 1000, basis };
}

/**
 * Build the args for one wave.
 * @param {{ project: object, specText: string, wave: string, tail?: string, notes?: string, scorecards?: { name: string, text: string }[] }} input
 * @returns {{ ok: true, args: object } | { ok: false, errors: string[] }}
 */
export function waveArgs({ project, specText, wave, tail, notes = '', scorecards = [] }) {
  const lint = lintSpec(specText);
  if (!lint.ok) return { ok: false, errors: lint.errors };
  const inWave = specTasks(specText).filter((t) => t.wave === wave);
  if (inWave.length === 0) return { ok: false, errors: [`wave ${wave}: no task under a "## Wave ${wave}" heading`] };
  const ids = new Set(inWave.map((t) => t.id));
  const tasks = inWave.map((t) => {
    const lane = LANE_LINE.exec(t.text);
    return {
      id: t.id,
      title: t.title.replace(/\.$/, ''),
      branch: `task/${t.id}-${slug(t.title)}`,
      deps: taskDeps(t.text).filter((d) => ids.has(d) && d !== t.id),
      text: t.text.replace(/^- /, '').trimEnd(),
      owns: ownedPaths(t.text).map((p) => `\`${p}\``).join(', '),
      notes,
      lane: lane ? lane[1] : 'normal',
    };
  });
  let tailTask = null;
  if (tail !== undefined) {
    tailTask = tasks.find((t) => t.id === tail) ?? null;
    if (tailTask === null) return { ok: false, errors: [`--tail ${tail}: no such task in wave ${wave}`] };
  } else {
    tailTask = tasks.find((t) => /\.T$/i.test(t.id)) ?? null;
  }
  const budget = waveBudget(scorecards, tasks.length);
  return { ok: true, args: { project, wave, tasks: tasks.filter((t) => t !== tailTask), tail: tailTask, budget } };
}

/**
 * CLI body.
 * @param {string[]} argv process.argv-shaped
 * @param {{ out?: (s: string) => void, err?: (s: string) => void }} io
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const opts = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const m = /^--(repo|wave|spec|tail|notes|scorecards)$/.exec(args[i]);
    if (!m || i + 1 >= args.length) {
      err(`${USAGE}\n`);
      return 2;
    }
    opts[m[1]] = args[++i];
  }
  if (!opts.repo || !opts.wave) {
    err(`${USAGE}\n`);
    return 2;
  }
  let project;
  let specText;
  try {
    project = JSON.parse(readFileSync(join(opts.repo, '.claude', 'loop.local.json'), 'utf8'));
    const specPath = opts.spec ?? project.spec;
    if (!specPath) throw new Error('no --spec and no "spec" in loop.local.json');
    specText = readFileSync(isAbsolute(specPath) ? specPath : join(opts.repo, specPath), 'utf8');
  } catch (e) {
    err(`wave-args: ${e.message}\n`);
    return 2;
  }
  let scorecards = [];
  if (opts.scorecards !== undefined) {
    try {
      const dir = isAbsolute(opts.scorecards) ? opts.scorecards : join(opts.repo, opts.scorecards);
      scorecards = readdirSync(dir)
        .filter((name) => name.endsWith('-loop.md'))
        .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
    } catch (e) {
      err(`wave-args: ${e.message}\n`);
      return 2;
    }
  }
  const r = waveArgs({ project, specText, wave: opts.wave, tail: opts.tail, notes: opts.notes, scorecards });
  if (!r.ok) {
    for (const e of r.errors) err(`wave-args: ${e}\n`);
    return 1;
  }
  const { budget } = r.args;
  if (budget) {
    const million = (budget.estimate / 1e6).toFixed(1);
    err(`wave-args: estimated ${million}M tokens for ${budget.tasks} tasks (median of ${budget.basis.map((b) => b.file).join(', ')})\n`);
  }
  out(`${JSON.stringify(r.args, null, 1)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
