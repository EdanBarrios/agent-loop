#!/usr/bin/env node
// Usage: node scripts/ci-only.js <pr> --repo <path> --since <reviewedHeadSha>
// Says whether PR <pr> changed only CI-only things since the head a critic approved: no new commit, formatting-only
// commits (a formatter or a lint autofix) and sync merges from the default branch with no conflict resolution.
// Prints one JSON line: { ciOnly, since, head, reason, commits, files }. The wave loop skips a second critic round
// when ciOnly is true (see claude/lib/delta.js for the exact rule). Exit 0 whenever the JSON line is printed, 4 on bad usage.
// Reads or writes: reads.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ciOnlyChange } from '../claude/lib/delta.js';

const args = process.argv.slice(2);
let pr = null;
let repo = null;
let since = null;
let bad = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1] !== undefined) repo = args[++i];
  else if (args[i] === '--since' && args[i + 1] !== undefined) since = args[++i];
  else if (!args[i].startsWith('--') && pr === null) pr = args[i];
  else bad = true;
}
if (bad || pr === null || !/^\d+$/.test(pr) || repo === null || since === null) {
  console.log(JSON.stringify({ ciOnly: false, since, head: null, reason: 'usage: node scripts/ci-only.js <pr> --repo <path> --since <sha>', commits: 0, files: [] }));
  process.exit(4);
}
const cwd = resolve(repo);

function run(command) {
  return new Promise((done) => {
    const child = spawn(command, {
      shell: true,
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

const result = await ciOnlyChange({ pr, since }, { run });
console.log(JSON.stringify(result));
