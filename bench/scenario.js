// Benchmark scenarios (task 4.3): `prepare`, `doctor`, `sample` and `collect` behind scripts/bench.js.
//
// A scenario is { name, source, baseSha, spec, wave, holdout: [test files], holdoutTotal, holdoutCommand, project } in
// bench/scenarios/<name>.json. `source` is "loop" (the loop checkout given to prepare holds baseSha) or
// "seed:<dir>" (a directory next to the scenario file that is committed, with a fixed identity and date, into a
// throwaway repository whose commit is baseSha). The holdout files are kept in <name>.holdout/ (or `holdoutDir`) under
// their repository paths; they never enter the clone the agents work in.
//
// prepare makes, under <out>: remote.git (a bare remote holding only the history up to baseSha, pushed from the source
// with `git push <sha>:refs/heads/main`, never `git clone --bare`, so no later commit, tag or refs/pull object comes
// along), clone (a working clone of that remote, with the loop linked by install.sh and a loop.local.json), holdout
// (the held-out tests), state (ci.json for bench/ci.js, runs, prs, load.jsonl), bin/gh (the fake gh), worktrees, and
// bench.json (what doctor, sample and collect read). It prints the allow rules H7 needs and the environment of the
// session, and writes no settings file (invariant 6).
// Reads or writes: writes-files.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { loadavg as osLoadavg, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHook } from './ci.js';
import { buildRecord, parseHoldoutOutput, summarizeLoad } from './metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this module belongs to (it holds bench/bin/gh and scripts/). */
export const BENCH_ROOT = resolve(HERE, '..');
export const SCENARIOS_DIR = join(HERE, 'scenarios');
export const BENCH_GITHUB = 'bench.invalid/bench';
const PER_RUN_PATHS = ['repo', 'worktrees', 'github'];
/** The scripts a relay runs (H1, H2, H3); a rule is printed for each one the loop checkout has. */
const RELAY_SCRIPTS = ['merge-pr.js', 'wait-ci.js', 'ci-only.js', 'impact.js', 'test-edits.js', 'dep-state.js', 'isolation.js'];
const SEED_IDENTITY = { name: 'Bench Seed', email: 'seed@example.invalid', date: '2026-01-01T00:00:00Z' };
const STEP_TIMEOUT_MS = 20 * 60 * 1000;

/** The environment for git and for the project's commands: no GIT_* or BENCH_* variable of the session leaks in. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') || k.startsWith('BENCH_')) delete env[k];
  return { ...env, ...extra };
}

function git(cwd, args, extraEnv = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(extraEnv) });
  if (r.status !== 0) throw new Error(`bench: git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout || String(r.error)).trim()}`);
  return r.stdout.trim();
}

// ---- configuration ----

/** JSON with the keys of every object sorted, so equal settings give equal text. */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `overrides` merged over `base` field by field: objects merge recursively, anything else (arrays included) replaces.
 * The per-run paths (repo, worktrees, github) cannot be overridden: the safety rule of `prepare` owns them.
 */
export function mergeProject(base, overrides) {
  for (const k of PER_RUN_PATHS) {
    if (overrides && Object.hasOwn(overrides, k)) throw new Error(`bench: the config may not set "${k}": prepare sets it (github is always ${BENCH_GITHUB})`);
  }
  const merge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v;
    return out;
  };
  return merge(base ?? {}, overrides ?? {});
}

/**
 * The config key `collect` records and `compare` groups by: the sha-256 of the canonical JSON of the merged project
 * without the per-run paths, plus the loop checkout's commit and LOOP_VERSION, the scenario name and BENCH_CI_JOBS.
 */
export function configKey({ project, loopCommit, loopVersion, scenario, ciJobs }) {
  const p = { ...project };
  for (const k of PER_RUN_PATHS) delete p[k];
  return createHash('sha256').update(canonicalJson({ project: p, loopCommit, loopVersion, scenario, ciJobs })).digest('hex');
}

// ---- scenarios ----

/**
 * Reads a scenario by name (bench/scenarios/<name>.json) or by path to a .json file.
 * @returns {{ scenario: object, file: string, dir: string, holdoutDir: string }}
 */
export function loadScenario(ref) {
  const file = /\.json$/.test(ref) || ref.includes('/') ? resolve(ref) : join(SCENARIOS_DIR, `${ref}.json`);
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`bench: cannot read scenario ${file}: ${e.code === 'ENOENT' ? 'file is missing' : e.message}`);
  }
  for (const k of ['name', 'source', 'spec', 'wave']) {
    if (typeof scenario[k] !== 'string' || scenario[k] === '') throw new Error(`bench: scenario ${file} needs a non-empty "${k}"`);
  }
  if (!/^[0-9a-f]{40}$/.test(scenario.baseSha ?? '')) throw new Error(`bench: scenario ${file} needs a full 40-hex "baseSha"`);
  if (!Array.isArray(scenario.holdout) || scenario.holdout.length === 0) throw new Error(`bench: scenario ${file} needs a "holdout" list`);
  if (!isPlain(scenario.project)) throw new Error(`bench: scenario ${file} needs a "project" object`);
  const dir = dirname(file);
  return { scenario, file, dir, holdoutDir: join(dir, scenario.holdoutDir ?? `${scenario.name}.holdout`) };
}

/** A repository-relative path that stays inside the repository. */
function safeRel(p) {
  const n = normalize(p);
  if (isAbsolute(p) || n.startsWith('..') || n === '.') throw new Error(`bench: ${JSON.stringify(p)} is not a path inside the repository`);
  return n;
}

/**
 * Commits a seed directory into a new repository at `dest` with a fixed identity and date, so the commit sha is the same
 * on every machine. Returns the commit sha.
 * @param {string} seedDir
 * @param {string} dest must not exist
 */
export function buildSeedRepo(seedDir, dest) {
  if (existsSync(dest)) throw new Error(`bench: ${dest} exists`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(seedDir, dest, { recursive: true });
  const id = {
    GIT_AUTHOR_NAME: SEED_IDENTITY.name, GIT_AUTHOR_EMAIL: SEED_IDENTITY.email, GIT_AUTHOR_DATE: SEED_IDENTITY.date,
    GIT_COMMITTER_NAME: SEED_IDENTITY.name, GIT_COMMITTER_EMAIL: SEED_IDENTITY.email, GIT_COMMITTER_DATE: SEED_IDENTITY.date,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  git(dest, ['init', '-q', '-b', 'main'], id);
  git(dest, ['add', '-A'], id);
  git(dest, ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Seed repository'], id);
  return git(dest, ['rev-parse', 'HEAD'], id);
}

function loopInfo(loop) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: loop, encoding: 'utf8', env: cleanEnv() });
  const commit = r.status === 0 ? r.stdout.trim() : 'unknown';
  let version = 'unknown';
  try {
    const m = /^const LOOP_VERSION = '([^']+)'/m.exec(readFileSync(join(loop, 'claude', 'workflows', 'wave-loop.js'), 'utf8'));
    if (m) version = m[1];
  } catch {
    try {
      version = JSON.parse(readFileSync(join(loop, 'package.json'), 'utf8')).version ?? 'unknown';
    } catch {
      // keep "unknown"
    }
  }
  return { commit, version };
}

// ---- prepare ----

/**
 * Builds a run directory for a scenario. See the header for what it holds.
 * @param {string} ref scenario name or path to its .json
 * @param {{ loop: string, out: string, config?: string | object, source?: string, ciJobs?: number }} opts
 *   source overrides the scenario's source (a repository holding baseSha); config is a path to a JSON file or an object.
 */
export function prepare(ref, opts) {
  const { scenario: sc, holdoutDir } = loadScenario(ref);
  const loop = resolve(opts.loop ?? '');
  if (!opts.loop || !existsSync(join(loop, 'install.sh'))) throw new Error(`bench: --loop must be a loop checkout (no install.sh in ${loop})`);
  if (!opts.out) throw new Error('bench: --out <dir> is required');
  const out = resolve(opts.out);
  if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length > 0)) throw new Error(`bench: --out ${out} exists and is not an empty directory`);
  const ciJobs = Number.isInteger(opts.ciJobs) && opts.ciJobs >= 1 ? opts.ciJobs : 2;
  let overrides = opts.config ?? {};
  if (typeof overrides === 'string') {
    try {
      overrides = JSON.parse(readFileSync(overrides, 'utf8'));
    } catch (e) {
      throw new Error(`bench: cannot read --config ${overrides}: ${e.message}`);
    }
  }
  if (!isPlain(overrides)) throw new Error('bench: --config must hold a JSON object');

  const clone = join(out, 'clone');
  const remote = join(out, 'remote.git');
  const state = join(out, 'state');
  const worktrees = join(out, 'worktrees');
  const project = mergeProject({ name: `bench-${sc.name}`, spec: sc.spec, ...sc.project }, overrides);
  const full = { ...project, repo: clone, github: BENCH_GITHUB, worktrees };
  const loopId = loopInfo(loop);
  const key = configKey({ project: full, loopCommit: loopId.commit, loopVersion: loopId.version, scenario: sc.name, ciJobs });
  const holdoutPaths = sc.holdout.map(safeRel);
  for (const p of holdoutPaths) {
    if (!existsSync(join(holdoutDir, p))) throw new Error(`bench: the holdout copy ${join(holdoutDir, p)} is missing`);
  }

  mkdirSync(out, { recursive: true });
  // 1. the bare remote: only the history up to baseSha
  let source = opts.source ? resolve(opts.source) : null;
  let seed = null;
  if (!source && sc.source === 'loop') source = loop;
  if (!source) {
    const m = /^seed:(.+)$/.exec(sc.source);
    if (!m) throw new Error(`bench: unknown source ${JSON.stringify(sc.source)} (use "loop" or "seed:<dir>")`);
    seed = join(out, '.seed');
    const sha = buildSeedRepo(join(SCENARIOS_DIR, safeRel(m[1])), seed);
    if (sha !== sc.baseSha) throw new Error(`bench: the seed builds commit ${sha}, not baseSha ${sc.baseSha}`);
    source = seed;
  }
  git(out, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(source, ['push', '-q', remote, `${sc.baseSha}:refs/heads/main`]);
  if (seed) rmSync(seed, { recursive: true, force: true });
  // 2. the working clone, whose origin is the bare remote
  git(out, ['clone', '-q', remote, clone]);
  if (git(clone, ['rev-parse', 'HEAD']) !== sc.baseSha) throw new Error(`bench: the clone is not at baseSha ${sc.baseSha}`);
  // 3. the holdout tests live outside the clone
  for (const p of holdoutPaths) {
    const inBase = spawnSync('git', ['cat-file', '-e', `${sc.baseSha}:${p.split(sep).join('/')}`], { cwd: clone, env: cleanEnv() }).status === 0;
    if (inBase) throw new Error(`bench: holdout file ${p} exists at baseSha; the agents would see it`);
    mkdirSync(dirname(join(out, 'holdout', p)), { recursive: true });
    cpSync(join(holdoutDir, p), join(out, 'holdout', p));
  }
  // 4. loop.local.json, then the loop links (install.sh also writes the gh rule from the github field)
  mkdirSync(join(clone, '.claude'), { recursive: true });
  writeFileSync(join(clone, '.claude', 'loop.local.json'), JSON.stringify(full, null, 2) + '\n');
  mkdirSync(worktrees, { recursive: true });
  const inst = spawnSync('bash', [join(loop, 'install.sh'), clone], { encoding: 'utf8', env: cleanEnv() });
  if (inst.status !== 0) throw new Error(`bench: install.sh failed: ${(inst.stderr || inst.stdout).trim()}`);
  // 5. the local CI, the fake gh and the metadata
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'ci.json'), JSON.stringify({ install: full.install ?? '', check: full.check, mainCi: full.mainCi, remote }, null, 2) + '\n');
  installHook(remote, state);
  mkdirSync(join(out, 'bin'), { recursive: true });
  symlinkSync(join(BENCH_ROOT, 'bench', 'bin', 'gh'), join(out, 'bin', 'gh'));
  const holdout = { paths: holdoutPaths, total: sc.holdoutTotal ?? null, command: sc.holdoutCommand ?? null };
  const meta = { out, scenario: sc.name, wave: sc.wave, baseSha: sc.baseSha, configKey: key, ciJobs, loop: { path: loop, ...loopId }, project: full, holdout, holdoutTotal: sc.holdoutTotal ?? null };
  writeFileSync(join(out, 'bench.json'), JSON.stringify(meta, null, 2) + '\n');

  const rules = RELAY_SCRIPTS.filter((s) => existsSync(join(loop, 'scripts', s))).map((s) => `Bash(node ${clone}/.claude/scripts/${s} *)`);
  const env = { PATH: `${out}/bin:$PATH`, BENCH_STATE: state, BENCH_CI_JOBS: String(ciJobs) };
  return {
    out, clone, remote, state, baseSha: sc.baseSha, scenario: sc.name, wave: sc.wave, configKey: key, loop: loopId, rules, env,
    exports: Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
    waveArgsCommand: `node ${clone}/.claude/scripts/wave-args.js --repo ${clone} --wave ${sc.wave}`,
    holdout: { dir: join(out, 'holdout'), ...holdout },
    next: `export the environment, run \`node scripts/bench.js doctor ${out}\` in the same Bash call as the wave, and start \`node scripts/bench.js sample ${out}\` in the background`,
  };
}

/** The metadata of a prepared directory. A directory that is not the --out its rules name (a copy, a move) is refused. */
export function readMeta(dir) {
  const d = resolve(dir);
  let meta;
  try {
    meta = JSON.parse(readFileSync(join(d, 'bench.json'), 'utf8'));
  } catch (e) {
    throw new Error(`bench: ${d} is not a prepared directory (${e.code === 'ENOENT' ? 'no bench.json' : e.message})`);
  }
  let same = false;
  try {
    same = realpathSync(d) === realpathSync(meta.out);
  } catch {
    same = false;
  }
  if (!same) throw new Error(`bench: ${d} is not the --out its allow rules name (${meta.out}); run prepare again with the directory the rules should name`);
  return meta;
}

// ---- doctor ----

/**
 * Checks the session's shell: `command -v gh` is <dir>/bin/gh, `gh pr list` answers from BENCH_STATE, and BENCH_STATE and
 * BENCH_CI_JOBS are the printed ones.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function doctor(dir, env = process.env) {
  const meta = readMeta(dir);
  const problems = [];
  const state = join(meta.out, 'state');
  const same = (a, b) => {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return resolve(a) === resolve(b);
    }
  };
  if (!env.BENCH_STATE) problems.push(`BENCH_STATE is not set (expected ${state})`);
  else if (!same(env.BENCH_STATE, state)) problems.push(`BENCH_STATE is ${env.BENCH_STATE}, expected ${state}`);
  if (!env.BENCH_CI_JOBS) problems.push(`BENCH_CI_JOBS is not set (expected ${meta.ciJobs})`);
  else if (env.BENCH_CI_JOBS !== String(meta.ciJobs)) problems.push(`BENCH_CI_JOBS is ${env.BENCH_CI_JOBS}, expected ${meta.ciJobs} (it is part of the config key)`);
  const want = join(meta.out, 'bin', 'gh');
  const found = spawnSync('sh', ['-c', 'command -v gh'], { encoding: 'utf8', env }).stdout.trim();
  if (found !== want) problems.push(`command -v gh is ${found || '(not found)'}, expected ${want}: put ${join(meta.out, 'bin')} first on PATH`);
  else {
    const r = spawnSync('sh', ['-c', 'gh pr list --json number'], { encoding: 'utf8', env, cwd: join(meta.out, 'clone') });
    let answered = false;
    if (r.status === 0) {
      try {
        answered = Array.isArray(JSON.parse(r.stdout));
      } catch {
        answered = false;
      }
    }
    if (!answered) problems.push(`gh pr list did not answer from BENCH_STATE: ${(r.stderr || r.stdout || 'no output').trim().slice(0, 200)}`);
  }
  return { ok: problems.length === 0, problems };
}

// ---- sample ----

/**
 * Appends { t, load1 } lines to <state>/load.jsonl every `everyS` seconds until <state>/sample.pid is removed. Returns the
 * number of samples. `sleep(ms)` is called once per sample; the default returns early when the pid file goes away.
 * @param {string} stateDir
 * @param {{ everyS?: number, loadavg?: () => number[], now?: () => number, sleep?: (ms: number) => Promise<void> }} [opts]
 */
export async function runSampler(stateDir, opts = {}) {
  const pidFile = join(stateDir, 'sample.pid');
  const everyMs = Math.max(1, (opts.everyS ?? 30) * 1000);
  const loadavg = opts.loadavg ?? osLoadavg;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? (async (ms) => {
    for (let left = ms; left > 0 && existsSync(pidFile); left -= 250) await new Promise((r) => setTimeout(r, Math.min(250, left)));
  });
  if (existsSync(pidFile)) {
    const old = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    let alive = false;
    try {
      alive = old > 0 && process.kill(old, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`bench: a sampler is already running (pid ${old}); remove ${pidFile} to stop it`);
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pidFile, `${process.pid}\n`);
  let n = 0;
  while (existsSync(pidFile)) {
    appendFileSync(join(stateDir, 'load.jsonl'), JSON.stringify({ t: now(), load1: loadavg()[0] }) + '\n');
    n++;
    await sleep(everyMs);
  }
  return n;
}

// ---- collect ----

/** The load samples of a prepared directory, or null when the sampler never ran. */
function readLoad(stateDir) {
  const file = join(stateDir, 'load.jsonl');
  if (!existsSync(file)) return null;
  const samples = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const s = JSON.parse(line);
      if (s && Number.isFinite(s.load1)) samples.push(s);
    } catch {
      // a torn or blank line
    }
  }
  return summarizeLoad(samples);
}

/**
 * Runs the holdout tests on the final default branch: a scratch clone of the bare remote, the holdout files copied over
 * their paths (over the tail task's own test, where wave 1's tail lands at the same path), the project's install, then the
 * scenario's holdoutCommand. passed is null when that could not be measured (no command, a failed install or no count).
 * @returns {{ passed: number | null, total: number | null, error?: string }}
 */
export function runHoldout(dir, meta) {
  const total = meta.holdoutTotal ?? null;
  if (!meta.holdout?.command) return { passed: null, total, error: 'the scenario has no holdoutCommand' };
  const scratch = mkdtempSync(join(tmpdir(), 'bench-holdout-'));
  try {
    const wt = join(scratch, 'wt');
    git(scratch, ['clone', '-q', join(meta.out, 'remote.git'), wt]);
    for (const p of meta.holdout.paths) {
      mkdirSync(dirname(join(wt, p)), { recursive: true });
      cpSync(join(meta.out, 'holdout', p), join(wt, p));
    }
    const sh = (cmd) => spawnSync('sh', ['-c', cmd], { cwd: wt, encoding: 'utf8', env: cleanEnv(), timeout: STEP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const install = meta.project?.install;
    if (install) {
      const i = sh(install);
      if (i.status !== 0) return { passed: null, total, error: `install failed: ${(i.stderr || i.stdout || '').trim().slice(-300)}` };
    }
    const r = sh(meta.holdout.command);
    const counted = parseHoldoutOutput(`${r.stdout}\n${r.stderr}`);
    if (!counted) return { passed: null, total, error: `no pass count in the output: ${(r.stderr || r.stdout || '').trim().slice(-300)}` };
    return { passed: counted.passed, total: total ?? counted.total };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The record of a run: reads <dir>/bench.json, the workflow outputs and the load samples, and runs the holdout tests on
 * the final default branch.
 * @param {string} dir
 * @param {string[]} outputFiles workflow run outputs ({ result, workflowProgress }), in launch order
 */
export function collect(dir, outputFiles) {
  const meta = readMeta(dir);
  if (outputFiles.length === 0) throw new Error('bench: collect needs at least one run output file');
  const outputs = outputFiles.map((f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8'));
    } catch (e) {
      throw new Error(`bench: cannot read run output ${f}: ${e.message}`);
    }
  });
  const holdout = runHoldout(dir, meta);
  const record = buildRecord({ meta, outputs, load: readLoad(join(meta.out, 'state')), holdout });
  if (holdout.error) record.holdoutError = holdout.error;
  return record;
}
