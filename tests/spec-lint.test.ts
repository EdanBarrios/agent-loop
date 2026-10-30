import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 1.4 acceptance: `node scripts/spec-lint.js <spec.md>`. Every case runs the real CLI on a
// spec file, so exit codes and messages are what a human or the loop sees.
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
  const r = spawnSync('node', [script, path], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
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
    const r = spawnSync('node', [script], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });

  it('exits 2 when the file cannot be read', () => {
    const r = spawnSync('node', [script, join(dir, 'missing.md')], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
