import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { ciOnlyChange, formattingOnly } from './delta.js';

// Loop perf change 6: a second critic round is skipped when the critic already said MERGE and the only later changes are
// CI-only. These tests run real git in a temporary repository (no network): gh and `git fetch origin` are faked.

describe('formattingOnly', () => {
  it('is true for whitespace, quote style, semicolons and trailing commas', () => {
    expect(formattingOnly("const a = { x: 'y', z: [1, 2,], };\n", 'const a = {\n  x: "y",\n  z: [1, 2],\n}\n')).toBe(true);
    expect(formattingOnly('{"a":1,"b":[1,2]}', '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n')).toBe(true);
  });

  it('is false for any change a formatter does not make', () => {
    expect(formattingOnly('expect(a).toBe(1)', 'expect(a).toBe(2)')).toBe(false);
    expect(formattingOnly('expect(a).toBe(1)\n', '')).toBe(false);
    expect(formattingOnly("it('a', f)", "it.skip('a', f)")).toBe(false);
    expect(formattingOnly('a(x)', '(a)(x)')).toBe(false);
  });
});

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test', GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'delta-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (file: string, text: string) => writeFileSync(join(dir, file), text);
  const commit = (msg: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  write('a.ts', "export const a = { x: 'y' };\n");
  write('b.ts', 'export const b = 1;\n');
  commit('base');
  git('checkout', '-q', '-b', 'feat');
  write('a.ts', "export const a = { x: 'y', z: 2 };\n");
  const reviewed = commit('task');
  const publishMain = () => git('update-ref', 'refs/remotes/origin/main', 'main');
  publishMain();
  // The fake world: gh reports the branch head as the PR head; fetch is a no-op; every other command is real git.
  const run = (command: string) => {
    if (/^gh pr view \d+ --json headRefOid,baseRefName$/.test(command)) return { code: 0, stdout: JSON.stringify({ headRefOid: git('rev-parse', 'feat'), baseRefName: 'main' }) };
    if (command === 'git fetch origin') return { code: 0, stdout: '' };
    const r = spawnSync('sh', ['-c', command], { cwd: dir, env, encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  const check = (since = reviewed) => ciOnlyChange({ pr: 7, since }, { run });
  return { dir, git, write, commit, reviewed, publishMain, check };
}

describe('ciOnlyChange (real git)', () => {
  it('no new commit since the reviewed head is CI-only', async () => {
    const r = repo();
    expect(await r.check()).toMatchObject({ ciOnly: true, reason: 'no new commits since the reviewed head' });
  }, 120_000);

  it('a formatting-only commit is CI-only and names the file', async () => {
    const r = repo();
    r.write('a.ts', 'export const a = {\n  x: "y",\n  z: 2,\n}\n');
    r.commit('prettier');
    const d = await r.check();
    expect(d).toMatchObject({ ciOnly: true, commits: 1, files: ['a.ts'] });
    expect(d.reason).toMatch(/formatting-only/);
  }, 120_000);

  it('a clean sync merge from main is CI-only, even though main changed other files', async () => {
    const r = repo();
    r.git('checkout', '-q', 'main');
    r.write('b.ts', 'export const b = 2;\n');
    r.commit('main moves');
    r.publishMain();
    r.git('checkout', '-q', 'feat');
    r.git('merge', '-q', '--no-edit', '-m', 'Sync branch with upstream before merge', 'main');
    const d = await r.check();
    expect(d).toMatchObject({ ciOnly: true, commits: 1 });
    expect(d.reason).toMatch(/clean sync merge/);
  }, 120_000);

  it('a sync merge that resolved a conflict is not CI-only', async () => {
    const r = repo();
    r.git('checkout', '-q', 'main');
    r.write('a.ts', "export const a = { x: 'main' };\n");
    r.commit('main changes a');
    r.publishMain();
    r.git('checkout', '-q', 'feat');
    spawnSync('git', ['merge', '-q', 'main'], { cwd: r.dir, env, encoding: 'utf8' }); // conflicts in a.ts
    r.write('a.ts', "export const a = { x: 'main', z: 2 };\n");
    r.commit('Sync branch with upstream before merge');
    const d = await r.check();
    expect(d.ciOnly).toBe(false);
    expect(d.reason).toMatch(/resolved a conflict/);
  }, 120_000);

  it('a code change, an added file or a deleted file is not CI-only', async () => {
    const code = repo();
    code.write('a.ts', "export const a = { x: 'y', z: 3 };\n");
    code.commit('fix');
    expect(await code.check()).toMatchObject({ ciOnly: false });

    const added = repo();
    added.write('c.ts', 'export {};\n');
    added.commit('add');
    expect((await added.check()).reason).toMatch(/adds c\.ts/);

    const deleted = repo();
    deleted.git('rm', '-q', 'b.ts');
    deleted.commit('delete');
    expect((await deleted.check()).reason).toMatch(/deletes b\.ts/);
  }, 120_000);

  it('a formatting commit followed by a real change is not CI-only', async () => {
    const r = repo();
    r.write('a.ts', 'export const a = {\n  x: "y",\n  z: 2,\n}\n');
    r.commit('prettier');
    r.write('b.ts', 'export const b = 5;\n');
    r.commit('real');
    expect(await r.check()).toMatchObject({ ciOnly: false });
  }, 120_000);

  it('a reviewed head that is not a sha, or not in the branch, is not CI-only', async () => {
    const r = repo();
    expect(await r.check('abc')).toMatchObject({ ciOnly: false });
    r.git('checkout', '-q', 'main');
    r.write('b.ts', 'x\n');
    const other = r.commit('elsewhere');
    r.git('checkout', '-q', 'feat');
    r.write('a.ts', "export const a = { x: 'y', z: 2 }\n");
    r.commit('semicolon');
    const d = await r.check(other);
    expect(d.ciOnly).toBe(false);
    expect(d.reason).toMatch(/not an ancestor/);
  }, 120_000);
});
