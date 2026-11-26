#!/usr/bin/env node
// Local CI for the benchmark (task 4.2): stands in for GitHub Actions in a replayed wave, with no CI minutes.
//
// A `post-receive` hook in the bare remote records one run per pushed sha and starts a detached runner for it, then
// exits 0 (git push waits for post-receive, and a push must never fail because of the recorder). The runner runs the
// project's install and check in a clean clone at that sha, at most BENCH_CI_JOBS at once (default 2, counted across
// processes with slot directories). One file per run: $BENCH_STATE/runs/<id>.json, written under a temporary name and
// renamed, shaped { id, sha, event, status, conclusion, startedAt, durationMs, logTail, branch, workflow, name }.
// `id` is a positive integer (the databaseId of `gh run list`); `status` is queued, in_progress or completed;
// `workflow` and `name` are the mainCi value of $BENCH_STATE/ci.json, which `prepare` writes from loop.local.json:
// { install, check, mainCi } plus the optional { remote, timeoutMs }. A missing ci.json is an error.
//
// Module use (4.1 calls these): enqueueRun(stateDir, { sha, branch, event }) and listRuns(stateDir).
// CLI (one JSON line on stdout, except `hook`, which prints nothing and always exits 0):
//   node bench/ci.js install-hook <remote.git> --state <stateDir>
//   node bench/ci.js run <stateDir> <id> [--remote <remote.git>]
//   node bench/ci.js hook <stateDir> <remote.git>          (reads post-receive lines on stdin)
// Reads or writes: writes-files.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const EVENTS = ['push', 'pull_request'];
const LOG_LINES = 200;
const LOG_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const ZEROS = /^0+$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runsDir = (stateDir) => join(stateDir, 'runs');

/** The environment for git and for the project's commands: the hook's own GIT_* variables must not leak into a clone. */
function cleanEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && k !== 'GIT_TERMINAL_PROMPT') delete env[k];
  return env;
}

/**
 * Reads $BENCH_STATE/ci.json. Throws when the file is missing or lacks a check or mainCi; install may be empty.
 * @param {string} stateDir
 * @returns {{ install: string, check: string, mainCi: string, remote?: string, timeoutMs?: number }}
 */
export function loadCiConfig(stateDir) {
  const path = join(stateDir, 'ci.json');
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`bench ci: cannot read ${path}: ${e.code === 'ENOENT' ? 'file is missing' : e.message}`);
  }
  if (cfg === null || typeof cfg !== 'object') throw new Error(`bench ci: ${path} must hold a JSON object`);
  for (const k of ['check', 'mainCi']) {
    if (typeof cfg[k] !== 'string' || cfg[k].trim() === '') throw new Error(`bench ci: ${path} needs a non-empty "${k}"`);
  }
  if (cfg.install !== undefined && typeof cfg.install !== 'string') throw new Error(`bench ci: ${path} "install" must be a string`);
  return { ...cfg, install: cfg.install ?? '' };
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Lists run ids found in the runs directory. */
function runIds(stateDir) {
  if (!existsSync(runsDir(stateDir))) return [];
  return readdirSync(runsDir(stateDir)).filter((n) => /^[1-9]\d*\.json$/.test(n)).map((n) => Number(n.slice(0, -5)));
}

/**
 * One run record, or null when there is none.
 * @param {string} stateDir
 * @param {number} id
 */
export function readRun(stateDir, id) {
  try {
    return JSON.parse(readFileSync(join(runsDir(stateDir), `${id}.json`), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Every run record, newest (highest id) first, like `gh run list`.
 * @param {string} stateDir
 */
export function listRuns(stateDir) {
  return runIds(stateDir).sort((a, b) => b - a).map((id) => readRun(stateDir, id)).filter((r) => r !== null);
}

/** Replaces a run record (temporary name, then rename). */
function saveRun(stateDir, run) {
  writeJsonAtomic(join(runsDir(stateDir), `${run.id}.json`), run);
}

/**
 * Records a queued run for a sha and, unless `start` is false, starts a detached runner for it.
 * `remote` (the bare remote to clone from) defaults to ci.json's `remote`, then $BENCH_REMOTE.
 * @param {string} stateDir
 * @param {{ sha: string, branch: string, event: 'push'|'pull_request', start?: boolean, remote?: string }} input
 * @returns the queued record
 */
export function enqueueRun(stateDir, { sha, branch, event, start = true, remote }) {
  if (!/^[0-9a-f]{40,64}$/i.test(String(sha))) throw new Error(`bench ci: bad sha ${JSON.stringify(sha)}`);
  if (!EVENTS.includes(event)) throw new Error(`bench ci: event must be one of ${EVENTS.join(', ')}, not ${JSON.stringify(event)}`);
  const cfg = loadCiConfig(stateDir);
  mkdirSync(runsDir(stateDir), { recursive: true });
  const record = {
    id: 0, sha, event, status: 'queued', conclusion: null, startedAt: new Date().toISOString(), durationMs: 0,
    logTail: '', branch, workflow: cfg.mainCi, name: cfg.mainCi,
  };
  // Take the next free id without overwriting: link() fails with EEXIST when another process took it first.
  const tmp = join(runsDir(stateDir), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  for (;;) {
    record.id = Math.max(0, ...runIds(stateDir)) + 1;
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
    try {
      linkSync(tmp, join(runsDir(stateDir), `${record.id}.json`));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  if (start) {
    const where = remote ?? cfg.remote ?? process.env.BENCH_REMOTE;
    const args = [SELF, 'run', resolve(stateDir), String(record.id)];
    if (where) args.push('--remote', resolve(where));
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env }).unref();
  }
  return record;
}

// ---- concurrency: BENCH_CI_JOBS slot directories shared by every runner process ----

function jobsLimit() {
  const n = Number.parseInt(process.env.BENCH_CI_JOBS ?? '', 10);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function slotIsStale(dir) {
  try {
    const pid = Number.parseInt(readFileSync(join(dir, 'pid'), 'utf8'), 10);
    if (Number.isInteger(pid)) return !pidAlive(pid);
  } catch {
    // no pid file yet: the owner may be between mkdir and write, so only an old directory counts as stale
  }
  try {
    return Date.now() - statSync(dir).mtimeMs > 10000;
  } catch {
    return false;
  }
}

/** Waits for a free slot and returns a function that releases it. */
async function acquireSlot(stateDir) {
  const base = join(stateDir, 'ci-slots');
  mkdirSync(base, { recursive: true });
  for (;;) {
    const jobs = jobsLimit();
    for (let n = 0; n < jobs; n++) {
      const dir = join(base, String(n));
      try {
        mkdirSync(dir);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (slotIsStale(dir)) rmSync(dir, { recursive: true, force: true });
        continue;
      }
      writeFileSync(join(dir, 'pid'), String(process.pid));
      return () => rmSync(dir, { recursive: true, force: true });
    }
    await sleep(100);
  }
}

// ---- running one command in the clean clone ----

function tailOf(text) {
  const lines = text.split('\n');
  let tail = lines.slice(-LOG_LINES).join('\n');
  if (tail.length > LOG_CHARS) tail = tail.slice(-LOG_CHARS);
  return tail;
}

/** Runs `sh -c command` in cwd; resolves { code, output }. A command past timeoutMs is killed (code null). */
function runCommand(command, cwd, timeoutMs) {
  return new Promise((done) => {
    const child = spawn('sh', ['-c', command], { cwd, env: cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (d) => {
      output += d;
      if (output.length > 4 * LOG_CHARS) output = output.slice(-2 * LOG_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: 127, output: output + `${e.message}\n` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: timedOut ? null : code, output: timedOut ? output + `timed out after ${timeoutMs} ms\n` : output });
    });
  });
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** A clean checkout of `sha` from the bare remote, in a fresh directory under the state directory. */
function checkoutClean(stateDir, remote, sha) {
  const base = join(stateDir, 'ci-work');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'run-'));
  const steps = [
    ['init', '-q'],
    ['fetch', '-q', '--no-tags', remote, sha],
    ['checkout', '-q', '--detach', sha],
  ];
  for (const step of steps) {
    const r = git(step, dir);
    if (!r.ok) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`git ${step[0]} failed: ${r.out.trim()}`);
    }
  }
  return dir;
}

/**
 * Runs one queued record to completion: waits for a slot, clones at the sha, runs install then check, and records
 * status in_progress, then completed with conclusion success or failure and the log tail. Never throws for a
 * failing run: any error lands in the record as a failure.
 * @param {string} stateDir
 * @param {number} id
 * @param {{ remote?: string }} [opts]
 */
export async function runRun(stateDir, id, { remote } = {}) {
  const record = readRun(stateDir, id);
  if (record === null) throw new Error(`bench ci: no run ${id} in ${runsDir(stateDir)}`);
  const release = await acquireSlot(stateDir);
  const t0 = Date.now();
  let dir = null;
  let log = '';
  let ok = false;
  try {
    record.status = 'in_progress';
    record.startedAt = new Date(t0).toISOString();
    saveRun(stateDir, record);
    const cfg = loadCiConfig(stateDir);
    const where = remote ?? cfg.remote ?? process.env.BENCH_REMOTE;
    if (!where) throw new Error('no remote to clone: pass --remote, or set "remote" in ci.json or BENCH_REMOTE');
    dir = checkoutClean(stateDir, resolve(where), record.sha);
    const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
    ok = true;
    for (const command of [cfg.install, cfg.check]) {
      if (command.trim() === '') continue;
      log += `$ ${command}\n`;
      const r = await runCommand(command, dir, timeoutMs);
      log += r.output.endsWith('\n') || r.output === '' ? r.output : r.output + '\n';
      if (r.code !== 0) {
        log += `exit ${r.code === null ? 'timeout' : r.code}\n`;
        ok = false;
        break;
      }
    }
  } catch (e) {
    ok = false;
    log += `bench ci: ${e.message}\n`;
  } finally {
    record.status = 'completed';
    record.conclusion = ok ? 'success' : 'failure';
    record.durationMs = Date.now() - t0;
    record.logTail = tailOf(log);
    // The slot is free as soon as the commands are done, and before the record says so, so a reader who sees
    // `completed` never finds this run still holding a slot.
    if (dir) rmSync(dir, { recursive: true, force: true });
    release();
    saveRun(stateDir, record);
  }
  return record;
}

// ---- the hook ----

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Installs the post-receive hook in a bare remote. The hook strips git's own environment, calls this file's `hook`
 * command with the post-receive lines on stdin and always exits 0.
 * @param {string} remote the bare remote
 * @param {string} stateDir $BENCH_STATE
 * @returns {string} the hook's path
 */
export function installHook(remote, stateDir) {
  const hooks = join(resolve(remote), 'hooks');
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, 'post-receive');
  const script = [
    '#!/bin/sh',
    '# agent-loop bench: record one run per pushed sha, start a detached runner, never fail the push',
    'for v in $(env | sed -n \'s/^\\(GIT_[A-Za-z0-9_]*\\)=.*/\\1/p\'); do unset "$v"; done',
    `${sq(process.execPath)} ${sq(SELF)} hook ${sq(resolve(stateDir))} ${sq(resolve(remote))}`,
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Turns post-receive lines ("<old> <new> <ref>") into the runs to record: one per pushed sha, event push for the
 * default branch and pull_request for every other branch (decided now, because a worker pushes before `gh pr create`).
 * Deleted refs and refs outside refs/heads are skipped; a sha pushed to several refs gets one run, push winning.
 * @param {string} stdin
 * @param {string} defaultRef e.g. refs/heads/main
 * @returns {{ sha: string, branch: string, event: 'push'|'pull_request' }[]}
 */
export function runsForPush(stdin, defaultRef) {
  const bySha = new Map();
  for (const line of stdin.split('\n')) {
    const [, sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref || ZEROS.test(sha) || !ref.startsWith('refs/heads/')) continue;
    const event = ref === defaultRef ? 'push' : 'pull_request';
    const seen = bySha.get(sha);
    if (!seen || (event === 'push' && seen.event !== 'push')) bySha.set(sha, { sha, branch: ref.slice('refs/heads/'.length), event });
  }
  return [...bySha.values()];
}

function hookMain(stateDir, remote, stdin) {
  const head = git(['--git-dir', remote, 'symbolic-ref', 'HEAD'], process.cwd());
  const defaultRef = head.ok ? head.out.trim() : 'refs/heads/main';
  for (const run of runsForPush(stdin, defaultRef)) {
    try {
      enqueueRun(stateDir, { ...run, remote });
    } catch (e) {
      process.stderr.write(`bench ci: not recorded for ${run.branch}: ${e.message}\n`);
    }
  }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === 'hook') {
    try {
      if (rest.length >= 2) hookMain(resolve(rest[0]), resolve(rest[1]), readStdin());
    } catch (e) {
      process.stderr.write(`bench ci: ${e.message}\n`);
    }
    return 0;
  }
  try {
    if (cmd === 'install-hook' && rest[0] && flag('--state')) {
      console.log(JSON.stringify({ hook: installHook(rest[0], flag('--state')) }));
      return 0;
    }
    if (cmd === 'run' && rest[0] && /^[1-9]\d*$/.test(rest[1] ?? '')) {
      const r = await runRun(resolve(rest[0]), Number(rest[1]), { remote: flag('--remote') });
      console.log(JSON.stringify({ id: r.id, status: r.status, conclusion: r.conclusion }));
      return 0;
    }
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    return 1;
  }
  console.log(JSON.stringify({ error: 'usage: ci.js install-hook <remote> --state <dir> | run <stateDir> <id> [--remote <remote>] | hook <stateDir> <remote>' }));
  return 4;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
