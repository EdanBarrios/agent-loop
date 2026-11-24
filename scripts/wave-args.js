#!/usr/bin/env node
// wave-args: build the wave-loop Workflow args for one wave straight from the spec, so the session never hand-copies
// task text, owned paths or dependencies.
//
//   node scripts/wave-args.js --repo <path> --wave <id> [--spec <path>] [--tail <task id>] [--notes <text>]
//
// Prints { project, wave, tasks, tail } as JSON on stdout: project is <repo>/.claude/loop.local.json, whole; each task
// is { id, title, branch, deps, text, owns, notes, lane } as docs/OPERATING.md "Running a wave" describes. The spec is
// project.spec (relative to the repo) unless --spec is given. text is the task bullet verbatim (continuation lines
// joined with newlines, the leading "- " dropped); owns is the Owns clause's backticked paths; deps keeps only ids in
// the same wave (earlier waves are merged before a wave runs); lane is the `Lane:` value or 'normal'; branch is
// task/<id>-<title slug>. The tail is the task named by --tail, else the wave's task whose id ends in ".T", else null.
// Tasks keep spec order: list the longest first in the spec.
// Exit 0: printed. Exit 1: the spec fails spec-lint, the wave has no task, or --tail names no task of the wave
// (stderr says which). Exit 2: usage, or a file that cannot be read.
//
// Reads or writes: reads (the config and the spec).

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANE_LINE, lintSpec, ownedPaths, specTasks, taskDeps } from './spec-lint.js';

const USAGE = 'usage: node scripts/wave-args.js --repo <path> --wave <id> [--spec <path>] [--tail <task id>] [--notes <text>]';

/** A branch-safe slug of a task title, at most 40 characters. */
export function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/**
 * Build the args for one wave.
 * @param {{ project: object, specText: string, wave: string, tail?: string, notes?: string }} input
 * @returns {{ ok: true, args: object } | { ok: false, errors: string[] }}
 */
export function waveArgs({ project, specText, wave, tail, notes = '' }) {
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
  return { ok: true, args: { project, wave, tasks: tasks.filter((t) => t !== tailTask), tail: tailTask } };
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
    const m = /^--(repo|wave|spec|tail|notes)$/.exec(args[i]);
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
  const r = waveArgs({ project, specText, wave: opts.wave, tail: opts.tail, notes: opts.notes });
  if (!r.ok) {
    for (const e of r.errors) err(`wave-args: ${e}\n`);
    return 1;
  }
  out(`${JSON.stringify(r.args, null, 1)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
