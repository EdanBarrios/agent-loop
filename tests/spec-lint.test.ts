import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../scripts/spec-lint.js';

// Task 1.4 acceptance: `node scripts/spec-lint.js <spec.md>`. Cases run the CLI body in-process on a
// spec file (a node spawn costs seconds on a loaded machine); the `real CLI` block spawns it for real.
const root = join(import.meta.dirname, '..');
const script = join(root, 'scripts', 'spec-lint.js');
const realSpec = join(root, 'docs', 'agent-loop-v2', '2026-10-30-agent-loop-v2-tasks.md');
const dir = mkdtempSync(join(tmpdir(), 'spec-lint-'));
let n = 0;

function lint(spec: string | null) {
  let path = realSpec;
  if (spec !== null) {
    path = join(dir, `spec-${n++}.md`);
    writeFileSync(path, spec);
  }
  let out = '';
  const code = main(['node', script, path], { out: (s) => (out += s), err: (s) => (out += s) });
  return { code, out };
}

const SECTIONS: Record<string, string> = {
  'End goal': 'Edan is needed only for money.',
  Invariants: '1. Never commit to the default branch.',
  Budget: 'No paid vendor calls.',
  'Decision envelope': 'Reversible and free is auto-accepted.',
  'Fixed decisions': '- Node ESM.',
  'Human checklist': '| id | before | what | why |\n|---|---|---|---|\n| H1 | 0 | Create the repo | needed |',
};

const GOOD_TASKS = [
  '- **1.1 Pure module.** Owns `lib/a.js`, `lib/a.test.ts`. Adds a function. Test: a table of cases.',
  '- **1.T Tail.** Owns `tests/tail.test.ts`. Test: everything together.',
].join('\n');

function spec(opts: { omit?: string; sections?: Record<string, string>; tasks?: string } = {}) {
  const sections = { ...SECTIONS, ...(opts.sections ?? {}) };
  const parts = ['# A spec', '', 'Intro text.', ''];
  for (const [name, body] of Object.entries(sections)) {
    if (name === opts.omit) continue;
    const title = name === 'Human checklist' ? 'Human checklist (the front-loaded one)' : name;
    parts.push(`## ${title}`, '', body, '');
  }
  parts.push('## Wave 1: things', '', opts.tasks ?? GOOD_TASKS, '');
  return parts.join('\n');
}

describe('spec-lint on a valid spec', () => {
  it('passes this very spec', () => {
    const r = lint(null);
    expect(r.code, r.out).toBe(0);
  });

  it('passes the minimal valid fixture', () => {
    const r = lint(spec());
    expect(r.code, r.out).toBe(0);
  });
});

describe('spec-lint sections', () => {
  for (const name of Object.keys(SECTIONS)) {
    it(`fails when the "${name}" section is missing`, () => {
      const r = lint(spec({ omit: name }));
      expect(r.code).toBe(1);
      expect(r.out).toContain(name);
    });
  }

  it('does not count a heading inside a code fence', () => {
    const fenced = spec({ omit: 'Budget' }).replace('## Wave 1', '```\n## Budget\n```\n\n## Wave 1');
    const r = lint(fenced);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Budget');
  });

  it('fails when the Human checklist is empty', () => {
    const r = lint(spec({ sections: { 'Human checklist': '' } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('Human checklist');
  });

  it('fails when the Human checklist is a table with no rows', () => {
    const r = lint(spec({ sections: { 'Human checklist': '| id | before | what | why |\n|---|---|---|---|' } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('Human checklist');
  });

  it('fails when the Human checklist says "none" without a reason', () => {
    const r = lint(spec({ sections: { 'Human checklist': 'None.' } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('Human checklist');
  });

  it('passes when the Human checklist says "none" with a reason', () => {
    const r = lint(spec({ sections: { 'Human checklist': 'None: no keys, vendors or legal text are involved.' } }));
    expect(r.code, r.out).toBe(0);
  });
});

describe('spec-lint tasks', () => {
  it('fails a task with no Owns and names the task id', () => {
    const tasks = '- **2.1 No owner.** Does a thing. Test: a case.';
    const r = lint(spec({ tasks }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('2.1');
    expect(r.out).toMatch(/Owns/);
  });

  it('fails a task with no Test and names the task id', () => {
    const tasks = '- **2.2 No test.** Owns `lib/x.js`. Does a thing.';
    const r = lint(spec({ tasks }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('2.2');
    expect(r.out).toMatch(/Test/);
  });

  it('reports every failing task, not only the first', () => {
    const tasks = ['- **2.1 A.** Test: x.', '- **2.2 B.** Owns `y`.'].join('\n');
    const r = lint(spec({ tasks }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('2.1');
    expect(r.out).toContain('2.2');
  });

  it('reads a task that continues on indented lines', () => {
    const tasks = '- **2.1 Wrapped.** Does a thing.\n  Owns `a.js`.\n  Test: a case.';
    const r = lint(spec({ tasks }));
    expect(r.code, r.out).toBe(0);
  });

  it('ignores bullets that are not task bullets', () => {
    const tasks = `${GOOD_TASKS}\n- a plain bullet\n- **Note.** not a task id`;
    const r = lint(spec({ tasks }));
    expect(r.code, r.out).toBe(0);
  });
});

describe('spec-lint Reads or writes', () => {
  const adds = (extra: string) =>
    `- **3.1 Tool.** Owns \`scripts/tool.js\`. Adds a CLI command that prints a report. ${extra}Test: exit codes.`;

  it('fails a task that adds a command and has no Reads or writes line', () => {
    const r = lint(spec({ tasks: adds('') }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('3.1');
    expect(r.out).toContain('Reads or writes');
  });

  it('fails a task that adds a script and has no Reads or writes line', () => {
    const tasks = '- **3.2 Tool.** Owns `scripts/x.js`. Adds a script the schedule runs. Test: a run.';
    const r = lint(spec({ tasks }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('3.2');
  });

  it('fails a bare "writes" value (not an allowed value)', () => {
    const r = lint(spec({ tasks: adds('Reads or writes: writes. ') }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('3.1');
    expect(r.out).toContain('writes');
  });

  it('fails an unknown value even on a task that does not add a command', () => {
    const tasks = '- **3.3 Lib.** Owns `lib/a.js`. Reads or writes: maybe. Test: a case.';
    const r = lint(spec({ tasks }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('3.3');
  });

  for (const value of ['reads', 'writes-files']) {
    it(`passes "${value}" and does not list it for human review`, () => {
      const r = lint(spec({ tasks: adds(`Reads or writes: ${value}. `) }));
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toMatch(/needs human review/i);
    });
  }

  for (const value of ['writes-db', 'paid-call', 'sends']) {
    it(`passes "${value}" and lists the task as needs human review`, () => {
      const r = lint(spec({ tasks: adds(`Reads or writes: ${value}. `) }));
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/needs human review/i);
      expect(r.out).toContain('3.1');
      expect(r.out).toContain(value);
    });
  }

  it('accepts the value in backticks', () => {
    const r = lint(spec({ tasks: adds('Reads or writes: `reads`. ') }));
    expect(r.code, r.out).toBe(0);
  });

  it('does not require the line when "command" is only mentioned in passing', () => {
    const tasks = '- **3.4 Lib.** Owns `lib/a.js`. Takes an injected `exec(command)`. Test: a fake exec.';
    const r = lint(spec({ tasks }));
    expect(r.code, r.out).toBe(0);
  });
});

describe('spec-lint Lane', () => {
  const lane = (extra: string) => `- **4.1 Fast one.** Owns \`lib/a.js\`. ${extra}Test: a case.`;

  for (const value of ['fast', 'normal']) {
    it(`passes "Lane: ${value}"`, () => {
      const r = lint(spec({ tasks: lane(`Lane: ${value}. `) }));
      expect(r.code, r.out).toBe(0);
    });
  }

  it('accepts the value in backticks', () => {
    const r = lint(spec({ tasks: lane('`Lane: fast`. ') }));
    expect(r.code, r.out).toBe(0);
  });

  it('passes a task with no Lane line (default normal)', () => {
    const r = lint(spec({ tasks: lane('') }));
    expect(r.code, r.out).toBe(0);
  });

  for (const value of ['quick', 'slow', 'fast-ish', 'both']) {
    it(`fails "Lane: ${value}" and names the task and the value`, () => {
      const r = lint(spec({ tasks: lane(`Lane: ${value}. `) }));
      expect(r.code).toBe(1);
      expect(r.out).toContain('4.1');
      expect(r.out).toContain('Lane');
      expect(r.out).toContain(value);
    });
  }

  it('does not read a quoted mention or the words "fast lane" as a value', () => {
    const tasks =
      '- **4.2 Prose.** Owns `lib/a.js`. Rejects a `Lane:` value other than fast or normal; the fast lane: skips the critic. Test: a case.';
    const r = lint(spec({ tasks }));
    expect(r.code, r.out).toBe(0);
  });

  it('still passes the v2.1 speed spec', () => {
    let out = '';
    const path = join(root, 'docs', 'agent-loop-v2', '2026-11-01-agent-loop-v2-1-tasks.md');
    const code = main(['node', script, path], { out: (s) => (out += s), err: (s) => (out += s) });
    expect(code, out).toBe(0);
  });
});

describe('spec-lint quoted mentions', () => {
  it('does not read a quoted example list as a value', () => {
    const tasks =
      '- **3.5 Lint.** Owns `scripts/l.js`. Checks a `Reads or writes:` line; `Reads or writes: writes-db|paid-call|sends` is flagged. Test: a case.';
    const r = lint(spec({ tasks }));
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/needs human review/i);
  });

  it('accepts "Test (" as the test marker', () => {
    const tasks = '- **3.6 Flow.** Owns `a.js`. Test (stubbed agent): a case.';
    const r = lint(spec({ tasks }));
    expect(r.code, r.out).toBe(0);
  });

  it('lists nothing for review on this spec', () => {
    const r = lint(null);
    expect(r.out).not.toMatch(/needs human review/i);
  });
});

describe('spec-lint usage', () => {
  it('exits 2 with a usage message when no file is given', () => {
    let out = '';
    expect(main(['node', script], { err: (s) => (out += s) })).toBe(2);
    expect(out).toMatch(/usage/i);
  });

  it('exits 2 when the file cannot be read', () => {
    expect(main(['node', script, join(dir, 'missing.md')], { err: () => {} })).toBe(2);
  });
});

describe('spec-lint real CLI', () => {
  it('exits 0 on this spec and 1 on a broken one, with the message on stderr', () => {
    const ok = spawnSync('node', [script, realSpec], { encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('spec-lint: OK');

    const bad = join(dir, 'bad.md');
    writeFileSync(bad, spec({ omit: 'Budget', tasks: '- **9.9 Bare.** nothing.' }));
    const r = spawnSync('node', [script, bad], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Budget');
    expect(r.stderr).toContain('9.9');
  });

  it('exits 2 with usage when called without a file', () => {
    const r = spawnSync('node', [script], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });
}, 30000);

// Loop perf changes 4 and 5 (3 Nov 2026): shape warnings. They never change the exit code.
describe('spec-lint shape warnings', () => {
  const t = (id: string, rest: string) => `- **${id} Task ${id}.** ${rest} Test: a table of cases.`;
  const wide = [t('1.1', 'Owns `a/1.js`.'), t('1.2', 'Owns `a/2.js`.'), t('1.3', 'Depends on 1.1. Owns `a/3.js`.'), t('1.T', 'Owns `tail.ts`.')].join('\n');

  it('a wide wave with chains at most 2 deep and small tasks gives no warning', () => {
    const r = lint(spec({ tasks: wide }));
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain('warning:');
  });

  it('warns on a dependency chain deeper than 2 (the tail not counted), and still exits 0', () => {
    const deep = [t('1.1', 'Owns `a/1.js`.'), t('1.2', 'Depends on 1.1. Owns `a/2.js`.'), t('1.3', 'Lane: normal. Depends on 1.1 and 1.2. Owns `a/3.js`.'), t('1.T', 'Depends on 1.3. Owns `tail.ts`.')].join('\n');
    const r = lint(spec({ tasks: deep }));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('warning: wave 1: dependency chain 1.1 -> 1.2 -> 1.3 is 3 tasks deep (more than 2)');
    expect(r.out).toMatch(/one PR with stacked commits/);
  });

  it('warns on a wave of 2 or fewer tasks', () => {
    const r = lint(spec({ tasks: GOOD_TASKS }));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('warning: wave 1: 2 tasks; a wave of 2 or fewer goes out as single PRs');
  });

  it('warns on a task owning more than 6 paths, counting only the Owns sentence', () => {
    const owns = (n: number) => Array.from({ length: n }, (_, i) => `\`src/f${i}.ts\``).join(', ');
    const big = [t('1.1', `Owns ${owns(7)}. Reads \`src/other.ts\` and \`src/more.ts\`.`), t('1.2', `Owns ${owns(6)} (and nothing else). Reads \`docs/x.md\`.`), t('1.3', 'Owns `a/3.js`.')].join('\n');
    const r = lint(spec({ tasks: big }));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('warning: task 1.1: owns 7 paths (more than about 6)');
    expect(r.out).not.toContain('task 1.2: owns');
  });

  it('warns on a task adding more than one migration', () => {
    const mig = [t('1.1', 'Owns `migrations/0021_a.sql`, `migrations/0022_b.sql`, `src/a.ts`.'), t('1.2', 'Owns `migrations/0023_c.sql`.'), t('1.3', 'Owns `a/3.js`.')].join('\n');
    const r = lint(spec({ tasks: mig }));
    expect(r.out).toContain('warning: task 1.1: adds 2 migrations (migrations/0021_a.sql, migrations/0022_b.sql)');
    expect(r.out).not.toContain('task 1.2: adds');
  });
});
