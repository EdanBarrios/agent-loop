import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'claude/lib/**/*.test.ts'],
    // Many tests spawn node, python or shell processes. One fork per test file (25 files) on an 8 GB Mac
    // under memory pressure timed them out. Two forks, like the loop's two check slots, run the suite in the
    // same wall time (about 3.5 min, dominated by the spawning tests).
    maxWorkers: 2,
  },
});
