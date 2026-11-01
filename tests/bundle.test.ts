import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../scripts/bundle-workflows.js';

// Task 3.1 acceptance: `node scripts/bundle-workflows.js [--check]`. Cases run the CLI body in-process
// against a temp project root (`--root`); the `real CLI` block spawns it once for real.
const root = join(import.meta.dirname, '..');
const script = join(root, 'scripts', 'bundle-workflows.js');
const base = mkdtempSync(join(tmpdir(), 'bundle-'));
let n = 0;

type Project = { dir: string; lib: (name: string, src: string) => void; wf: (name: string, src: string) => void; read: (rel: string) => string };

function project(): Project {
  const dir = join(base, `p${n++}`);
  mkdirSync(join(dir, 'claude', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'claude', 'workflows'), { recursive: true });
  return {
    dir,
    lib: (name, src) => writeFileSync(join(dir, 'claude', 'lib', `${name}.js`), src),
    wf: (name, src) => writeFileSync(join(dir, 'claude', 'workflows', `${name}.js`), src),
    read: (rel) => readFileSync(join(dir, rel), 'utf8'),
  };
}

function run(p: Project, ...flags: string[]) {
  let out = '';
  const code = main(['node', script, '--root', p.dir, ...flags], { out: (s: string) => (out += s), err: (s: string) => (out += s) });
  return { code, out };
}

const LIB = [
  '// helper lib',
  'export const LIMIT = 3;',
  'export function double(x) {',
  '  return x * 2;',
  '}',
  'export async function later(x) {',
  '  return double(x);',
  '}',
  'function hidden() {',
  '  return "export is only a word here";',
  '}',
  '',
].join('\n');

const WF = [
  'const args = {};',
  '// @bundle-start helper',
  'stale text that the bundler replaces',
  '// @bundle-end helper',
  'return double(args.n);',
  '',
].join('\n');

describe('bundling a temp workflow', () => {
  it('bundles the lib without export keywords, then --check passes', () => {
    const p = project();
    p.lib('helper', LIB);
    p.wf('w', WF);
    expect(run(p).code).toBe(0);
    const out = p.read('claude/workflows/w.js');
    expect(out).toContain('// @bundle-start helper');
    expect(out).toContain('// @bundle-end helper');
    expect(out).toContain('const LIMIT = 3;');
    expect(out).toContain('function double(x) {');
    expect(out).toContain('async function later(x) {');
    expect(out).not.toMatch(/^\s*export\b/m);
    expect(out).not.toContain('stale text');
    expect(out).toContain('return double(args.n);');
    const c = run(p, '--check');
    expect(c.code, c.out).toBe(0);
  });

  it('running the bundler twice yields identical files', () => {
    const p = project();
    p.lib('helper', LIB);
    p.wf('w', WF);
    run(p);
    const once = p.read('claude/workflows/w.js');
    expect(run(p).code).toBe(0);
    expect(p.read('claude/workflows/w.js')).toBe(once);
  });

  it('--check does not write, and fails on a region that was never bundled', () => {
    const p = project();
    p.lib('helper', LIB);
    p.wf('w', WF);
    const r = run(p, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('w.js');
    expect(r.out).toContain('helper');
    expect(p.read('claude/workflows/w.js')).toBe(WF);
  });

  it('editing the lib makes --check fail, naming the file and lib; re-bundling fixes it', () => {
    const p = project();
    p.lib('helper', LIB);
    p.wf('w', WF);
    run(p);
    p.lib('helper', LIB.replace('LIMIT = 3', 'LIMIT = 4'));
    const r = run(p, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('w.js');
    expect(r.out).toContain('helper');
    expect(r.out).toMatch(/stale/i);
    expect(run(p).code).toBe(0);
    expect(run(p, '--check').code).toBe(0);
  });

  it('a hand edit inside a region is a stale region', () => {
    const p = project();
    p.lib('helper', LIB);
    p.wf('w', WF);
    run(p);
    p.wf('w', p.read('claude/workflows/w.js').replace('LIMIT = 3', 'LIMIT = 99'));
    const r = run(p, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/stale/i);
  });

  it('bundles several libs; a relative import of an earlier bundled lib is dropped', () => {
    const p = project();
    p.lib('first', 'export function one() {\n  return 1;\n}\n');
    p.lib('second', "import { one } from './first.js';\nexport function two() {\n  return one() + 1;\n}\n");
    p.wf('w', ['// @bundle-start first', '// @bundle-end first', '// @bundle-start second', '// @bundle-end second', 'return two();', ''].join('\n'));
    expect(run(p).code).toBe(0);
    const out = p.read('claude/workflows/w.js');
    expect(out).not.toMatch(/^\s*import\b/m);
    expect(out).toContain('function two()');
    expect(run(p, '--check').code).toBe(0);
  });

  it('a multi-line import of an earlier bundled lib is dropped too', () => {
    const p = project();
    p.lib('first', 'export function one() {\n  return 1;\n}\nexport function uno() {\n  return 1;\n}\n');
    p.lib('second', "import {\n  one,\n  uno,\n} from './first.js';\nexport function two() {\n  return one() + uno();\n}\n");
    p.wf('w', ['// @bundle-start first', '// @bundle-end first', '// @bundle-start second', '// @bundle-end second', ''].join('\n'));
    expect(run(p).code).toBe(0);
    expect(p.read('claude/workflows/w.js')).not.toMatch(/^\s*import\b/m);
  });

  it('an import of a lib bundled later, or not bundled in that file, is an error naming the lib', () => {
    const p = project();
    p.lib('first', 'export function one() {\n  return 1;\n}\n');
    p.lib('second', "import { one } from './first.js';\nexport function two() {\n  return one();\n}\n");
    p.wf('w', ['// @bundle-start second', '// @bundle-end second', '// @bundle-start first', '// @bundle-end first', ''].join('\n'));
    const r = run(p);
    expect(r.code).toBe(1);
    expect(r.out).toContain('second');
    expect(r.out).toContain('import');
    p.wf('w', ['// @bundle-start second', '// @bundle-end second', ''].join('\n'));
    const r2 = run(p);
    expect(r2.code).toBe(1);
    expect(r2.out).toContain('second');
  });

  it('files without markers are left alone', () => {
    const p = project();
    p.lib('helper', LIB);
    p.wf('plain', 'return 1;\n');
    expect(run(p).code).toBe(0);
    expect(p.read('claude/workflows/plain.js')).toBe('return 1;\n');
    expect(run(p, '--check').code).toBe(0);
  });
});

describe('failures name the file and the lib', () => {
  it('an unbalanced marker: start without end', () => {
    const p = project();
    p.lib('helper', LIB);
    p.wf('w', '// @bundle-start helper\nreturn 1;\n');
    for (const flags of [[], ['--check']]) {
      const r = run(p, ...flags);
      expect(r.code).toBe(1);
      expect(r.out).toContain('w.js');
      expect(r.out).toContain('helper');
      expect(r.out).toMatch(/unbalanced/i);
    }
  });

  it('an unbalanced marker: end without start', () => {
    const p = project();
    p.lib('helper', LIB);
    p.wf('w', 'return 1;\n// @bundle-end helper\n');
    const r = run(p, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('w.js');
    expect(r.out).toContain('helper');
    expect(r.out).toMatch(/unbalanced/i);
  });

  it('an unbalanced marker: end names a different lib than start', () => {
    const p = project();
    p.lib('helper', LIB);
    p.lib('other', LIB);
    p.wf('w', '// @bundle-start helper\n// @bundle-end other\n');
    const r = run(p, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/unbalanced/i);
    expect(r.out).toContain('helper');
  });

  it('a missing lib', () => {
    const p = project();
    p.wf('w', '// @bundle-start ghost\n// @bundle-end ghost\n');
    for (const flags of [[], ['--check']]) {
      const r = run(p, ...flags);
      expect(r.code).toBe(1);
      expect(r.out).toContain('w.js');
      expect(r.out).toContain('ghost');
      expect(r.out).toMatch(/missing/i);
    }
  });

  it('a lib name that tries to leave claude/lib is a missing lib', () => {
    const p = project();
    p.wf('w', '// @bundle-start ../secret\n// @bundle-end ../secret\n');
    const r = run(p, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('../secret');
  });

  it.each([
    ['import', "import fs from 'node:fs';\nexport const a = 1;\n"],
    ['import', "export const a = await import('./x.js');\n"],
    ['require', "export const a = require('node:fs');\n"],
  ])('a lib that contains %s', (word, src) => {
    const p = project();
    p.lib('bad', src);
    p.wf('w', '// @bundle-start bad\n// @bundle-end bad\n');
    for (const flags of [[], ['--check']]) {
      const r = run(p, ...flags);
      expect(r.code).toBe(1);
      expect(r.out).toContain('w.js');
      expect(r.out).toContain('bad');
      expect(r.out).toContain(word);
    }
  });

  it('import( inside a comment, or the word required, is not an import', () => {
    const p = project();
    p.lib('ok', "/** @typedef {import('./x.js').T} T */\n// we required a thing; import is fine in prose\nexport const required = ['a'];\n");
    p.wf('w', '// @bundle-start ok\n// @bundle-end ok\n');
    expect(run(p).code).toBe(0);
  });

  it('a lib with export default', () => {
    const p = project();
    p.lib('bad', 'export default function f() {}\n');
    p.wf('w', '// @bundle-start bad\n// @bundle-end bad\n');
    for (const flags of [[], ['--check']]) {
      const r = run(p, ...flags);
      expect(r.code).toBe(1);
      expect(r.out).toContain('w.js');
      expect(r.out).toContain('bad');
      expect(r.out).toContain('export default');
    }
  });

  it.each([
    ["export { a } from './x.js';\n"],
    ["export * from './x.js';\n"],
    ['const a = 1;\nexport { a };\n'],
  ])('a lib with a re-export or export list: %s', (src) => {
    const p = project();
    p.lib('bad', src);
    p.wf('w', '// @bundle-start bad\n// @bundle-end bad\n');
    const r = run(p, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('bad');
    expect(r.out).toMatch(/re-export|export list|export \{|export \*/);
  });

  it('two libs that declare the same top-level name', () => {
    const p = project();
    p.lib('a', 'export function same() {}\n');
    p.lib('b', 'function same() {}\n');
    p.wf('w', '// @bundle-start a\n// @bundle-end a\n// @bundle-start b\n// @bundle-end b\n');
    const r = run(p);
    expect(r.code).toBe(1);
    expect(r.out).toContain('same');
    expect(r.out).toContain('w.js');
  });

  it('one problem does not hide another file: every bad file is named', () => {
    const p = project();
    p.lib('helper', LIB);
    p.wf('one', '// @bundle-start ghost\n// @bundle-end ghost\n');
    p.wf('two', '// @bundle-start helper\n');
    const r = run(p, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('one.js');
    expect(r.out).toContain('two.js');
  });

  it('a bad option or an unknown argument is exit 2', () => {
    const p = project();
    expect(run(p, '--nope').code).toBe(2);
  });
});

describe('the real workflows', () => {
  function realRun(...flags: string[]) {
    let out = '';
    const code = main(['node', script, ...flags], { out: (s: string) => (out += s), err: (s: string) => (out += s) });
    return { code, out };
  }

  it('--check passes on every workflow under claude/workflows', () => {
    const r = realRun('--check');
    expect(r.code, r.out).toBe(0);
  });

  it('spec-review.js bundles envelope and review and has no module import', () => {
    const text = readFileSync(join(root, 'claude', 'workflows', 'spec-review.js'), 'utf8');
    expect(text).not.toMatch(/^\s*import\b/m);
    expect(text).not.toMatch(/await import/);
    // code lines only: JSDoc type references in comments are not module imports
    const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/\bimport\s*\(|\bimport\.meta\b|\brequire\s*\(/);
    expect(text).toContain('// @bundle-start envelope');
    expect(text).toContain('// @bundle-start review');
    expect(text).toContain('// @bundle-end review');
    expect(text.indexOf('@bundle-start envelope')).toBeLessThan(text.indexOf('@bundle-start review'));
    expect(text).not.toMatch(/^export (?!const meta\b)/m);
  });

  it('the real CLI exits 0 on --check, and 1 on an unknown lib', () => {
    const ok = spawnSync('node', [script, '--check'], { encoding: 'utf8', cwd: root });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    const p = project();
    p.wf('w', '// @bundle-start ghost\n// @bundle-end ghost\n');
    const bad = spawnSync('node', [script, '--check', '--root', p.dir], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toContain('ghost');
  });
});

describe('package.json', () => {
  it('npm run check includes the bundle check', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.check).toContain('node scripts/bundle-workflows.js --check');
  });
});
