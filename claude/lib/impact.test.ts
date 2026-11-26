import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module with JSDoc
import { impactMap, parseAliases, parseImports, parseOwners, resolveSpecifier } from './impact.js';

const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'scripts', 'impact.js');

const scratch = mkdtempSync(join(tmpdir(), 'impact-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let counter = 0;

function makeRepo(files: Record<string, string>, track = true): string {
  const dir = join(scratch, `repo${++counter}`);
  mkdirSync(dir);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: GIT_ENV });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (track) spawnSync('git', ['add', '-A'], { cwd: dir, env: GIT_ENV });
  return dir;
}

function runCli(args: string[]) {
  const r = spawnSync('node', [cli, ...args], { encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const SPEC = [
  '# Spec',
  '',
  '## Wave 2',
  '',
  '- **2.1 Something.** Owns `src/other.ts`, `tests/unrelated.test.ts`. Test: x.',
  '- **2.T Wave 2 tail.** Depends on 2.1. Owns `tests/direct.test.ts`,',
  '  `tests/fixtures/*.md`. Test: the tail. Mentions `tests/one.test.ts` after the Owns clause.',
  '',
].join('\n');

const FIXTURE: Record<string, string> = {
  'tsconfig.json': [
    '{',
    '  // a comment, as tsconfig files have',
    '  "compilerOptions": {',
    '    "baseUrl": ".",',
    '    "paths": { "@/*": ["src/*"], },',
    '  },',
    '}',
    '',
  ].join('\n'),
  'src/core.ts': 'export const core = 1;\n',
  'src/mid.ts': "import { core } from './core';\nexport const mid = core;\n",
  'src/mid2.ts': "import { mid } from './mid';\nexport const mid2 = mid;\n",
  'src/direct-user.ts': "import { core } from './core';\nexport const u = core;\n",
  'src/other.ts': 'export const other = 1;\n',
  'lib/a.ts': 'export const a = 1;\n',
  'lib/deep/b.ts': 'export const b = 1;\n',
  'pkg/index.ts': 'export const pkg = 1;\n',
  'src/core2.ts': 'export const core2 = 1;\n',
  'src/ajs.ts': 'export const ajs = 1;\n',
  'src/core3.ts': 'export const a = 1;\nexport const b = 2;\n',
  'src/core4.ts': 'globalThis.x = 1;\n',
  'src/core5.ts': 'export type T = number;\n',
  'src/core6.ts': 'export const six = 6;\n',
  'tests/direct.test.ts': "import { core } from '../src/core';\nconsole.log(core);\n",
  'tests/one.test.ts': "import { mid } from '../src/mid';\nconsole.log(mid);\n",
  'tests/two.test.ts': "import { mid2 } from '../src/mid2';\nconsole.log(mid2);\n",
  'tests/dyn.test.ts': "const m = await import('../src/core');\nconsole.log(m);\n",
  'tests/req.test.ts': "const m = require('../src/core');\nconsole.log(m);\n",
  'tests/bare.test.ts': "import fs from 'node:fs';\nimport v from 'vitest';\nimport c from 'core';\nimport s from 'src/core';\n",
  'tests/dir.test.ts': "import { b } from '../lib/deep/b';\nconsole.log(b);\n",
  'tests/idx.test.ts': "import { pkg } from '../pkg';\nconsole.log(pkg);\n",
  'tests/alias.test.ts': "import { core2 } from '@/core2';\nconsole.log(core2);\n",
  'tests/js.test.ts': "import { ajs } from '../src/ajs.js';\nconsole.log(ajs);\n",
  'tests/multi.test.ts': "import {\n  a,\n  b,\n} from '../src/core3';\nconsole.log(a, b);\n",
  'tests/side.test.ts': "import '../src/core4';\n",
  'tests/type.test.ts': "import type { T } from '../src/core5';\nexport type U = T;\n",
  'tests/mock.test.ts': "vi.mock('../src/core6');\n",
  'tests/unrelated.test.ts': "import { other } from '../src/other';\nconsole.log(other);\n",
};

const OWNS = [
  'src/core.ts',
  'lib',
  'pkg/index.ts',
  'src/core2.ts',
  'src/ajs.ts',
  'src/core3.ts',
  'src/core4.ts',
  'src/core5.ts',
  'src/core6.ts',
];

describe('scripts/impact.js on a temp repo', () => {
  const repo = makeRepo(FIXTURE);
  const specPath = join(scratch, 'spec.md');
  writeFileSync(specPath, SPEC);

  function tests(extra: string[] = []) {
    const r = runCli(['--repo', repo, '--owns', ...OWNS, ...extra]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    return JSON.parse(r.stdout).tests as Array<{ path: string; via: string | null; owner: string | null }>;
  }

  it('lists the tests that import an owned path directly or through one module', () => {
    const got = Object.fromEntries(tests().map((t) => [t.path, t.via]));
    expect(got).toEqual({
      'tests/direct.test.ts': null,
      'tests/one.test.ts': 'src/mid.ts',
      'tests/dyn.test.ts': null,
      'tests/req.test.ts': null,
      'tests/dir.test.ts': null,
      'tests/idx.test.ts': null,
      'tests/alias.test.ts': null,
      'tests/js.test.ts': null,
      'tests/multi.test.ts': null,
      'tests/side.test.ts': null,
      'tests/type.test.ts': null,
      'tests/mock.test.ts': null,
    });
  });

  it('does not list a test two modules away, a bare package import or a non-test importer', () => {
    const paths = tests().map((t) => t.path);
    expect(paths).not.toContain('tests/two.test.ts');
    expect(paths).not.toContain('tests/bare.test.ts');
    expect(paths).not.toContain('tests/unrelated.test.ts');
    expect(paths).not.toContain('src/direct-user.ts');
  });

  it('prints owner null without --spec and the owning task id with it', () => {
    expect(tests().every((t) => t.owner === null)).toBe(true);
    const withSpec = Object.fromEntries(tests(['--spec', specPath]).map((t) => [t.path, t.owner]));
    expect(withSpec['tests/direct.test.ts']).toBe('2.T');
    expect(withSpec['tests/one.test.ts']).toBeNull();
    expect(withSpec['tests/dyn.test.ts']).toBeNull();
  });

  it('is sorted by path', () => {
    const paths = tests().map((t) => t.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('reads testGlobs from .claude/loop.local.json', () => {
    const custom = makeRepo({
      ...FIXTURE,
      '.claude/loop.local.json': JSON.stringify({ testGlobs: ['tests/direct.test.ts'] }),
    });
    const r = runCli(['--repo', custom, '--owns', ...OWNS]);
    expect(JSON.parse(r.stdout).tests.map((t: { path: string }) => t.path)).toEqual(['tests/direct.test.ts']);
  });

  it('exits 4 on bad usage and 1 with a note when the spec cannot be read', () => {
    expect(runCli(['--owns', 'src/core.ts']).code).toBe(4);
    expect(runCli(['--repo', repo]).code).toBe(4);
    const missing = runCli(['--repo', repo, '--owns', 'src/core.ts', '--spec', join(scratch, 'nope.md')]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).tests).toEqual([]);
  });
});

// Task 2.2: tests that no import shows, because they read an owned file with readFileSync or run it with execFile, are
// listed with via "name": a test file with a quoted string that holds an owned file's repo-relative path or its basename.
describe('scripts/impact.js lists tests that name an owned file in a string (via "name")', () => {
  const NAMED: Record<string, string> = {
    'src/named.ts': 'export const named = 1;\n',
    'scripts/tool.py': 'print(1)\n',
    'src/imported.ts': 'export const imported = 1;\n',
    'tests/name-path.test.ts': "const text = readFileSync(join(root, 'src/named.ts'), 'utf8');\n",
    'tests/name-parts.test.ts': "const text = readFileSync(join(root, 'src', 'named.ts'), 'utf8');\n",
    'tests/name-template.test.ts': 'const text = readFileSync(`${dir}/named.ts`, "utf8");\n',
    'tests/name-py.test.ts': "await execFile('python3', ['-I', join(root, 'scripts', 'tool.py')]);\n",
    'tests/name-import-and-string.test.ts': "import { imported } from '../src/imported';\nconst again = 'imported.ts';\nconsole.log(imported, again);\n",
    'tests/name-near-miss.test.ts': "const a = 'src/unnamed.ts';\nconst b = 'named.tsx';\nconst c = 'my-tool.py2';\nconst d = 'src/named';\n",
    'tests/name-unquoted.test.ts': '// named.ts is only mentioned in a comment\nconst x = 1;\n',
    'tests/name-other.test.ts': "const a = 'src/other.ts';\n",
  };
  const repo = makeRepo({ ...FIXTURE, ...NAMED });
  const specPath = join(scratch, 'spec-named.md');
  writeFileSync(specPath, ['## Wave 2', '', '- **2.7 Names.** Owns `src/named.ts`, `tests/name-py.test.ts`. Test: x.', ''].join('\n'));

  function named(owns: string[], extra: string[] = []) {
    const r = runCli(['--repo', repo, '--owns', ...owns, ...extra]);
    expect(r.code).toBe(0);
    return JSON.parse(r.stdout).tests as Array<{ path: string; via: string | null; owner: string | null }>;
  }

  it('lists a test with a quoted string holding the owned path, its parts joined, or its basename', () => {
    const got = Object.fromEntries(named(['src/named.ts', 'scripts/tool.py']).map((t) => [t.path, t.via]));
    expect(got).toEqual({
      'tests/name-path.test.ts': 'name',
      'tests/name-parts.test.ts': 'name',
      'tests/name-template.test.ts': 'name',
      'tests/name-py.test.ts': 'name',
    });
  });

  it('does not list near misses, a name outside a string, or a test that names an unowned file', () => {
    const paths = named(['src/named.ts', 'scripts/tool.py']).map((t) => t.path);
    for (const p of ['tests/name-near-miss.test.ts', 'tests/name-unquoted.test.ts', 'tests/name-other.test.ts']) expect(paths).not.toContain(p);
  });

  it('keeps the import result for a test that also names the file: via stays the import, not "name"', () => {
    const got = Object.fromEntries(named(['src/imported.ts']).map((t) => [t.path, t.via]));
    expect(got).toEqual({ 'tests/name-import-and-string.test.ts': null });
  });

  it('keeps the other fields: path, via, owner, sorted by path, owner from --spec', () => {
    const tests = named(['src/named.ts', 'scripts/tool.py'], ['--spec', specPath]);
    expect(tests.every((t) => Object.keys(t).sort().join() === 'owner,path,via')).toBe(true);
    const paths = tests.map((t) => t.path);
    expect(paths).toEqual([...paths].sort());
    expect(Object.fromEntries(tests.map((t) => [t.path, t.owner]))).toMatchObject({ 'tests/name-py.test.ts': '2.7', 'tests/name-path.test.ts': null });
  });

  it('an owned directory names every tracked file under it, and a file that does not exist names nothing', () => {
    expect(named(['src/missing-file.ts']).map((t) => t.path)).toEqual([]);
    expect(named(['scripts']).map((t) => t.path)).toEqual(['tests/name-py.test.ts']);
  });
});

describe('parseImports', () => {
  it('finds every import form', () => {
    const src = [
      "import a from './a';",
      "import { b } from \"./b\";",
      "import type { C } from './c';",
      "import './d';",
      "export * from './e';",
      "export { f } from './f';",
      "const g = await import('./g');",
      "const h = require('./h');",
      "vi.mock('./i');",
      "import {\n  j,\n  k,\n} from './j';",
      "import fs from 'node:fs';",
    ].join('\n');
    expect(parseImports(src).sort()).toEqual(
      ['./a', './b', './c', './d', './e', './f', './g', './h', './i', './j', 'node:fs'].sort(),
    );
  });

  it('ignores calls that only look like imports', () => {
    expect(parseImports("const x = Array.from('abc'); foo('./a'); important('./b');")).toEqual([]);
  });
});

describe('resolveSpecifier', () => {
  const files = new Set(['src/a.ts', 'src/b.tsx', 'src/c/index.mjs', 'src/d.mts', 'src/e.js', 'src/e.ts', 'src/f.json']);
  const noAlias = { entries: [] };
  it('resolves extensions, index files and js-to-ts specifiers', () => {
    expect(resolveSpecifier('./a', 'src/x.ts', files, noAlias)).toBe('src/a.ts');
    expect(resolveSpecifier('./b', 'src/x.ts', files, noAlias)).toBe('src/b.tsx');
    expect(resolveSpecifier('./c', 'src/x.ts', files, noAlias)).toBe('src/c/index.mjs');
    expect(resolveSpecifier('./a.js', 'src/x.ts', files, noAlias)).toBe('src/a.ts');
    expect(resolveSpecifier('./d.mjs', 'src/x.ts', files, noAlias)).toBe('src/d.mts');
    expect(resolveSpecifier('./e.js', 'src/x.ts', files, noAlias)).toBe('src/e.js');
    expect(resolveSpecifier('./f.json', 'src/x.ts', files, noAlias)).toBe('src/f.json');
    expect(resolveSpecifier('../src/a', 'tests/x.ts', files, noAlias)).toBe('src/a.ts');
  });
  it('returns null for bare packages and missing files', () => {
    expect(resolveSpecifier('vitest', 'src/x.ts', files, noAlias)).toBeNull();
    expect(resolveSpecifier('./nope', 'src/x.ts', files, noAlias)).toBeNull();
  });
  it('resolves a tsconfig alias like a relative path', () => {
    const alias = parseAliases('{ "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["*"] } } }', '');
    expect(resolveSpecifier('@/a', 'tests/x.ts', files, alias)).toBe('src/a.ts');
    expect(resolveSpecifier('@/c', 'tests/x.ts', files, alias)).toBe('src/c/index.mjs');
  });
});

describe('parseOwners', () => {
  it('maps task ids to the paths of their Owns clause only', () => {
    const owners = parseOwners(SPEC);
    expect(owners.map((o: { id: string }) => o.id)).toEqual(['2.1', '2.T']);
    const tail = owners.find((o: { id: string }) => o.id === '2.T');
    expect(tail.patterns).toEqual(['tests/direct.test.ts', 'tests/fixtures/*.md']);
  });
});

describe('impactMap', () => {
  it('works on injected files and reads', async () => {
    const contents: Record<string, string> = {
      'src/a.ts': 'export {}',
      'tests/a.test.ts': "import '../src/a';",
      'README.md': '# hi',
    };
    const out = await impactMap(
      { files: Object.keys(contents), owns: ['src/a.ts'], globs: ['**/*.test.*'], tsconfig: null, spec: null },
      { read: async (p: string) => contents[p] },
    );
    expect(out).toEqual({ tests: [{ path: 'tests/a.test.ts', via: null, owner: null }] });
  });
});
