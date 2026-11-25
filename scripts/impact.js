#!/usr/bin/env node
// Usage: node scripts/impact.js --repo <path> --owns <path>... [--spec <spec.md>]
// Lists the existing test files that import an owned path directly or through one intermediate non-test module.
// Prints one JSON line: { tests: [{ path, via, owner }] }, where `via` names the intermediate module (null when the
// import is direct) and `owner` is the task id whose Owns line in --spec lists the test file (null when none does or
// without --spec). Test files come from `testGlobs` in <repo>/.claude/loop.local.json (default globs when the file or
// field is missing); aliases come from `compilerOptions.paths` in <repo>/tsconfig.json. See claude/lib/impact.js.
// Exit codes: 0 map printed, 1 git or the spec failed (the JSON line carries `tests: []` and note "error: ..."),
// 4 bad usage.
// Reads or writes: reads (`git ls-files` and the repo's source files).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { impactMap } from '../claude/lib/impact.js';
import { testGlobsOf } from '../claude/lib/testedits.js';

const args = process.argv.slice(2);
let repo = null;
let spec = null;
const owns = [];
let bad = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1] !== undefined) repo = args[++i];
  else if (args[i] === '--spec' && args[i + 1] !== undefined) spec = args[++i];
  else if (args[i] === '--owns') {
    let n = 0;
    while (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
      owns.push(args[++i]);
      n++;
    }
    if (n === 0) bad = true;
  } else bad = true;
}

function print(report) {
  console.log(JSON.stringify(report));
}

if (bad || repo === null || owns.length === 0) {
  print({ tests: [], note: 'usage: node scripts/impact.js --repo <path> --owns <path>... [--spec <spec.md>]' });
  process.exit(4);
}
const cwd = resolve(repo);

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

try {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (ls.error || ls.status !== 0) throw new Error('git ls-files failed');
  const files = ls.stdout.split('\0').filter((f) => f !== '');
  let project = null;
  try {
    project = JSON.parse(readFileSync(join(cwd, '.claude', 'loop.local.json'), 'utf8'));
  } catch {
    // a missing or unreadable file gives the default globs
  }
  let specText = null;
  if (spec !== null) {
    try {
      specText = readFileSync(resolve(spec), 'utf8');
    } catch {
      throw new Error('cannot read the spec file');
    }
  }
  print(
    await impactMap(
      { files, owns, globs: testGlobsOf(project), tsconfig: readOrNull(join(cwd, 'tsconfig.json')), spec: specText },
      { read: (path) => readOrNull(join(cwd, path)) },
    ),
  );
} catch (err) {
  print({ tests: [], note: `error: ${err instanceof Error ? err.message : String(err)}` });
  process.exitCode = 1;
}
