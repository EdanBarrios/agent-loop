#!/usr/bin/env node
// Usage: node scripts/isolation.js --repo <path>
// Prints one JSON line: { sandbox: { enabled, source }, denyReads: { present, missing }, warnings }, from the user,
// project, project local and managed settings files (claude/lib/isolation.js). `warnings` entries are one of
// `sandbox is not enabled`, `deny rule missing: <rule>` and `settings file unparseable: <path>`.
// Exit codes: 0 printed, 4 bad usage. It only reads: it never writes a setting (v2.4 invariant 6).
// Reads or writes: reads.
import { readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { checkIsolation, readSettingsDocs, settingsPaths } from '../claude/lib/isolation.js';

const args = process.argv.slice(2);
let repo = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo') repo = args[++i] ?? null;
  else {
    repo = null;
    break;
  }
}
if (!repo) {
  process.stderr.write('usage: node scripts/isolation.js --repo <path>\n');
  process.exit(4);
}

const home = process.env.HOME || homedir();
const docs = readSettingsDocs(settingsPaths(home, resolve(repo)), (path) => readFileSync(path, 'utf8'));
writeSync(1, `${JSON.stringify(checkIsolation(docs))}\n`);
