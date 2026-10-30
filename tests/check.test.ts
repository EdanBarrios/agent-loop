import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 0.1 acceptance. `npm run check` itself runs vitest, so this file cannot call it without
// recursing. It reads the scripts from package.json and runs the syntax step on a temp copy of claude/.
const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

function runStep(script: string, cwd: string) {
  return spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8' });
}

describe('npm run check', () => {
  it('chains the syntax step, the python step and vitest', () => {
    expect(pkg.scripts.check).toContain('npm run check:syntax');
    expect(pkg.scripts.check).toContain('npm run check:py');
    expect(pkg.scripts.check).toContain('vitest run');
    expect(pkg.scripts['check:syntax']).toContain('node --check');
    expect(pkg.scripts['check:py']).toContain('python3 -I -m py_compile scripts/*.py');
  });

  it('syntax step passes on the real claude/ tree', () => {
    const r = runStep(pkg.scripts['check:syntax'], root);
    expect(r.status, r.stderr).toBe(0);
  });

  it('syntax step exits non-zero when wave-loop.js is broken (temp copy)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-'));
    cpSync(join(root, 'claude'), join(dir, 'claude'), { recursive: true });
    expect(runStep(pkg.scripts['check:syntax'], dir).status).toBe(0);
    const file = join(dir, 'claude', 'workflows', 'wave-loop.js');
    writeFileSync(file, readFileSync(file, 'utf8') + '\nconst broken = ;\n');
    const r = runStep(pkg.scripts['check:syntax'], dir);
    expect(r.status).not.toBe(0);
  });

  it('syntax step also reaches files in new subdirectories such as claude/lib', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-'));
    mkdirSync(join(dir, 'claude', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'claude', 'lib', 'bad.js'), 'export const x = ;\n');
    expect(runStep(pkg.scripts['check:syntax'], dir).status).not.toBe(0);
  });

  it('syntax step accepts a valid ES module in claude/lib', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-'));
    mkdirSync(join(dir, 'claude', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'claude', 'lib', 'ok.js'), "import { join } from 'node:path';\nexport const x = join('a', 'b');\n");
    expect(runStep(pkg.scripts['check:syntax'], dir).status).toBe(0);
  });

  it('python step compiles scripts/*.py', () => {
    const r = runStep(pkg.scripts['check:py'], root);
    expect(r.status, r.stderr).toBe(0);
  });

  it('vitest config finds tests/ and claude/lib tests', () => {
    const cfg = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
    expect(cfg).toContain("'tests/**/*.test.ts'");
    expect(cfg).toContain("'claude/lib/**/*.test.ts'");
  });
});
