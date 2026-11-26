import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main as specLint } from '../scripts/spec-lint.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { buildSeedRepo, configKey, mergeProject, prepare } from '../bench/scenario.js';

// Task 4.3: scenarios and `bench.js prepare|doctor`. Real git, no network, no agent. The CI checkout is shallow, so the
// v2.4 wave 1 base commit does not exist there: prepare is tried on a fixture source repo this test builds, and the real
// scenario files are only checked for their shape and their copies.
const root = join(import.meta.dirname, '..');
const BENCH = join(root, 'scripts', 'bench.js');
const SCENARIOS = join(root, 'bench', 'scenarios');
const dirs: string[] = [];
vi.setConfig({ testTimeout: 120000 });
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') || k.startsWith('BENCH_')) delete env[k];
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'Bench';
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'bench@example.invalid';
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tmp(label: string) {
  const d = mkdtempSync(join(tmpdir(), `bench-sc-${label}-`));
  dirs.push(d);
  return d;
}

type Fx = { dir: string; source: string; baseSha: string; laterSha: string; scenarios: string; scenarioFile: string };
/** A source repo with a base commit and a later one, and a scenario whose holdout file is not in the base commit. */
function fixture(): Fx {
  const dir = tmp('fx');
  const source = join(dir, 'source');
  mkdirSync(join(source, 'tests'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', source);
  writeFileSync(join(source, 'a.txt'), 'a\n');
  writeFileSync(join(source, 'docs.md'), '# spec\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'base');
  const baseSha = git(source, 'rev-parse', 'HEAD');
  git(source, 'tag', 'late-tag');
  writeFileSync(join(source, 'b.txt'), 'later\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'later commit');
  const laterSha = git(source, 'rev-parse', 'HEAD');
  const scenarios = join(dir, 'scenarios');
  mkdirSync(join(scenarios, 'fx.holdout', 'tests'), { recursive: true });
  writeFileSync(join(scenarios, 'fx.holdout', 'tests', 'hold.test.js'), "import { test } from 'node:test';\ntest('x', () => {});\n");
  const scenarioFile = join(scenarios, 'fx.json');
  writeFileSync(
    scenarioFile,
    JSON.stringify({
      name: 'fx', source: 'loop', baseSha, spec: 'docs.md', wave: '1', holdout: ['tests/hold.test.js'], holdoutTotal: 1,
      holdoutCommand: 'node --test --test-reporter=tap tests/hold.test.js',
      project: { mainCi: 'check', maxBuilders: 2, maxChains: 3, syncPolicy: 'conflict', install: 'true', check: 'true', models: { worker: { model: 'sonnet', effort: 'high' }, critic: { model: 'fable', effort: 'high' } } },
    }),
  );
  return { dir, source, baseSha, laterSha, scenarios, scenarioFile };
}

function cli(args: string[], env: NodeJS.ProcessEnv = cleanEnv()) {
  const r = spawnSync('node', [BENCH, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const lastJson = (s: string) => JSON.parse(s.trim().split('\n').pop() as string);

describe('the real scenarios', () => {
  const names = ['v24-wave-1', 'synthetic-6'];
  for (const name of names) {
    it(`${name}: a full baseSha, a spec, a project and holdout copies that exist`, () => {
      const sc = JSON.parse(readFileSync(join(SCENARIOS, `${name}.json`), 'utf8'));
      expect(sc.name).toBe(name);
      expect(sc.baseSha).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof sc.spec).toBe('string');
      expect(sc.wave).toBeTruthy();
      expect(sc.holdout.length).toBeGreaterThan(0);
      expect(sc.holdoutTotal).toBeGreaterThan(0);
      for (const k of ['mainCi', 'maxBuilders', 'maxChains', 'models', 'syncPolicy', 'install', 'check']) expect(sc.project, k).toHaveProperty(k);
      expect(sc.project.github).toBeUndefined();
      const holdoutDir = join(SCENARIOS, sc.holdoutDir ?? `${name}.holdout`);
      for (const p of sc.holdout) {
        expect(existsSync(join(holdoutDir, p)), p).toBe(true);
        const cases = readFileSync(join(holdoutDir, p), 'utf8').match(/^\s*(it|test)\(/gm) ?? [];
        expect(cases.length, `${p} case count`).toBe(sc.holdoutTotal);
      }
    });
  }

  it('v24-wave-1 starts from the commit wave 1 started from and keeps its tail test as the holdout', () => {
    const sc = JSON.parse(readFileSync(join(SCENARIOS, 'v24-wave-1.json'), 'utf8'));
    expect(sc.baseSha).toBe('844e886f5901023a6f458bfebac07527c7d6f4a6');
    expect(sc.holdout).toEqual(['tests/v24-wave1.test.ts']);
    expect(sc.wave).toBe('1');
  });

  it('synthetic-6: the seed repo builds to the recorded baseSha, and its spec passes spec-lint with six tasks and two chains', () => {
    const sc = JSON.parse(readFileSync(join(SCENARIOS, 'synthetic-6.json'), 'utf8'));
    const built = tmp('seed');
    const sha = buildSeedRepo(join(SCENARIOS, 'synthetic-6', 'seed'), join(built, 'seed'));
    expect(sha).toBe(sc.baseSha);
    const spec = join(SCENARIOS, 'synthetic-6', 'seed', sc.spec);
    let out = '';
    const code = specLint(['node', 'spec-lint', spec], { out: (s: string) => (out += s), err: (s: string) => (out += s) });
    expect(code, out).toBe(0);
    expect(out).toContain('6 tasks');
    const text = readFileSync(spec, 'utf8');
    expect((text.match(/^- \*\*\d+\.\d+ /gm) ?? []).length).toBe(6);
    expect((text.match(/Depends on/g) ?? []).length).toBe(2);
    // the holdout is not in the seed repo the agents get
    expect(existsSync(join(SCENARIOS, 'synthetic-6', 'seed', sc.holdout[0]))).toBe(false);
  });
});

describe('config merge and key', () => {
  it('merges overrides field by field and keeps the base for fields it does not name', () => {
    const base = { maxBuilders: 2, models: { worker: { model: 'sonnet', effort: 'high' }, critic: { model: 'fable', effort: 'high' } }, check: 'npm run check' };
    const merged = mergeProject(base, { maxBuilders: 3, models: { worker: { effort: 'low' } } });
    expect(merged).toEqual({ maxBuilders: 3, models: { worker: { model: 'sonnet', effort: 'low' }, critic: { model: 'fable', effort: 'high' } }, check: 'npm run check' });
    expect(base.maxBuilders).toBe(2);
  });

  it('refuses overrides of repo, worktrees and github', () => {
    for (const k of ['repo', 'worktrees', 'github']) expect(() => mergeProject({}, { [k]: 'x' })).toThrow(k);
  });

  it('keys by the sha-256 of the canonical project without per-run paths, plus loop commit and version, scenario and jobs', () => {
    const input = { project: { b: 1, a: { d: 1, c: 2 }, repo: '/x', worktrees: '/y', github: 'bench.invalid/bench' }, loopCommit: 'abc', loopVersion: '2.4.0', scenario: 's', ciJobs: 2 };
    const k = configKey(input);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(configKey({ ...input, project: { a: { c: 2, d: 1 }, b: 1, repo: '/other', worktrees: '/o2', github: 'bench.invalid/bench' } })).toBe(k);
    expect(configKey({ ...input, loopCommit: 'abd' })).not.toBe(k);
    expect(configKey({ ...input, loopVersion: '2.5.0' })).not.toBe(k);
    expect(configKey({ ...input, scenario: 't' })).not.toBe(k);
    expect(configKey({ ...input, ciJobs: 3 })).not.toBe(k);
    expect(configKey({ ...input, project: { ...input.project, b: 2 } })).not.toBe(k);
  });
});

describe('prepare', () => {
  const fx = fixture();
  const out = join(tmp('out'), 'run');
  const overrides = join(fx.dir, 'overrides.json');
  writeFileSync(overrides, JSON.stringify({ maxBuilders: 3, models: { worker: { effort: 'low' } } }));
  let result: any;
  let run: { code: number | null; out: string; err: string };

  it('prints one JSON line with the allow rules and the environment, and exits 0', () => {
    run = cli(['prepare', fx.scenarioFile, '--loop', root, '--config', overrides, '--out', out, '--source', fx.source]);
    expect(run.code, run.err).toBe(0);
    result = lastJson(run.out);
    expect(result.out).toBe(out);
    expect(result.rules.length).toBeGreaterThanOrEqual(5);
    for (const r of result.rules) expect(r).toMatch(new RegExp(`^Bash\\(node ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/clone/\\.claude/scripts/[a-z-]+\\.js \\*\\)$`));
    for (const s of ['merge-pr.js', 'wait-ci.js', 'ci-only.js']) expect(result.rules.some((r: string) => r.includes(`/${s} `)), s).toBe(true);
    expect(result.env.PATH).toBe(`${out}/bin:$PATH`);
    expect(result.env.BENCH_STATE).toBe(`${out}/state`);
    expect(result.env.BENCH_CI_JOBS).toBe('2');
    expect(result.configKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('puts the clone at baseSha with origin set to the bare remote, never the source', () => {
    const clone = join(out, 'clone');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(fx.baseSha);
    expect(git(clone, 'remote', 'get-url', 'origin')).toBe(join(out, 'remote.git'));
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(git(join(out, 'remote.git'), 'rev-parse', 'refs/heads/main')).toBe(fx.baseSha);
  });

  it('keeps every later commit, tag and pull ref out of the bare remote', () => {
    const remote = join(out, 'remote.git');
    const probe = spawnSync('git', ['cat-file', '-e', fx.laterSha], { cwd: remote, env: cleanEnv() });
    expect(probe.status).not.toBe(0);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
  });

  it('moves the holdout out of the clone, to <out>/holdout', () => {
    expect(existsSync(join(out, 'clone', 'tests', 'hold.test.js'))).toBe(false);
    expect(git(join(out, 'clone'), 'ls-files', 'tests')).toBe('');
    expect(existsSync(join(out, 'holdout', 'tests', 'hold.test.js'))).toBe(true);
  });

  it('writes loop.local.json with the overrides merged and a github name that is never a real repository', () => {
    const cfg = JSON.parse(readFileSync(join(out, 'clone', '.claude', 'loop.local.json'), 'utf8'));
    expect(cfg.github).toBe('bench.invalid/bench');
    expect(cfg.repo).toBe(join(out, 'clone'));
    expect(cfg.worktrees).toBe(join(out, 'worktrees'));
    expect(cfg.maxBuilders).toBe(3);
    expect(cfg.maxChains).toBe(3);
    expect(cfg.models.worker).toEqual({ model: 'sonnet', effort: 'low' });
    expect(cfg.models.critic).toEqual({ model: 'fable', effort: 'high' });
    expect(cfg.spec).toBe('docs.md');
    expect(cfg.mainCi).toBe('check');
  });

  it('links the loop into .claude with install.sh and writes no settings file', () => {
    const claude = join(out, 'clone', '.claude');
    expect(lstatSync(join(claude, 'workflows')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(claude, 'scripts')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(claude, 'hookify.gh-this-repo.local.md'), 'utf8')).toContain('bench.invalid/bench');
    const everything = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '.git' || e.isSymbolicLink() ? [] : e.isDirectory() ? everything(join(d, e.name)).map((x) => `${e.name}/${x}`) : [e.name]));
    expect(everything(out).filter((n) => /(^|\/)settings(\.local)?\.json$/.test(n))).toEqual([]);
    expect(git(join(out, 'clone'), 'status', '--porcelain')).toBe('');
  });

  it('writes the CI config and installs the hook in the remote', () => {
    const ci = JSON.parse(readFileSync(join(out, 'state', 'ci.json'), 'utf8'));
    expect(ci).toMatchObject({ install: 'true', check: 'true', mainCi: 'check', remote: join(out, 'remote.git') });
    expect(existsSync(join(out, 'remote.git', 'hooks', 'post-receive'))).toBe(true);
    expect(existsSync(join(out, 'state', 'runs')) ? readdirSync(join(out, 'state', 'runs')) : []).toEqual([]);
  });

  it('answers gh pr list from BENCH_STATE through <out>/bin/gh', () => {
    const r = spawnSync(join(out, 'bin', 'gh'), ['pr', 'list', '--json', 'number'], { cwd: join(out, 'clone'), encoding: 'utf8', env: cleanEnv({ BENCH_STATE: join(out, 'state') }) });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
    const unset = spawnSync(join(out, 'bin', 'gh'), ['pr', 'list'], { cwd: join(out, 'clone'), encoding: 'utf8', env: cleanEnv() });
    expect(unset.status).toBe(1);
  });

  it('doctor exits 1 until PATH, BENCH_STATE and BENCH_CI_JOBS are the printed ones, then 0', () => {
    const bad = cli(['doctor', out]);
    expect(bad.code).toBe(1);
    expect(lastJson(bad.out).ok).toBe(false);
    const half = cli(['doctor', out], cleanEnv({ PATH: `${out}/bin:${process.env.PATH}`, BENCH_STATE: join(out, 'state') }));
    expect(half.code).toBe(1);
    const good = cli(['doctor', out], cleanEnv({ PATH: `${out}/bin:${process.env.PATH}`, BENCH_STATE: join(out, 'state'), BENCH_CI_JOBS: '2' }));
    expect(good.code, good.out + good.err).toBe(0);
    expect(lastJson(good.out).ok).toBe(true);
    const wrongPath = cli(['doctor', out], cleanEnv({ BENCH_STATE: join(out, 'state'), BENCH_CI_JOBS: '2' }));
    expect(wrongPath.code).toBe(1);
  });

  it('refuses a directory that is not the --out the rules name, and an --out that is not empty', () => {
    const moved = join(tmp('moved'), 'copy');
    cpSync(out, moved, { recursive: true, verbatimSymlinks: true });
    const env = cleanEnv({ PATH: `${moved}/bin:${process.env.PATH}`, BENCH_STATE: join(moved, 'state'), BENCH_CI_JOBS: '2' });
    const r = cli(['doctor', moved], env);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain(out);
    const again = cli(['prepare', fx.scenarioFile, '--loop', root, '--out', out, '--source', fx.source]);
    expect(again.code).toBe(1);
  });

  it('refuses an override of github', () => {
    const bad = join(fx.dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ github: 'EdanBarrios/agent-loop' }));
    const r = cli(['prepare', fx.scenarioFile, '--loop', root, '--config', bad, '--out', join(tmp('o2'), 'run'), '--source', fx.source]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('github');
  });
});

describe('prepare on the synthetic scenario', () => {
  it('builds the seed repo, and the spec in the clone yields six tasks through wave-args', () => {
    const out = join(tmp('syn'), 'run');
    const r = prepare('synthetic-6', { loop: root, out, ciJobs: 1 });
    expect(r.baseSha).toBe(JSON.parse(readFileSync(join(SCENARIOS, 'synthetic-6.json'), 'utf8')).baseSha);
    expect(git(join(out, 'clone'), 'rev-parse', 'HEAD')).toBe(r.baseSha);
    expect(readdirSync(join(out, 'holdout', 'tests')).length).toBeGreaterThan(0);
    expect(existsSync(join(out, 'clone', 'tests', 'holdout.test.js'))).toBe(false);
    const w = spawnSync('node', [join(root, 'scripts', 'wave-args.js'), '--repo', join(out, 'clone'), '--wave', '1'], { encoding: 'utf8', env: cleanEnv() });
    expect(w.status, w.stderr).toBe(0);
    const args = JSON.parse(w.stdout);
    expect(args.tasks.length).toBe(6);
    expect(args.project.github).toBe('bench.invalid/bench');
    expect(realpathSync(args.project.repo)).toBe(realpathSync(join(out, 'clone')));
    expect(r.env.BENCH_CI_JOBS).toBe('1');
  });
});
