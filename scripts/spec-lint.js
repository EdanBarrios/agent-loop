#!/usr/bin/env node
// spec-lint: structural check of a project spec before any wave runs.
//
//   node scripts/spec-lint.js <spec.md>
//
// Exit 0: spec passes (tasks that need human review, and shape warnings, are listed on stdout).
// Exit 1: at least one item is missing; each message names the section or the task id (stderr).
// Warnings never change the exit code. They flag wave and task shapes that made waves slow (waves 9 and 12 of the pilot project):
//  - a wave whose dependency chain is more than MAX_CHAIN_DEPTH tasks deep (tail not counted): each hop costs about
//    15 min of review, CI and merge before the next worker starts; do chain-shaped work as one PR with stacked commits;
//  - a wave of MAX_SMALL_WAVE tasks or fewer (tail counted): send them as single PRs, not a wave;
//  - a task that owns more than MAX_OWNED_PATHS paths, or adds more than one migration.
// Exit 2: usage error or the file cannot be read.
//
// Reads or writes: reads (the spec file only).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REQUIRED_SECTIONS = [
  'End goal',
  'Invariants',
  'Budget',
  'Decision envelope',
  'Fixed decisions',
  'Human checklist',
];

export const READS_OR_WRITES = ['reads', 'writes-db', 'writes-files', 'paid-call', 'sends'];
export const NEEDS_REVIEW = ['writes-db', 'paid-call', 'sends'];
export const LANES = ['fast', 'normal'];
export const MAX_CHAIN_DEPTH = 2;
export const MAX_SMALL_WAVE = 2;
export const MAX_OWNED_PATHS = 6;

// A task is a command spec when its text says it adds a command, a script or a CLI (the spec's
// "Command specs" rule). Passing mentions ("exec(command)", "a command that prints") do not count.
const ADDS_COMMAND = /\b(?:adds?|adding|introduces?|new)\s+(?:(?:an?|the)\s+)?(?:CLI\s+command|CLI|command|script)\b/i;
const TASK_BULLET = /^- \*\*(\d+\.[0-9A-Za-z]+)\s+(.*?)\*\*/;
const WAVE_HEADING = /^#{1,6}\s+Wave\s+([0-9][0-9A-Za-z.]*)/i;
const TASK_ID = /\b\d+\.[0-9A-Za-z]+\b/g;
// "Depends on 11.2 and 11.3." or "Deps: 9.1, 9.2." up to the end of the sentence.
const DEPENDS = /\b(?:Depends on|Deps:)\s+((?:\d+\.[0-9A-Za-z]+)(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)\d+\.[0-9A-Za-z]+)*)/i;
const MIGRATION_PATH = /(?:^|\/)migrations?\/[^/\s]+\.\w+$/;
// The value must follow the label directly and end at a delimiter; a quoted mention such as
// "a `Reads or writes:` line" or "`Reads or writes: writes-db|paid-call|sends`" is not a value.
// `Lane:` is case-sensitive and starts at a word boundary, so prose such as "the fast lane: skips" is not a label.
export const LANE_LINE = /\bLane:\s*`?([A-Za-z][A-Za-z-]*)(?=[`\s.,;)]|$)/;
const READS_OR_WRITES_LINE = /Reads or writes:\s*`?([A-Za-z][A-Za-z-]*)(?=[`\s.,;)]|$)/i;

/** Lines outside fenced code blocks, as { text, index }. */
function proseLines(text) {
  const out = [];
  let fence = null;
  text.split(/\r?\n/).forEach((line, index) => {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return;
    }
    if (fence === null) out.push({ text: line, index });
  });
  return out;
}

/** Sections found by heading prefix: { name, level, body } (body is the text up to the next heading of the same or a higher level). */
function findSections(lines) {
  const heads = [];
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l.text);
    if (m) heads.push({ i, level: m[1].length, title: m[2] });
  });
  return heads.map((h, k) => {
    let end = lines.length;
    for (let j = k + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        end = heads[j].i;
        break;
      }
    }
    return { title: h.title, level: h.level, body: lines.slice(h.i + 1, end).map((l) => l.text).join('\n') };
  });
}

function checklistProblem(body) {
  const rows = body.split('\n').map((s) => s.trim()).filter(Boolean);
  const isSeparator = (s) => /^\|?[\s:|-]+\|?$/.test(s) && s.includes('-');
  const content = rows.filter((s) => !isSeparator(s));
  const tableRows = content.filter((s) => s.startsWith('|'));
  const other = content.filter((s) => !s.startsWith('|'));
  // A table counts when it has a data row beyond its header row.
  const hasData = tableRows.length > 1;
  const joined = other.join(' ');
  const none = /^\W*none\b(.*)$/is.exec(joined);
  if (none && !hasData) {
    return /[A-Za-z0-9]/.test(none[1]) ? null : 'says "none" without a reason';
  }
  if (hasData || other.length > 0) return null;
  return 'is empty (list the items, or write "none" with a reason)';
}

/**
 * The tasks of a spec, in order: { id, title, text, wave } where text is the bullet and its continuation lines and
 * wave is the id of the `## Wave <id>` heading above it (null outside a wave). Used by scripts/wave-args.js.
 * @param {string} text the spec markdown
 */
export function specTasks(text) {
  return findTasks(proseLines(text));
}

/** Tasks: { id, title, text } where text is the bullet and its continuation lines. */
function findTasks(lines) {
  const tasks = [];
  let cur = null;
  let wave = null;
  let waveLevel = 0;
  for (const l of lines) {
    const heading = /^(#{1,6})\s/.exec(l.text);
    if (heading) {
      // A wave heading starts a wave; a deeper heading inside it ("### Tail" under "## Wave 1") stays in it.
      const h = WAVE_HEADING.exec(l.text);
      if (h) {
        wave = h[1];
        waveLevel = heading[1].length;
      } else if (wave === null || heading[1].length <= waveLevel) {
        wave = null;
      }
    }
    const m = TASK_BULLET.exec(l.text);
    if (m) {
      cur = { id: m[1], title: m[2], text: l.text, wave };
      tasks.push(cur);
    } else if (/^\s*- \*\*/.test(l.text) || /^#{1,6}\s/.test(l.text) || (/^\S/.test(l.text) && l.text.trim() !== '')) {
      // Another bullet, a heading or an unindented paragraph ends the task.
      cur = null;
    } else if (cur) {
      cur.text += `\n${l.text}`;
    }
  }
  return tasks;
}

/** The text of a task's "Owns" clause: from "Owns" to the first sentence end outside backticks and brackets. */
function ownsClause(text) {
  const at = text.search(/\bOwns\b/);
  if (at < 0) return '';
  let tick = false;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '`') tick = !tick;
    else if (tick) continue;
    else if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (c === '.' && depth === 0 && (i + 1 >= text.length || /\s/.test(text[i + 1]))) return text.slice(at, i);
  }
  return text.slice(at);
}

/** Backticked paths in a task's Owns clause (a path has a "/" or a file extension and no spaces). */
export function ownedPaths(text) {
  const clause = ownsClause(text);
  const out = [];
  for (const m of clause.matchAll(/`([^`]+)`/g)) {
    const p = m[1].trim();
    if (!/\s/.test(p) && (p.includes('/') || /\.\w+$/.test(p)) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Task ids a task depends on ("Depends on ..." or "Deps: ..."). */
export function taskDeps(text) {
  const m = DEPENDS.exec(text);
  return m ? [...m[1].matchAll(TASK_ID)].map((x) => x[0]) : [];
}

/** The longest dependency chain inside one wave (ids, first to last); the tail (an id ending in .T) is not counted. */
function longestChain(tasks) {
  const byId = new Map(tasks.filter((t) => !/\.T$/i.test(t.id)).map((t) => [t.id, t]));
  const memo = new Map();
  const visit = (id, seen) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return [id]; // a cycle: stop here
    seen.add(id);
    let best = [];
    for (const d of taskDeps(byId.get(id).text)) {
      if (!byId.has(d)) continue;
      const c = visit(d, seen);
      if (c.length > best.length) best = c;
    }
    seen.delete(id);
    const chain = [...best, id];
    memo.set(id, chain);
    return chain;
  };
  let longest = [];
  for (const id of byId.keys()) {
    const c = visit(id, new Set());
    if (c.length > longest.length) longest = c;
  }
  return longest;
}

/** Shape warnings: deep or small waves, big tasks. */
function shapeWarnings(tasks) {
  const warnings = [];
  const waves = new Map();
  for (const t of tasks) {
    if (t.wave === null || t.wave === undefined) continue;
    if (!waves.has(t.wave)) waves.set(t.wave, []);
    waves.get(t.wave).push(t);
  }
  for (const [wave, list] of waves) {
    const chain = longestChain(list);
    if (chain.length > MAX_CHAIN_DEPTH) {
      warnings.push(`wave ${wave}: dependency chain ${chain.join(' -> ')} is ${chain.length} tasks deep (more than ${MAX_CHAIN_DEPTH}); each hop costs about 15 min of review, CI and merge, so do chain-shaped work as one PR with stacked commits, or widen the wave`);
    }
    if (list.length <= MAX_SMALL_WAVE) {
      warnings.push(`wave ${wave}: ${list.length} task${list.length === 1 ? '' : 's'}; a wave of ${MAX_SMALL_WAVE} or fewer goes out as single PRs, not through the wave loop`);
    }
  }
  for (const t of tasks) {
    const paths = ownedPaths(t.text);
    if (paths.length > MAX_OWNED_PATHS) {
      warnings.push(`task ${t.id}: owns ${paths.length} paths (more than about ${MAX_OWNED_PATHS}); split it, or keep it and expect a long worker`);
    }
    const migrations = paths.filter((p) => MIGRATION_PATH.test(p));
    if (migrations.length > 1) warnings.push(`task ${t.id}: adds ${migrations.length} migrations (${migrations.join(', ')}); one migration per task`);
  }
  return warnings;
}

/**
 * Lint a spec.
 * @param {string} text the spec markdown
 * @returns {{ ok: boolean, errors: string[], warnings: string[], review: { id: string, value: string }[], taskCount: number }}
 */
export function lintSpec(text) {
  const errors = [];
  const lines = proseLines(text);
  const sections = findSections(lines);

  for (const name of REQUIRED_SECTIONS) {
    const found = sections.find((s) => s.title.toLowerCase().startsWith(name.toLowerCase()));
    if (!found) {
      errors.push(`section "${name}": missing`);
    } else if (name === 'Human checklist') {
      const problem = checklistProblem(found.body);
      if (problem) errors.push(`section "Human checklist": ${problem}`);
    }
  }

  const tasks = findTasks(lines);
  const review = [];
  for (const t of tasks) {
    if (!/\bOwns\b/.test(t.text)) errors.push(`task ${t.id}: missing "Owns"`);
    if (!/\bTest\s*[:(]/.test(t.text)) errors.push(`task ${t.id}: missing "Test"`);

    const m = READS_OR_WRITES_LINE.exec(t.text);
    const value = m ? m[1].toLowerCase() : null;
    if (value !== null && !READS_OR_WRITES.includes(value)) {
      errors.push(`task ${t.id}: "Reads or writes:" value "${m[1]}" is not one of ${READS_OR_WRITES.join(', ')}`);
    } else if (value === null && ADDS_COMMAND.test(t.text)) {
      errors.push(`task ${t.id}: adds a command or script but has no "Reads or writes:" line (${READS_OR_WRITES.join(', ')})`);
    }
    const lane = LANE_LINE.exec(t.text);
    if (lane && !LANES.includes(lane[1])) {
      errors.push(`task ${t.id}: "Lane:" value "${lane[1]}" is not one of ${LANES.join(', ')}`);
    }
    if (value !== null && NEEDS_REVIEW.includes(value)) review.push({ id: t.id, value });
  }

  return { ok: errors.length === 0, errors, warnings: shapeWarnings(tasks), review, taskCount: tasks.length };
}

/**
 * CLI body with injected output, so tests can run it in-process.
 * @param {string[]} argv process.argv-shaped: [node, script, file]
 * @param {{ out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {number} the exit code
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const file = argv[2];
  if (!file || argv.length > 3) {
    err('usage: node scripts/spec-lint.js <spec.md>\n');
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    err(`spec-lint: cannot read ${file}: ${e.message}\n`);
    return 2;
  }
  const r = lintSpec(text);
  for (const x of r.review) {
    out(`needs human review: task ${x.id} (Reads or writes: ${x.value})\n`);
  }
  for (const w of r.warnings) out(`warning: ${w}\n`);
  if (!r.ok) {
    for (const e of r.errors) err(`spec-lint: ${e}\n`);
    err(`spec-lint: FAIL (${r.errors.length} problem${r.errors.length === 1 ? '' : 's'})\n`);
    return 1;
  }
  out(`spec-lint: OK (${r.taskCount} tasks)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
