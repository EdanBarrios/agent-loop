#!/usr/bin/env node
// spec-lint: structural check of a project spec before any wave runs.
//
//   node scripts/spec-lint.js <spec.md>
//
// Exit 0: spec passes (tasks that need human review are listed on stdout).
// Exit 1: at least one item is missing; each message names the section or the task id (stderr).
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

// A task is a command spec when its text says it adds a command, a script or a CLI (the spec's
// "Command specs" rule). Passing mentions ("exec(command)", "a command that prints") do not count.
const ADDS_COMMAND = /\b(?:adds?|adding|introduces?|new)\s+(?:(?:an?|the)\s+)?(?:CLI\s+command|CLI|command|script)\b/i;
const TASK_BULLET = /^- \*\*(\d+\.[0-9A-Za-z]+)\s+(.*?)\*\*/;
// The value must follow the label directly and end at a delimiter; a quoted mention such as
// "a `Reads or writes:` line" or "`Reads or writes: writes-db|paid-call|sends`" is not a value.
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

/** Tasks: { id, title, text } where text is the bullet and its continuation lines. */
function findTasks(lines) {
  const tasks = [];
  let cur = null;
  for (const l of lines) {
    const m = TASK_BULLET.exec(l.text);
    if (m) {
      cur = { id: m[1], title: m[2], text: l.text };
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

/**
 * Lint a spec.
 * @param {string} text the spec markdown
 * @returns {{ ok: boolean, errors: string[], review: { id: string, value: string }[], taskCount: number }}
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
    if (value !== null && NEEDS_REVIEW.includes(value)) review.push({ id: t.id, value });
  }

  return { ok: errors.length === 0, errors, review, taskCount: tasks.length };
}

function main(argv) {
  const file = argv[2];
  if (!file || argv.length > 3) {
    process.stderr.write('usage: node scripts/spec-lint.js <spec.md>\n');
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`spec-lint: cannot read ${file}: ${e.message}\n`);
    return 2;
  }
  const r = lintSpec(text);
  for (const x of r.review) {
    process.stdout.write(`needs human review: task ${x.id} (Reads or writes: ${x.value})\n`);
  }
  if (!r.ok) {
    for (const e of r.errors) process.stderr.write(`spec-lint: ${e}\n`);
    process.stderr.write(`spec-lint: FAIL (${r.errors.length} problem${r.errors.length === 1 ? '' : 's'})\n`);
    return 1;
  }
  process.stdout.write(`spec-lint: OK (${r.taskCount} tasks)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
