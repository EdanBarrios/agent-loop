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
    const path = join(root, '.claude', name);

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
