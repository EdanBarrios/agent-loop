import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { enqueueRun, installHook, listRuns, runRun } from '../bench/ci.js';
// @ts-expect-error plain JavaScript module with JSDoc
import { runGh } from '../bench/fake-gh.js';

// Fake GitHub for the benchmark: bench/bin/gh answers the subcommands the loop uses from a bare remote and a state
// directory ($BENCH_STATE), and the runs come from the local CI of bench/ci.js. Real git, no network, no agent.
const root = join(import.meta.dirname, '..');
const SHIM = join(root, 'bench', 'bin', 'gh');
const roots: string[] = [];
vi.setConfig({ testTimeout: 60000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fixture = (name: string) => JSON.parse(readFileSync(join(root, 'tests', 'fixtures', name), 'utf8'));

function cleanEnv(extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') || k.startsWith('BENCH_')) delete env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'Bench';
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'bench@example.invalid';
  return env as NodeJS.ProcessEnv;
}
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function waitFor<T>(fn: () => T | undefined | false, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(40);
  }
}

type Fx = { dir: string; remote: string; work: string; state: string; gate: string };
/** A bare remote with main (ok.txt, c.txt), a working clone on main, and local CI that waits for the gate file. */
function setup(opts: { open?: boolean; ci?: boolean; hook?: boolean } = {}): Fx {
  const dir = mkdtempSync(join(tmpdir(), 'bench-gh-'));
  roots.push(dir);
  const f: Fx = { dir, remote: join(dir, 'remote.git'), work: join(dir, 'work'), state: join(dir, 'state'), gate: join(dir, 'gate') };
  git(dir, 'init', '--bare', '-b', 'main', f.remote);
  git(dir, 'init', '-b', 'main', f.work);
  git(f.work, 'remote', 'add', 'origin', f.remote);
  writeFileSync(join(f.work, 'ok.txt'), 'ok\n');
  writeFileSync(join(f.work, 'c.txt'), 'base\n');
  git(f.work, 'add', '.');
  git(f.work, 'commit', '-m', 'base');
  git(f.work, 'push', '-q', 'origin', 'main');
  execFileSync('mkdir', ['-p', f.state]);
  if (opts.ci !== false) {
    writeFileSync(
      join(f.state, 'ci.json'),
      JSON.stringify({ install: 'true', check: `while [ ! -f ${f.gate} ]; do sleep 0.05; done; test -f ok.txt && echo check-ok || { echo "check failed: ok.txt is missing"; exit 1; }`, mainCi: 'ci' }),
    );
    // the post-receive hook starts node on every push, which is slow: only the tests about runs and checks install it
    if (opts.hook ?? opts.open === false) installHook(f.remote, f.state);
  }
  if (opts.open !== false) writeFileSync(f.gate, 'go');
  return f;
}
/** Makes a branch off main with the files (null removes one), pushes it, and returns its tip. */
function branch(f: Fx, name: string, files: Record<string, string | null>, message = `work on ${name}`) {
  git(f.work, 'checkout', '-q', '-B', name, 'main');
  for (const [p, c] of Object.entries(files)) {
    if (c === null) git(f.work, 'rm', '-q', p);
    else writeFileSync(join(f.work, p), c);
  }
  git(f.work, 'add', '-A');
  git(f.work, 'commit', '-q', '-m', message);
  git(f.work, 'push', '-q', 'origin', name);
  const tip = git(f.work, 'rev-parse', 'HEAD');
  git(f.work, 'checkout', '-q', 'main');
  return tip;
}
const mainTip = (f: Fx) => git(f.remote, 'rev-parse', 'refs/heads/main');

type R = { code: number | null; out: string; err: string };
/**
 * Runs the fake gh in process (starting node costs seconds on a loaded machine, and the runner a merge starts is another
 * node, so a merge only records its push run); the shim and the real runner are tested apart.
 */
function gh(f: Fx, args: string[], o: { cwd?: string; input?: string; env?: Record<string, string | undefined>; sleep?: (ms: number) => void } = {}): R {
  const r = runGh(args, { cwd: o.cwd ?? f.work, stdin: () => o.input ?? '', env: { BENCH_STATE: f.state, ...(o.env ?? {}) }, sleep: o.sleep, startRuns: false });
  return { code: r.code, out: r.stdout, err: r.stderr };
}
const json = (r: R) => {
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  return JSON.parse(r.out);
};
function create(f: Fx, head: string, title = `title of ${head}`, extra: string[] = []) {
  return gh(f, ['pr', 'create', '--base', 'main', '--head', head, '--title', title, '--body', `body of ${head}`, ...extra]);
}

afterAll(async () => {
  await sleep(300);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('refusals', () => {
  it('refuses to run when BENCH_STATE is unset, or names a directory that is not there', () => {
    const f = setup();
    const unset = spawnSync(SHIM, ['pr', 'list'], { cwd: f.work, encoding: 'utf8', env: cleanEnv() });
    expect(unset.status).toBe(1);
    expect(unset.stderr).toContain('BENCH_STATE');
    const shim = spawnSync(SHIM, ['pr', 'list', '--json', 'number'], { cwd: f.work, encoding: 'utf8', env: cleanEnv({ BENCH_STATE: f.state }) });
    expect(shim.status).toBe(0);
    expect(shim.stdout).toBe('[]\n');
    const gone = gh(f, ['pr', 'list'], { env: { BENCH_STATE: join(f.dir, 'nowhere') } });
    expect(gone.code).toBe(1);
    expect(gone.err).toContain('BENCH_STATE');
  });

  it('exits 1 naming an unknown subcommand, an unsupported flag and an unsupported --json field', () => {
    const f = setup();
    const sub = gh(f, ['pr', 'close', '1']);
    expect(sub.code).toBe(1);
    expect(sub.err).toContain('pr close');
    expect(sub.out).toBe('');
    const top = gh(f, ['issue', 'list']);
    expect(top.code).toBe(1);
    expect(top.err).toContain('issue');
    const flag = gh(f, ['pr', 'list', '--author', 'someone']);
    expect(flag.code).toBe(1);
    expect(flag.err).toContain('--author');
    expect(flag.err).toContain('pr list');
    const field = gh(f, ['pr', 'view', '1', '--json', 'number,labels']);
    expect(field.code).toBe(1);
    expect(field.err).toContain('labels');
    const runField = gh(f, ['run', 'list', '--json', 'databaseId,jobs']);
    expect(runField.code).toBe(1);
    expect(runField.err).toContain('jobs');
  });

  it('exits 1 naming a -q expression it cannot evaluate, and -q without --json', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    const bad = gh(f, ['pr', 'view', '1', '--json', 'files', '-q', '.files | map(.path)']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('.files | map(.path)');
    const noJson = gh(f, ['pr', 'view', '1', '-q', '.body']);
    expect(noJson.code).toBe(1);
    expect(noJson.err).toContain('--json');
  });
});

describe('pr create and pr view', () => {
  it('creates a PR, prints its URL, and creates refs/pull/<n>/head in the bare remote', () => {
    const f = setup();
    const tip = branch(f, 'task/1.1-a', { 'a.txt': 'a\n' });
    const r = create(f, 'task/1.1-a', '1.1: A');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^https:\/\/\S+\/pull\/1$/);
    expect(git(f.remote, 'rev-parse', 'refs/pull/1/head')).toBe(tip);
    const second = branch(f, 'task/1.2-b', { 'b.txt': 'b\n' });
    expect(create(f, 'task/1.2-b').out.trim()).toMatch(/\/pull\/2$/);
    expect(git(f.remote, 'rev-parse', 'refs/pull/2/head')).toBe(second);
    // test-edits.js fetches the PR head by this name
    const clone = join(f.dir, 'clone');
    git(f.dir, 'clone', '-q', f.remote, clone);
    git(clone, 'fetch', '-q', 'origin', 'pull/1/head');
    expect(git(clone, 'rev-parse', 'FETCH_HEAD')).toBe(tip);
  });

  it('follows the branch: refs/pull/<n>/head and headRefOid move when the branch is pushed again', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    git(f.work, 'checkout', '-q', 'task/a');
    writeFileSync(join(f.work, 'more.txt'), 'more\n');
    git(f.work, 'add', '.');
    git(f.work, 'commit', '-q', '-m', 'more');
    git(f.work, 'push', '-q', 'origin', 'task/a');
    const tip = git(f.work, 'rev-parse', 'HEAD');
    git(f.work, 'checkout', '-q', 'main');
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'headRefOid'])).headRefOid).toBe(tip);
    expect(git(f.remote, 'rev-parse', 'refs/pull/1/head')).toBe(tip);
  });

  it('matches the shape of the gh fixtures for --json (clean, conflicting)', () => {
    const f = setup();
    const tip = branch(f, 'feat/1.3-lane-check', { 'a.txt': 'a\n' });
    create(f, 'feat/1.3-lane-check', '1.3: Lane check');
    const fields = 'baseRefName,headRefName,headRefOid,mergeStateStatus,mergeable,state,title';
    const r = gh(f, ['pr', 'view', '1', '--json', fields]);
    const clean = fixture('gh-pr-view-clean.json');
    expect(Object.keys(JSON.parse(r.out))).toEqual(Object.keys(clean));
    expect(r.out).toBe(JSON.stringify({ ...clean, headRefOid: tip }) + '\n');

    // a second PR that touches the same line of c.txt as a merged one conflicts
    branch(f, 'task/x', { 'c.txt': 'x\n' });
    branch(f, 'task/y', { 'c.txt': 'y\n' });
    create(f, 'task/x');
    create(f, 'task/y');
    expect(gh(f, ['pr', 'merge', '2', '--merge']).code).toBe(0);
    const conflicting = json(gh(f, ['pr', 'view', '3', '--json', fields]));
    const expected = fixture('gh-pr-view-conflicting.json');
    expect(conflicting.mergeable).toBe(expected.mergeable);
    expect(conflicting.mergeStateStatus).toBe(expected.mergeStateStatus);
    expect(conflicting.state).toBe('OPEN');
  });

  it('prints the merged shape of the fixtures after a merge, with sorted keys and compact JSON', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    expect(gh(f, ['pr', 'merge', '1', '--merge', '--delete-branch']).code).toBe(0);
    const r = gh(f, ['pr', 'view', '1', '--json', 'state,mergeCommit']);
    const merged = fixture('gh-pr-view-merged.json');
    expect(Object.keys(JSON.parse(r.out))).toEqual(Object.keys(merged));
    expect(JSON.parse(r.out)).toEqual({ state: 'MERGED', mergeCommit: { oid: mainTip(f) } });
    expect(r.out.trim().split('\n')).toHaveLength(1);
    // keys come out sorted whatever the order asked for
    const sorted = gh(f, ['pr', 'view', '1', '--json', 'title,number,state']).out;
    expect(Object.keys(JSON.parse(sorted))).toEqual(['number', 'state', 'title']);
  });

  it('reads the body from a file or from stdin, takes --draft, and finds the PR by branch or from the current branch', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    branch(f, 'task/b', { 'b.txt': 'b\n' });
    writeFileSync(join(f.dir, 'body.md'), 'from a file\nsecond line\n');
    const a = gh(f, ['pr', 'create', '--base', 'main', '--head', 'task/a', '--title', 'A', '--body-file', join(f.dir, 'body.md'), '--draft']);
    expect(a.code).toBe(0);
    const b = gh(f, ['pr', 'create', '--base', 'main', '--head', 'task/b', '--title', 'B', '--body-file', '-'], { input: 'from stdin\n' });
    expect(b.code).toBe(0);
    expect(gh(f, ['pr', 'view', '1', '--json', 'body', '-q', '.body']).out).toBe('from a file\nsecond line\n\n');
    expect(gh(f, ['pr', 'view', '2', '--json', 'body', '-q', '.body']).out).toBe('from stdin\n\n');
    expect(gh(f, ['pr', 'view', 'task/b', '--json', 'number', '-q', '.number']).out).toBe('2\n');
    git(f.work, 'checkout', '-q', 'task/a');
    expect(gh(f, ['pr', 'view', '--json', 'number', '-q', '.number']).out).toBe('1\n');
    const none = gh(f, ['pr', 'view', '--json', 'number'], { cwd: f.dir });
    expect(none.code).toBe(1);
  });

  it('defaults --head to the current branch and --base to the default branch', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    git(f.work, 'checkout', '-q', 'task/a');
    const r = gh(f, ['pr', 'create', '--title', 'A', '--body', 'b']);
    expect(r.code).toBe(0);
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'headRefName,baseRefName']))).toEqual({ baseRefName: 'main', headRefName: 'task/a' });
  });

  it('finds the bare remote from BENCH_REMOTE when the directory is not a clone', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    const lost = gh(f, ['pr', 'create', '--head', 'task/a', '--title', 'A', '--body', 'b'], { cwd: f.dir });
    expect(lost.code).toBe(1);
    expect(lost.err).toContain('BENCH_REMOTE');
    const found = gh(f, ['pr', 'create', '--head', 'task/a', '--title', 'A', '--body', 'b'], { cwd: f.dir, env: { BENCH_REMOTE: f.remote } });
    expect(found.code).toBe(0);
  });

  it('refuses what GitHub refuses: no title or body, a head that is not pushed, no commits, a second PR for the branch', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    const noTitle = gh(f, ['pr', 'create', '--head', 'task/a', '--body', 'b']);
    expect(noTitle.code).toBe(1);
    expect(noTitle.err).toContain('--title');
    const noBody = gh(f, ['pr', 'create', '--head', 'task/a', '--title', 't']);
    expect(noBody.code).toBe(1);
    expect(noBody.err).toContain('--body');
    const unpushed = create(f, 'task/never-pushed');
    expect(unpushed.code).toBe(1);
    expect(unpushed.err).toContain('task/never-pushed');
    const same = create(f, 'main');
    expect(same.code).toBe(1);
    git(f.work, 'branch', 'task/empty', 'main');
    git(f.work, 'push', '-q', 'origin', 'task/empty');
    const empty = create(f, 'task/empty');
    expect(empty.code).toBe(1);
    expect(empty.err).toContain('No commits between main and task/empty');
    expect(create(f, 'task/a').code).toBe(0);
    const dup = create(f, 'task/a');
    expect(dup.code).toBe(1);
    expect(dup.err).toMatch(/already exists/);
    expect(json(gh(f, ['pr', 'list', '--json', 'number']))).toEqual([{ number: 1 }]);
  });

  it('prints pr view as gh prints it off a terminal, and the comments through --comments and the comments field', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a', '1.1: A');
    const plain = gh(f, ['pr', 'view', '1']);
    expect(plain.code).toBe(0);
    const [head, ...bodyParts] = plain.out.split('\n--\n');
    expect(head).toContain('title:\t1.1: A');
    expect(head).toContain('state:\tOPEN');
    expect(head).toContain('number:\t1');
    expect(head).toMatch(/url:\thttps:\/\/\S+\/pull\/1/);
    expect(bodyParts.join('\n--\n')).toBe('body of task/a\n');

    expect(gh(f, ['pr', 'view', '1', '--comments']).out).toBe('');
    const c1 = gh(f, ['pr', 'comment', '1', '--body', 'first comment']);
    expect(c1.code).toBe(0);
    expect(c1.out.trim()).toMatch(/\/pull\/1#issuecomment-\d+$/);
    writeFileSync(join(f.dir, 'c.md'), 'second\ncomment\n');
    expect(gh(f, ['pr', 'comment', '1', '--body-file', join(f.dir, 'c.md')]).code).toBe(0);
    const shown = gh(f, ['pr', 'view', '1', '--comments']).out;
    expect(shown).toContain('first comment');
    expect(shown).toContain('second\ncomment');
    expect(shown.indexOf('first comment')).toBeLessThan(shown.indexOf('second\ncomment'));
    expect(shown).not.toContain('title:');
    const field = json(gh(f, ['pr', 'view', '1', '--json', 'comments'])).comments;
    expect(field.map((c: { body: string }) => c.body)).toEqual(['first comment', 'second\ncomment\n']);
    expect(typeof field[0].createdAt).toBe('string');
    expect(typeof field[0].author.login).toBe('string');
    expect(gh(f, ['pr', 'comment', '1']).code).toBe(1);
    expect(gh(f, ['pr', 'comment', '99', '--body', 'x']).code).toBe(1);
  });

  it('says so when there is no such PR', () => {
    const f = setup();
    const r = gh(f, ['pr', 'view', '42', '--json', 'number']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('42');
    expect(r.out).toBe('');
  });
});

describe('pr list, pr edit, pr ready', () => {
  it('lists newest first with --state, --limit, --head and --base, and selects --json fields', () => {
    const f = setup();
    for (const n of ['a', 'b', 'c']) branch(f, `task/${n}`, { [`${n}.txt`]: `${n}\n` });
    for (const n of ['a', 'b', 'c']) create(f, `task/${n}`, `PR ${n}`);
    expect(gh(f, ['pr', 'merge', '2', '--merge', '--delete-branch']).code).toBe(0);
    expect(json(gh(f, ['pr', 'list', '--json', 'number,title,state'])).map((p: { number: number }) => p.number)).toEqual([3, 1]);
    expect(json(gh(f, ['pr', 'list', '--state', 'all', '--json', 'number,state']))).toEqual([
      { number: 3, state: 'OPEN' }, { number: 2, state: 'MERGED' }, { number: 1, state: 'OPEN' },
    ]);
    expect(json(gh(f, ['pr', 'list', '--state', 'closed', '--json', 'number']))).toEqual([]);
    expect(gh(f, ['pr', 'list', '--state', 'closed']).err).toMatch(/no closed pull requests/i);
    expect(json(gh(f, ['pr', 'list', '--state', 'all', '--limit', '2', '--json', 'number'])).map((p: { number: number }) => p.number)).toEqual([3, 2]);
    expect(json(gh(f, ['pr', 'list', '--head', 'task/a', '--json', 'number']))).toEqual([{ number: 1 }]);
    expect(json(gh(f, ['pr', 'list', '--base', 'nope', '--json', 'number']))).toEqual([]);
    expect(gh(f, ['pr', 'list', '--state', 'bogus']).code).toBe(1);
  });

  it('lists merged PRs in the shape the loop reads (number, headRefName, mergeCommit, mergedAt)', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    expect(gh(f, ['pr', 'merge', '1', '--merge', '--delete-branch']).code).toBe(0);
    const rows = json(gh(f, ['pr', 'list', '--state', 'merged', '--limit', '1000', '--json', 'number,headRefName,mergeCommit']));
    expect(rows).toEqual([{ headRefName: 'task/a', mergeCommit: { oid: mainTip(f) }, number: 1 }]);
    const at = json(gh(f, ['pr', 'list', '--state', 'merged', '--json', 'number,headRefName,mergedAt']))[0].mergedAt;
    expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'mergedAt'])).mergedAt).toBe(at);
    expect(json(gh(f, ['pr', 'list', '--state', 'open', '--json', 'number']))).toEqual([]);
    expect(json(gh(f, ['pr', 'list', '--json', 'number'])).length).toBe(0);
  });

  it('prints pr list as gh prints it off a terminal: number, title, branch, state', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a', '1.1: A', ['--draft']);
    const cols = gh(f, ['pr', 'list']).out.trim().split('\t');
    expect(cols.slice(0, 4)).toEqual(['1', '1.1: A', 'task/a', 'DRAFT']);
  });

  it('edits title, body (also from a file) and base, and prints the URL', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    const t = gh(f, ['pr', 'edit', '1', '--title', 'new title']);
    expect(t.code).toBe(0);
    expect(t.out.trim()).toMatch(/\/pull\/1$/);
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'title'])).title).toBe('new title');
    writeFileSync(join(f.dir, 'b.md'), 'Decisions:\nD1 | x | y | yes\n');
    gh(f, ['pr', 'edit', '1', '--body-file', join(f.dir, 'b.md')]);
    expect(gh(f, ['pr', 'view', '1', '--json', 'body', '-q', '.body']).out).toBe('Decisions:\nD1 | x | y | yes\n\n');
    gh(f, ['pr', 'edit', '1', '--body', 'inline']);
    expect(gh(f, ['pr', 'view', '1', '--json', 'body', '-q', '.body']).out).toBe('inline\n');
    git(f.work, 'branch', 'release', 'main');
    git(f.work, 'push', '-q', 'origin', 'release');
    expect(gh(f, ['pr', 'edit', '1', '--base', 'release']).code).toBe(0);
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'baseRefName'])).baseRefName).toBe('release');
    expect(gh(f, ['pr', 'edit', '1', '--base', 'missing']).code).toBe(1);
    expect(gh(f, ['pr', 'edit', '1', '--add-label', 'x']).err).toContain('--add-label');
    expect(gh(f, ['pr', 'edit', '9', '--title', 'x']).code).toBe(1);
  });

  it('marks a draft ready for review, and says so when it already is', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a', 'A', ['--draft']);
    expect(gh(f, ['pr', 'view', '1']).out).toContain('state:\tDRAFT');
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'mergeStateStatus'])).mergeStateStatus).toBe('DRAFT');
    const r = gh(f, ['pr', 'ready', '1']);
    expect(r.code).toBe(0);
    expect(gh(f, ['pr', 'view', '1']).out).toContain('state:\tOPEN');
    const again = gh(f, ['pr', 'ready', '1']);
    expect(again.code).toBe(0);
    expect(again.err).toMatch(/already/);
    expect(gh(f, ['pr', 'ready', '7']).code).toBe(1);
  });
});

describe('pr diff, files and commits', () => {
  it('prints the diff against the base, lists files for -q, and lists commits oldest first', () => {
    const f = setup();
    git(f.work, 'checkout', '-q', '-b', 'task/a');
    writeFileSync(join(f.work, 'a.txt'), 'hello\n');
    git(f.work, 'add', '.');
    git(f.work, 'commit', '-q', '-m', 'first commit');
    const first = git(f.work, 'rev-parse', 'HEAD');
    writeFileSync(join(f.work, 'c.txt'), 'changed\n');
    git(f.work, 'add', '.');
    git(f.work, 'commit', '-q', '-m', 'second commit', '-m', 'with a body');
    const second = git(f.work, 'rev-parse', 'HEAD');
    git(f.work, 'push', '-q', 'origin', 'task/a');
    git(f.work, 'checkout', '-q', 'main');
    // main moves on after the branch was cut: the diff and the file list are the branch's own
    branch(f, 'other', { 'other.txt': 'o\n' });
    git(f.work, 'merge', '-q', '--ff-only', 'other');
    git(f.work, 'push', '-q', 'origin', 'main');
    create(f, 'task/a');

    const diff = gh(f, ['pr', 'diff', '1']);
    expect(diff.code).toBe(0);
    expect(diff.out).toContain('diff --git a/a.txt b/a.txt');
    expect(diff.out).toContain('+hello');
    expect(diff.out).toContain('-base');
    expect(diff.out).toContain('+changed');
    expect(diff.out).not.toContain('other.txt');
    expect(diff.out).not.toContain('\u001b[');

    expect(gh(f, ['pr', 'view', '1', '--json', 'files', '-q', '.files[].path']).out).toBe('a.txt\nc.txt\n');
    const files = json(gh(f, ['pr', 'view', '1', '--json', 'files'])).files;
    expect(files.map((x: { path: string }) => x.path)).toEqual(['a.txt', 'c.txt']);
    expect(files[0]).toMatchObject({ path: 'a.txt', additions: 1, deletions: 0 });

    const commits = json(gh(f, ['pr', 'view', '1', '--json', 'commits'])).commits;
    expect(commits.map((c: { oid: string }) => c.oid)).toEqual([first, second]);
    expect(commits[1]).toMatchObject({ messageHeadline: 'second commit', messageBody: 'with a body' });
    expect(gh(f, ['pr', 'diff', '1', '--name-only']).code).toBe(1);
  });

  it('keeps the diff, files and commits of a merged PR after the branch is deleted', () => {
    const f = setup();
    const tip = branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    expect(gh(f, ['pr', 'merge', '1', '--merge', '--delete-branch']).code).toBe(0);
    expect(gh(f, ['pr', 'diff', '1']).out).toContain('+a');
    expect(gh(f, ['pr', 'view', '1', '--json', 'files', '-q', '.files[].path']).out).toBe('a.txt\n');
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'commits'])).commits.map((c: { oid: string }) => c.oid)).toEqual([tip]);
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'headRefOid'])).headRefOid).toBe(tip);
  });
});

describe('pr merge', () => {
  it('merges with a real merge commit, deletes the branch, and records a push run for the new default-branch sha', async () => {
    const f = setup();
    const tip = branch(f, 'task/a', { 'a.txt': 'a\n' }, 'add a');
    const before = mainTip(f);
    create(f, 'task/a', '1.1: A');
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'mergeable'])).mergeable).toBe('MERGEABLE');
    expect(gh(f, ['pr', 'view', '1', '--json', 'mergeable', '-q', '.mergeable']).out).toBe('MERGEABLE\n');
    const runsBefore = listRuns(f.state).length;

    const m = gh(f, ['pr', 'merge', '1', '--merge', '--delete-branch', '--match-head-commit', tip]);
    expect(m.code).toBe(0);
    const merged = mainTip(f);
    expect(merged).not.toBe(before);
    expect(git(f.remote, 'rev-list', '--parents', '-n', '1', merged).split(' ').slice(1)).toEqual([before, tip]);
    expect(git(f.remote, 'log', '-1', '--format=%s', merged)).toBe('Merge pull request #1 from bench/task/a');
    expect(git(f.remote, 'log', '-1', '--format=%b', merged)).toBe('1.1: A');
    expect(git(f.remote, 'show', `${merged}:a.txt`)).toBe('a');
    expect(existsSync(join(f.remote, 'refs', 'heads', 'task', 'a'))).toBe(false);
    expect(git(f.remote, 'for-each-ref', 'refs/heads/task/a')).toBe('');
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'state,mergeCommit']))).toEqual({ mergeCommit: { oid: merged }, state: 'MERGED' });

    // a ref moved inside the bare remote runs no post-receive hook: the merge records the push run itself
    const runs = listRuns(f.state);
    expect(runs.length).toBe(runsBefore + 1);
    expect(runs[0]).toMatchObject({ sha: merged, event: 'push', branch: 'main', workflow: 'ci' });
    const list = json(gh(f, ['run', 'list', '--branch', 'main', '--workflow', 'ci', '--commit', merged, '--json', 'databaseId,status,conclusion']));
    expect(list).toHaveLength(1);
    expect(list[0].databaseId).toBe(runs[0].id);
    expect(list[0]).toMatchObject({ status: 'queued', conclusion: '' });
    // the record is runnable: bench/ci.js clones the bare remote at the merge sha and runs the check there
    await runRun(f.state, runs[0].id, { remote: f.remote });
    expect(json(gh(f, ['run', 'list', '--branch', 'main', '--workflow', 'ci', '--commit', merged, '--json', 'databaseId,status,conclusion']))[0]).toMatchObject({ status: 'completed', conclusion: 'success' });
  });

  it('refuses a second merge of the same PR', async () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    expect(gh(f, ['pr', 'merge', '1', '--merge']).code).toBe(0);
    const tip = mainTip(f);
    const again = gh(f, ['pr', 'merge', '1', '--merge']);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already merged/);
    expect(mainTip(f)).toBe(tip);
  });

  it('refuses with GitHub\'s message when the branch conflicts, and changes nothing', async () => {
    const f = setup();
    branch(f, 'task/x', { 'c.txt': 'x\n' });
    branch(f, 'task/y', { 'c.txt': 'y\n' });
    create(f, 'task/x');
    create(f, 'task/y');
    expect(gh(f, ['pr', 'merge', '1', '--merge', '--delete-branch']).code).toBe(0);
    const tip = mainTip(f);
    const runs = listRuns(f.state).length;
    const r = gh(f, ['pr', 'merge', '2', '--merge', '--delete-branch']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not mergeable: the merge commit cannot be cleanly created');
    expect(mainTip(f)).toBe(tip);
    expect(listRuns(f.state).length).toBe(runs);
    expect(git(f.remote, 'for-each-ref', 'refs/heads/task/y')).not.toBe('');
    expect(json(gh(f, ['pr', 'view', '2', '--json', 'state'])).state).toBe('OPEN');
    expect(json(gh(f, ['pr', 'view', '2', '--json', 'mergeable,mergeStateStatus']))).toEqual({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' });
  });

  it('refuses a stale --match-head-commit, a draft, a missing strategy and ci.json missing, and changes nothing', async () => {
    const f = setup();
    const tip = branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    const before = mainTip(f);
    const stale = gh(f, ['pr', 'merge', '1', '--merge', '--match-head-commit', 'a'.repeat(40)]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain('Head branch was modified');
    const bare = gh(f, ['pr', 'merge', '1']);
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('--merge');
    expect(gh(f, ['pr', 'merge', '1', '--merge', '--squash']).code).toBe(1);
    branch(f, 'task/d', { 'd.txt': 'd\n' });
    create(f, 'task/d', 'D', ['--draft']);
    const draft = gh(f, ['pr', 'merge', '2', '--merge']);
    expect(draft.code).toBe(1);
    expect(draft.err).toMatch(/draft/);

    const g = setup({ ci: false });
    branch(g, 'task/a', { 'a.txt': 'a\n' });
    create(g, 'task/a');
    const gTip = mainTip(g);
    const noCi = gh(g, ['pr', 'merge', '1', '--merge']);
    expect(noCi.code).toBe(1);
    expect(noCi.err).toContain('ci.json');
    expect(mainTip(g)).toBe(gTip);
    expect(json(gh(g, ['pr', 'view', '1', '--json', 'state'])).state).toBe('OPEN');
    expect(mainTip(f)).toBe(before);
    expect(tip).toMatch(/^[0-9a-f]{40}$/);
  });

  it('squashes into one commit and rebases onto the tip, with the PR merged either way', async () => {
    const f = setup();
    git(f.work, 'checkout', '-q', '-b', 'task/s');
    for (const n of ['s1', 's2']) {
      writeFileSync(join(f.work, `${n}.txt`), `${n}\n`);
      git(f.work, 'add', '.');
      git(f.work, 'commit', '-q', '-m', `commit ${n}`);
    }
    git(f.work, 'push', '-q', 'origin', 'task/s');
    git(f.work, 'checkout', '-q', 'main');
    create(f, 'task/s', '2.1: squashed');
    const before = mainTip(f);
    expect(gh(f, ['pr', 'merge', '1', '--squash', '--delete-branch']).code).toBe(0);
    const sq = mainTip(f);
    expect(git(f.remote, 'rev-list', '--parents', '-n', '1', sq).split(' ').slice(1)).toEqual([before]);
    expect(git(f.remote, 'log', '-1', '--format=%s', sq)).toBe('2.1: squashed (#1)');
    expect(git(f.remote, 'show', `${sq}:s2.txt`)).toBe('s2');
    expect(json(gh(f, ['pr', 'view', '1', '--json', 'state,mergeCommit']))).toEqual({ mergeCommit: { oid: sq }, state: 'MERGED' });

    git(f.work, 'pull', '-q', 'origin', 'main');
    git(f.work, 'checkout', '-q', '-b', 'task/r');
    for (const n of ['r1', 'r2']) {
      writeFileSync(join(f.work, `${n}.txt`), `${n}\n`);
      git(f.work, 'add', '.');
      git(f.work, 'commit', '-q', '-m', `commit ${n}`);
    }
    git(f.work, 'push', '-q', 'origin', 'task/r');
    git(f.work, 'checkout', '-q', 'main');
    // main moves after the branch was cut, so the rebase really replays the commits
    branch(f, 'task/m', { 'm.txt': 'm\n' });
    create(f, 'task/m', 'M');
    expect(gh(f, ['pr', 'merge', '2', '--merge']).code).toBe(0);
    create(f, 'task/r', 'R');
    const tipBefore = mainTip(f);
    expect(gh(f, ['pr', 'merge', '3', '--rebase']).code).toBe(0);
    const log = git(f.remote, 'log', '--format=%s', `${tipBefore}..main`).split('\n');
    expect(log).toEqual(['commit r2', 'commit r1']);
    expect(git(f.remote, 'rev-list', '--merges', `${tipBefore}..main`)).toBe('');
    expect(git(f.remote, 'show', 'main:r2.txt')).toBe('r2');
    expect(git(f.remote, 'show', 'main:m.txt')).toBe('m');
    expect(json(gh(f, ['pr', 'view', '3', '--json', 'mergeCommit'])).mergeCommit.oid).toBe(mainTip(f));
  });
});

describe('checks and runs from the records of bench/ci.js', () => {
  type Run = { id: number; sha: string; status: string; conclusion: string | null };
  /** Writes a run record the way bench/ci.js would, with no runner: tests set the state they need. */
  function record(f: Fx, sha: string, patch: Record<string, unknown> = {}): Run {
    const run = enqueueRun(f.state, { sha, branch: String(patch.branch ?? 'task/a'), event: (patch.event as string) ?? 'pull_request', start: false });
    return setRun(f, run.id, patch);
  }
  function setRun(f: Fx, id: number, patch: Record<string, unknown>): Run {
    const path = join(f.state, 'runs', `${id}.json`);
    const next = { ...JSON.parse(readFileSync(path, 'utf8')), ...patch };
    writeFileSync(path, JSON.stringify(next));
    return next;
  }
  const done = (conclusion: string, extra: Record<string, unknown> = {}) => ({ status: 'completed', conclusion, durationMs: 62000, ...extra });

  it('reports pending, then green, then red: exit 8, 0 and 1, the fixture shapes, and the plain table', () => {
    const f = setup();
    const tip = branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    const run = record(f, tip, { status: 'in_progress' });

    const pending = gh(f, ['pr', 'checks', '1', '--json', 'name,state,bucket,link,workflow']);
    expect(pending.code).toBe(8);
    const rows = JSON.parse(pending.out);
    const fx = fixture('gh-pr-checks-pending.json');
    expect(Object.keys(rows[0])).toEqual(Object.keys(fx[0]));
    expect(rows).toEqual([{ bucket: 'pending', link: `https://bench.invalid/bench/actions/runs/${run.id}/job/${run.id}`, name: 'ci', state: 'IN_PROGRESS', workflow: 'ci' }]);
    expect(rows[0].state).toBe(fx[0].state);
    const plainPending = gh(f, ['pr', 'checks', '1']);
    expect(plainPending.code).toBe(8);
    expect(plainPending.out.trim().split('\t').slice(0, 3)).toEqual(['ci', 'pending', '']);
    expect(gh(f, ['pr', 'checks', '1', '--json', 'state']).out).toBe('[{"state":"IN_PROGRESS"}]\n');
    setRun(f, run.id, { status: 'queued' });
    expect(JSON.parse(gh(f, ['pr', 'checks', '1', '--json', 'state,bucket']).out)).toEqual([{ bucket: 'pending', state: 'QUEUED' }]);

    setRun(f, run.id, done('success'));
    const green = gh(f, ['pr', 'checks', '1', '--json', 'name,state,bucket,link,workflow']);
    expect(green.code).toBe(0);
    const g = JSON.parse(green.out);
    const gfx = fixture('gh-pr-checks-green.json');
    expect(Object.keys(g[0])).toEqual(Object.keys(gfx[0]));
    expect(g[0]).toMatchObject({ bucket: gfx[0].bucket, state: gfx[0].state, name: 'ci', workflow: 'ci' });
    const plain = gh(f, ['pr', 'checks', '1']);
    expect(plain.code).toBe(0);
    expect(plain.out.trim().split('\t').slice(0, 3)).toEqual(['ci', 'pass', '1m2s']);
    expect(plain.out.trim().split('\t')[3]).toMatch(/^https:\/\//);

    const bad = branch(f, 'task/bad', { 'b.txt': 'b\n' });
    create(f, 'task/bad');
    record(f, bad, { branch: 'task/bad', ...done('failure') });
    const red = gh(f, ['pr', 'checks', '2', '--json', 'name,state,bucket,link,workflow']);
    expect(red.code).toBe(1);
    const fxr = fixture('gh-pr-checks-red.json');
    expect(JSON.parse(red.out)[0]).toMatchObject({ bucket: fxr[0].bucket, state: fxr[0].state, name: 'ci' });
    expect(gh(f, ['pr', 'checks', '2']).out.split('\t')[1]).toBe('fail');
    const cancelled = branch(f, 'task/c', { 'c2.txt': 'c\n' });
    create(f, 'task/c');
    record(f, cancelled, { branch: 'task/c', ...done('cancelled') });
    expect(gh(f, ['pr', 'checks', '3', '--json', 'bucket,state']).code).toBe(1);
    expect(JSON.parse(gh(f, ['pr', 'checks', '3', '--json', 'bucket,state']).out)).toEqual([{ bucket: 'cancel', state: 'CANCELLED' }]);
  });

  it('says no checks reported when no run matches the head, and the latest run of a sha decides', () => {
    const f = setup();
    const tip = branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    const none = gh(f, ['pr', 'checks', '1']);
    expect(none.code).toBe(1);
    expect(none.err).toContain("no checks reported on the 'task/a' branch");
    expect(none.out).toBe('');
    record(f, 'a'.repeat(40), done('success'));
    expect(gh(f, ['pr', 'checks', '1']).code).toBe(1);

    record(f, tip, done('success'));
    expect(gh(f, ['pr', 'checks', '1']).code).toBe(0);
    record(f, tip, { status: 'queued' });
    const rerun = gh(f, ['pr', 'checks', '1', '--json', 'bucket']);
    expect(rerun.code).toBe(8);
    expect(JSON.parse(rerun.out)).toEqual([{ bucket: 'pending' }]);
  });

  it('--watch waits until no check is pending and prints the final table', () => {
    const f = setup();
    const tip = branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    const run = record(f, tip, { status: 'in_progress' });
    const sleeps: number[] = [];
    const r = gh(f, ['pr', 'checks', '1', '--watch', '--fail-fast'], {
      env: { BENCH_POLL_MS: '250' },
      sleep: (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) setRun(f, run.id, done('success'));
      },
    });
    expect(sleeps).toEqual([250, 250]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ci\tpass\t1m2s\t/);
    expect(r.out.trim().split('\n')).toHaveLength(1);
  });

  it('--watch --fail-fast returns on the first failure while another check is still pending', () => {
    const f = setup();
    const tip = branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    record(f, tip, { status: 'in_progress' });
    record(f, tip, { name: 'lint', workflow: 'lint', ...done('failure') });
    const sleeps: number[] = [];
    const fast = gh(f, ['pr', 'checks', '1', '--watch', '--fail-fast'], { sleep: (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([]);
    expect(fast.code).toBe(1);
    expect(fast.out).toMatch(/^lint\tfail\t/m);
    expect(fast.out).toMatch(/^ci\tpending\t/m);
    const slow = gh(f, ['pr', 'checks', '1', '--watch'], {
      env: { BENCH_POLL_MS: '5' },
      sleep: () => {
        const ci = listRuns(f.state).find((r: { name: string }) => r.name === 'ci');
        setRun(f, ci.id, done('success'));
      },
    });
    expect(slow.code).toBe(1);
    expect(slow.out).toMatch(/^ci\tpass\t/m);
  });

  it('lists runs as in the fixtures: in progress with an empty conclusion, success, failure; and filters them', () => {
    const f = setup();
    const a = record(f, 'a'.repeat(40), { branch: 'task/a', status: 'in_progress' });
    const fields = 'conclusion,databaseId,status';
    const open = json(gh(f, ['run', 'list', '--branch', 'task/a', '--json', fields]));
    const fx = fixture('gh-run-list-in-progress.json');
    expect(Object.keys(open[0])).toEqual(Object.keys(fx[0]));
    expect(open).toEqual([{ conclusion: '', databaseId: a.id, status: 'in_progress' }]);
    expect(Number.isInteger(open[0].databaseId)).toBe(true);

    setRun(f, a.id, done('success'));
    const ok = json(gh(f, ['run', 'list', '--branch', 'task/a', '--workflow', 'ci', '--commit', 'a'.repeat(40), '--json', fields]));
    expect(ok).toEqual([{ conclusion: 'success', databaseId: a.id, status: 'completed' }]);
    expect(Object.keys(ok[0])).toEqual(Object.keys(fixture('gh-run-list-success.json')[0]));

    const b = record(f, 'b'.repeat(40), { branch: 'main', event: 'push', ...done('failure') });
    expect(json(gh(f, ['run', 'list', '--commit', 'b'.repeat(40), '--json', fields]))).toEqual([{ conclusion: 'failure', databaseId: b.id, status: 'completed' }]);
    expect(Object.keys(json(gh(f, ['run', 'list', '--commit', 'b'.repeat(40), '--json', fields]))[0])).toEqual(Object.keys(fixture('gh-run-list-failure.json')[0]));
    expect(json(gh(f, ['run', 'list', '--branch', 'main', '--json', 'databaseId']))).toEqual([{ databaseId: b.id }]);
    expect(json(gh(f, ['run', 'list', '--workflow', 'other', '--json', 'databaseId']))).toEqual([]);
    expect(json(gh(f, ['run', 'list', '--workflow', 'ci.yml', '--json', 'databaseId']))).toHaveLength(2);
    expect(json(gh(f, ['run', 'list', '--limit', '1', '--json', 'databaseId']))).toEqual([{ databaseId: b.id }]);
    expect(json(gh(f, ['run', 'list', '--json', 'databaseId'])).map((r: { databaseId: number }) => r.databaseId)).toEqual([b.id, a.id]);
    const plain = gh(f, ['run', 'list', '--branch', 'task/a']).out.trim().split('\t');
    expect(plain[0]).toBe('completed');
    expect(plain[1]).toBe('success');
    expect(plain.slice(3, 7)).toEqual(['ci', 'task/a', 'pull_request', String(a.id)]);
    expect(plain[7]).toBe('1m2s');
    expect(gh(f, ['run', 'list', '--branch', 'nowhere']).err).toMatch(/No runs found/);
  });

  it('prints the failed log of a red run, nothing for a green one, and refuses one still running', () => {
    const f = setup();
    const running = record(f, 'a'.repeat(40), { status: 'in_progress' });
    const bad = record(f, 'b'.repeat(40), { branch: 'task/bad', ...done('failure', { logTail: '$ npm test\n1 failed\ncheck failed: ok.txt is missing\nexit 1\n' }) });
    const good = record(f, 'c'.repeat(40), { branch: 'task/good', ...done('success', { logTail: '$ npm test\nok\n' }) });
    const early = gh(f, ['run', 'view', String(running.id), '--log-failed']);
    expect(early.code).toBe(1);
    expect(early.err).toMatch(/still in progress/);
    const log = gh(f, ['run', 'view', String(bad.id), '--log-failed']);
    expect(log.code).toBe(0);
    expect(log.out).toBe('$ npm test\n1 failed\ncheck failed: ok.txt is missing\nexit 1\n');
    expect(gh(f, ['run', 'view', String(good.id), '--log-failed']).out).toBe('');
    const view = gh(f, ['run', 'view', String(bad.id)]);
    expect(view.code).toBe(0);
    expect(view.out).toContain(String(bad.id));
    expect(view.out).toContain('task/bad');
    expect(json(gh(f, ['run', 'view', String(bad.id), '--json', 'databaseId,status,conclusion']))).toEqual({ conclusion: 'failure', databaseId: bad.id, status: 'completed' });
    expect(gh(f, ['run', 'view', '--log-failed']).code).toBe(1);
    const missing = gh(f, ['run', 'view', '99999', '--log-failed']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('99999');
  });

  it('run watch waits for the run, and --exit-status turns a failure into exit 1', () => {
    const f = setup();
    const run = record(f, 'a'.repeat(40), { status: 'in_progress' });
    let slept = 0;
    const ok = gh(f, ['run', 'watch', String(run.id), '--exit-status'], {
      sleep: () => {
        slept++;
        setRun(f, run.id, done('success'));
      },
    });
    expect(slept).toBe(1);
    expect(ok.code).toBe(0);
    const bad = record(f, 'b'.repeat(40), done('failure'));
    expect(gh(f, ['run', 'watch', String(bad.id), '--exit-status']).code).toBe(1);
    expect(gh(f, ['run', 'watch', String(bad.id)]).code).toBe(0);
    expect(gh(f, ['run', 'watch', '99999']).code).toBe(1);
    expect(gh(f, ['run', 'watch']).code).toBe(1);
  });

  // The one test with the real hook and runner: push records a queued run, the check waits for the gate, then the
  // run turns green and `pr checks` follows it (red runs are covered by the hand-written records above and by bench-ci).
  it('follows the real local CI of bench/ci.js: pending while the check waits, then green', async () => {
    const f = setup({ open: false });
    const tip = branch(f, 'task/a', { 'a.txt': 'a\n' });
    create(f, 'task/a');
    const run = await waitFor(() => listRuns(f.state).find((r: { sha: string }) => r.sha === tip));
    expect(run.event).toBe('pull_request');
    const pending = gh(f, ['pr', 'checks', '1', '--json', 'bucket']);
    expect(pending.code).toBe(8);
    expect(JSON.parse(pending.out)).toEqual([{ bucket: 'pending' }]);
    writeFileSync(f.gate, 'go');
    await waitFor(() => listRuns(f.state).every((r: { status: string }) => r.status === 'completed'), 150000);
    expect(gh(f, ['pr', 'checks', '1']).code).toBe(0);
  }, 400000);
});

describe('jq expressions as the loop uses them', () => {
  it('evaluates .mergeable, .files[].path and .body, and nothing else', () => {
    const f = setup();
    branch(f, 'task/a', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    create(f, 'task/a');
    expect(gh(f, ['pr', 'view', '1', '--json', 'mergeable', '-q', '.mergeable']).out).toBe('MERGEABLE\n');
    expect(gh(f, ['pr', 'view', '1', '--json', 'files', '-q', '.files[].path']).out).toBe('a.txt\nb.txt\n');
    expect(gh(f, ['pr', 'view', '1', '--json', 'body', '-q', '.body']).out).toBe('body of task/a\n');
    expect(gh(f, ['pr', 'view', '1', '--json', 'files', '--jq', '.files[0].path']).out).toBe('a.txt\n');
    expect(gh(f, ['pr', 'view', '1', '--json', 'mergeCommit', '-q', '.mergeCommit']).out).toBe('null\n');
    expect(gh(f, ['pr', 'list', '--json', 'number', '-q', '.[].number']).out).toBe('1\n');
  });
});
