import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const rules = [
  'hookify.block-force-push.local.md',
  'hookify.block-secrets.local.md',
  'hookify.block-commit-on-main.local.md',
];

describe('hookify rules', () => {
  for (const name of rules) {
    const path = join(root, 'claude', name);

    it(`${name} exists`, () => {
      expect(existsSync(path)).toBe(true);
    });

    it(`${name} has an event: line and a pattern line`, () => {
      const text = readFileSync(path, 'utf8');
      expect(text).toMatch(/^event:\s*\S+/m);
      expect(text).toMatch(/^\s*(pattern|regex_pattern):\s*\S+/m);
    });
  }
});

// The secrets rule's pattern, run against samples. Samples are built at run time so this file holds no secret-shaped
// string itself (the rule would block writing it).
describe('block-secrets pattern', () => {
  const text = readFileSync(join(root, 'claude', 'hookify.block-secrets.local.md'), 'utf8');
  const pattern = new RegExp(/^\s*pattern:\s*(.+)$/m.exec(text)![1]);
  const b64 = (n: number) => 'aB3_-xY9'.repeat(Math.ceil(n / 8)).slice(0, n);

  it.each([
    ['an Anthropic key', 'sk-' + 'ant-' + b64(30)],
    ['a GitHub token', 'gh' + 'p_' + 'A1'.repeat(18)],
    ['an AWS access key id', 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'],
    ['a Postgres URL with a password', 'postgres' + 'ql://user:' + 'pw@db.example.com/x'],
    ['a Supabase secret key', 'sb_' + 'secret_' + b64(32)],
    ['a Supabase publishable key', 'sb_' + 'publishable_' + b64(32)],
    ['a JWT', 'ey' + 'J' + b64(30) + '.ey' + 'J' + b64(60) + '.' + b64(43)],
  ])('blocks %s', (_name, sample) => {
    expect(pattern.test(`const x = "${sample}"`)).toBe(true);
  });

  it.each([
    ['an env variable name', 'process.env.SUPABASE_SECRET_KEY'],
    ['a short sb_ identifier', 'sb_' + 'secret_' + 'x'],
    ['a Postgres URL without a password', 'postgres' + 'ql://localhost/x'],
    ['a dotted name that starts with eyJ', 'ey' + 'J' + 'son.parse.it'],
    ['a version string', 'v2.3.0'],
  ])('allows %s', (_name, sample) => {
    expect(pattern.test(sample)).toBe(false);
  });
});
