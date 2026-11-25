#!/usr/bin/env node
// Usage: node scripts/test-edits.js <pr> --repo <path> [--base <branch>]
// Reports the assertions a pull request removed or changed after its test-first commit (the first non-merge commit
// that adds or changes a test file), minus lines the branch took from the base branch through merge commits.
// Prints one JSON line: { testFirstCommit, files: [{ path, removed, changed }], assertionsRemoved, assertionsChanged,
// bodySection, note }. Test files come from `testGlobs` in <repo>/.claude/loop.local.json (default globs when the
// file or field is missing). See claude/lib/testedits.js for the exact rules.
// Exit codes: 0 report printed, 1 gh or git failed (the JSON line carries note "error: ..."), 4 bad usage.
// Reads or writes: reads (gh pr view, git; one `git fetch origin pull/<pr>/head` when the head commit is missing).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { testEditReport, testGlobsOf } from '../claude/lib/testedits.js';

const args = process.argv.slice(2);
let pr = null;
let repo = null;
let base = null;
let bad = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1] !== undefined) repo = args[++i];
  else if (args[i] === '--base' && args[i + 1] !== undefined) base = args[++i];
  else if (!args[i].startsWith('--') && pr === null) pr = args[i];
  else bad = true;
}

function print(report) {
  console.log(JSON.stringify(report));
}

const failed = (note) => ({ testFirstCommit: null, files: [], assertionsRemoved: 0, assertionsChanged: 0, bodySection: false, note });

if (bad || pr === null || !/^\d+$/.test(pr) || repo === null) {
  print(failed('usage: node scripts/test-edits.js <pr> --repo <path> [--base <branch>]'));
  process.exit(4);
}
const cwd = resolve(repo);

function run(file, fileArgs) {
  return new Promise((done) => {
    const child = spawn(file, fileArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => done({ code: 127, stdout, stderr: String(err.message) }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

let project = null;
try {
  project = JSON.parse(readFileSync(join(cwd, '.claude', 'loop.local.json'), 'utf8'));
} catch {
  // a missing or unreadable file gives the default globs
}

try {
  print(await testEditReport({ pr, base, globs: testGlobsOf(project) }, { run }));
} catch (err) {
  print(failed(`error: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
}
