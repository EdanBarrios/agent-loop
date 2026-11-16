#!/usr/bin/env node
// Usage: node scripts/write-review.js <spec-review output file>
// Writes the review file of a spec-review run (loop 2.3.1). The workflow cannot write files, so its result carries
// reviewPath and writeBy 'session'; the argument is the run's output file (the runtime's JSON with the result under
// "result") or a file holding the result itself. The file written is exactly what the old writer agent wrote: the
// result as pretty JSON (2 spaces) plus a newline, without writeBy. A leading ~ in reviewPath is the home directory.
// Prints one JSON line { outcome: 'written'|'error', path, bytes, message? }; exit 0 written, 4 error.
// Reads or writes: writes-files (one review file, named <date>-wave-<n>-review.json).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

function done(line, code) {
  console.log(JSON.stringify(line));
  process.exitCode = code;
}

const input = process.argv[2];
if (!input || process.argv.length > 3) {
  done({ outcome: 'error', path: null, bytes: 0, message: 'usage: node scripts/write-review.js <spec-review output file>' }, 4);
} else {
  try {
    const raw = JSON.parse(readFileSync(input, 'utf8'));
    let result = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
    if (typeof result === 'string') result = JSON.parse(result);
    if (!result || typeof result !== 'object' || typeof result.reviewPath !== 'string' || !result.reviewPath) {
      throw new Error('no spec-review result with a reviewPath (was the run given a date?)');
    }
    const out = { ...result };
    delete out.writeBy;
    const path = result.reviewPath.startsWith('~/') ? resolve(homedir(), result.reviewPath.slice(2)) : resolve(result.reviewPath);
    if (!/-wave-[^/]+-review\.json$/.test(path)) throw new Error(`refusing to write ${path}: not a review file name`);
    const text = JSON.stringify(out, null, 2) + '\n';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    JSON.parse(readFileSync(path, 'utf8'));
    done({ outcome: 'written', path, bytes: Buffer.byteLength(text) }, 0);
  } catch (err) {
    done({ outcome: 'error', path: null, bytes: 0, message: err instanceof Error ? err.message : String(err) }, 4);
  }
}
