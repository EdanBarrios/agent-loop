#!/usr/bin/env node
// bench: the controlled benchmark of the loop (task 4.3). Replays one task graph from one starting commit under a loop
// configuration, with the fake gh and the local CI of bench/, and reports what happened.
//
//   node scripts/bench.js prepare <scenario> --loop <loop checkout> --out <dir> [--config <overrides.json>] [--source <repo>] [--ci-jobs <n>]
//   node scripts/bench.js doctor <dir>
//   node scripts/bench.js sample <dir> [--every-s 30]
//   node scripts/bench.js collect <dir> <run output.json>...
//   node scripts/bench.js compare <record.json>...
//
// prepare prints the allow rules H7 needs and the environment for the session; it never writes a settings file. doctor
// exits 1 unless the shell is the one the environment describes. sample appends { t, load1 } to $BENCH_STATE/load.jsonl
// until <dir>/state/sample.pid is removed (start it in the background after prepare). collect prints one record; compare
// groups records by config and prints means with 95% intervals and the differences between configs.
// Every command prints one JSON line on stdout. Exit 0: done. Exit 1: refused or failed (the line has `error` or `problems`).
// Exit 2: usage.
//
// Reads or writes: writes-files (prepare, sample); reads (doctor, collect, compare), plus a scratch clone for collect.
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareRecords } from '../bench/metrics.js';
import { collect, doctor, prepare, readMeta, runSampler } from '../bench/scenario.js';

const USAGE = [
  'usage: bench.js prepare <scenario> --loop <loop checkout> --out <dir> [--config <overrides.json>] [--source <repo>] [--ci-jobs <n>]',
  '       bench.js doctor <dir>',
  '       bench.js sample <dir> [--every-s 30]',
  '       bench.js collect <dir> <run output.json>...',
  '       bench.js compare <record.json>...',
].join('\n');

/** Splits argv into positional words and --flag values. */
function parse(argv, valued) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (!valued.includes(a)) throw Object.assign(new Error(`unknown flag ${a}`), { usage: true });
      if (i + 1 >= argv.length) throw Object.assign(new Error(`${a} needs a value`), { usage: true });
      flags[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

/** Records in a file: one JSON value, an array of records, or one record per line. */
function readRecords(file) {
  const text = readFileSync(file, 'utf8');
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch {
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
}

/**
 * CLI body with injected output.
 * @param {string[]} argv arguments after the script name
 * @param {{ out?: (s: string) => void, err?: (s: string) => void, env?: NodeJS.ProcessEnv }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const print = (v) => out(JSON.stringify(v) + '\n');
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'prepare') {
      const { pos, flags } = parse(rest, ['--loop', '--out', '--config', '--source', '--ci-jobs']);
      if (pos.length !== 1 || !flags.loop || !flags.out) throw Object.assign(new Error('prepare needs a scenario, --loop and --out'), { usage: true });
      const ciJobs = flags['ci-jobs'] === undefined ? undefined : Number(flags['ci-jobs']);
      if (ciJobs !== undefined && !(Number.isInteger(ciJobs) && ciJobs >= 1)) throw Object.assign(new Error('--ci-jobs must be a whole number of at least 1'), { usage: true });
      print(prepare(pos[0], { loop: flags.loop, out: flags.out, config: flags.config, source: flags.source, ciJobs }));
      return 0;
    }
    if (cmd === 'doctor') {
      const { pos } = parse(rest, []);
      if (pos.length !== 1) throw Object.assign(new Error('doctor needs <dir>'), { usage: true });
      const r = doctor(pos[0], io.env ?? process.env);
      print(r);
      return r.ok ? 0 : 1;
    }
    if (cmd === 'sample') {
      const { pos, flags } = parse(rest, ['--every-s']);
      if (pos.length !== 1) throw Object.assign(new Error('sample needs <dir>'), { usage: true });
      const everyS = flags['every-s'] === undefined ? 30 : Number(flags['every-s']);
      if (!(everyS > 0)) throw Object.assign(new Error('--every-s must be a positive number'), { usage: true });
      const meta = readMeta(pos[0]);
      const state = join(meta.out, 'state');
      // a signal stops the sampler the way removing its pid file does
      for (const sig of ['SIGTERM', 'SIGINT']) {
        process.once(sig, () => {
          rmSync(join(state, 'sample.pid'), { force: true });
          process.exit(0);
        });
      }
      const n = await runSampler(state, { everyS });
      print({ samples: n });
      return 0;
    }
    if (cmd === 'collect') {
      const { pos } = parse(rest, []);
      if (pos.length < 2) throw Object.assign(new Error('collect needs <dir> and at least one run output file'), { usage: true });
      print(collect(pos[0], pos.slice(1).map((f) => resolve(f))));
      return 0;
    }
    if (cmd === 'compare') {
      const { pos } = parse(rest, []);
      if (pos.length < 1) throw Object.assign(new Error('compare needs at least one record file'), { usage: true });
      print(compareRecords(pos.flatMap((f) => readRecords(resolve(f)))));
      return 0;
    }
    err(`${USAGE}\n`);
    return 2;
  } catch (e) {
    if (e.usage) {
      err(`bench: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    print({ error: e.message });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
