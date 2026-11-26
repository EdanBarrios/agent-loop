#!/usr/bin/env node
// Usage: node scripts/escaped.js --repo <path> [--since <YYYY-MM-DD>] [--prefix task/]
// Traces defects that escaped into later fix commits on the default branch back to the task PR that introduced the
// lines. Prints one JSON line: { tasks: { "<task id>": { pr, prs, escaped, fixes: [{ sha, title, kind, files,
// lines }] } }, scanned, note }. See claude/lib/escaped.js for the exact rules.
// Exit codes: 0 report printed, 1 gh or git failed (the JSON line carries note "error: ..."), 4 bad usage.
// Reads or writes: reads (gh pr list, gh pr view, git log, git diff, git blame).
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { escapedReport } from '../claude/lib/escaped.js';

const args = process.argv.slice(2);
let repo = null;
let since = null;
let prefix = 'task/';
let bad = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1] !== undefined) repo = args[++i];
  else if (args[i] === '--since' && args[i + 1] !== undefined) since = args[++i];
  else if (args[i] === '--prefix' && args[i + 1] !== undefined) prefix = args[++i];
  else bad = true;
}

function print(report) {
  console.log(JSON.stringify(report));
}

const failed = (note) => ({ tasks: {}, scanned: 0, note });

if (bad || repo === null || prefix === '' || (since !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))))) {
  print(failed('usage: node scripts/escaped.js --repo <path> [--since <YYYY-MM-DD>] [--prefix task/]'));
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

try {
  print(await escapedReport({ since, prefix }, { run }));
} catch (err) {
  print(failed(`error: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
}
