// Test-edit report: which assertions did a branch remove or change after its test-first commit?
// Pure functions with injected I/O (run); scripts/test-edits.js wires real git and gh.
// Also home of the project-wide test-file matcher (isTestFile, testGlobsOf) and the assertion-line matcher
// (isAssertionLine) that other tasks reuse. It imports node:path, so it is for CLIs and tests, not for bundling
// into a workflow file (scripts/bundle-workflows.js copies only import-free libs).
// Reads or writes: reads (only `gh pr view`, `git rev-list`, `git diff`, `git diff-tree`, `git merge-base`,
// `git cat-file` and one `git fetch origin pull/<n>/head` when the head commit is missing).
import { matchesGlob } from 'node:path'

/**
 * @typedef {Object} ExecResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} [stderr]
 */

/**
 * @typedef {Object} Hunk
 * @property {string[]} removed  removed lines, without the diff's leading "-"
 * @property {string[]} added    added lines, without the diff's leading "+"
 */

/**
 * @typedef {Object} FileEdits
 * @property {string} path
 * @property {string[]} removed
 * @property {Array<{before: string, after: string}>} changed
 */

/**
 * @typedef {Object} TestEditReport
 * @property {string|null} testFirstCommit
 * @property {FileEdits[]} files
 * @property {number} assertionsRemoved
 * @property {number} assertionsChanged
 * @property {boolean} bodySection
 * @property {string|null} note
 */

export const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**']

const ASSERTION =
  /\b(expect|assert)\s*[.(]|\.(to(Be|Equal|StrictEqual|Match|Contain|Have|Throw|Satisfy)\w*|should)\b|\bt\.(is|deepEqual|true|false|throws)\b/

/**
 * The project's test globs: its `testGlobs` field when that is a non-empty array of strings, else the default.
 * @param {{testGlobs?: unknown}|null|undefined} project  the parsed .claude/loop.local.json
 * @returns {string[]}
 */
export function testGlobsOf(project) {
  const g = project && project.testGlobs
  if (Array.isArray(g) && g.length > 0 && g.every((x) => typeof x === 'string' && x !== '')) return [...g]
  return [...DEFAULT_TEST_GLOBS]
}

/**
 * Whether a repo-relative POSIX path is a test file under the globs (node:path matchesGlob; `**` also matches
 * zero directories).
 * @param {string} path
 * @param {string[]} [globs]
 * @returns {boolean}
 */
export function isTestFile(path, globs = DEFAULT_TEST_GLOBS) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '')
  return globs.some((g) => {
    try {
      return matchesGlob(p, g)
    } catch {
      return false
    }
  })
}

/**
 * Whether a source line is an assertion line: not a comment, and it calls expect/assert or a matcher.
 * @param {string} line
 * @returns {boolean}
 */
export function isAssertionLine(line) {
  const t = String(line).trim()
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return false
  return ASSERTION.test(t)
}

/**
 * Parse the hunks of a `git diff -U0` text. Header lines before the first "@@" of each file are skipped.
 * @param {string} text
 * @returns {Hunk[]}
 */
export function parseHunks(text) {
  /** @type {Hunk[]} */
  const hunks = []
  /** @type {Hunk|null} */
  let cur = null
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = null
    } else if (line.startsWith('@@')) {
      cur = { removed: [], added: [] }
      hunks.push(cur)
    } else if (cur && line.startsWith('-')) {
      cur.removed.push(line.slice(1))
    } else if (cur && line.startsWith('+')) {
      cur.added.push(line.slice(1))
    }
  }
  return hunks
}

/**
 * Remove from `hunks` every removed or added line that also appears, one for one, as a removed or added line in
 * `taken` (the hunks of a merge from the base branch). Hunks that end up empty are dropped.
 * @param {Hunk[]} hunks
 * @param {Hunk[]} taken
 * @returns {Hunk[]}
 */
export function dropTakenLines(hunks, taken) {
  /** @type {Map<string, number>} */
  const removedPool = new Map()
  /** @type {Map<string, number>} */
  const addedPool = new Map()
  for (const h of taken) {
    for (const l of h.removed) removedPool.set(l, (removedPool.get(l) || 0) + 1)
    for (const l of h.added) addedPool.set(l, (addedPool.get(l) || 0) + 1)
  }
  /** @param {string[]} lines @param {Map<string, number>} pool */
  const keep = (lines, pool) =>
    lines.filter((l) => {
      const n = pool.get(l) || 0
      if (n > 0) {
        pool.set(l, n - 1)
        return false
      }
      return true
    })
  return hunks
    .map((h) => ({ removed: keep(h.removed, removedPool), added: keep(h.added, addedPool) }))
    .filter((h) => h.removed.length > 0 || h.added.length > 0)
}

/**
 * Classify the removed assertion lines of each hunk. Within a hunk the i-th removed assertion line pairs with the
 * i-th added line. The pair is "changed" when the added line is itself an assertion line that differs after
 * trimming (a re-indented line is no edit); otherwise the removed line is "removed". A removed assertion line with
 * no i-th added line is "removed". Lines come back trimmed.
 * @param {Hunk[]} hunks
 * @returns {{removed: string[], changed: Array<{before: string, after: string}>}}
 */
export function classifyHunks(hunks) {
  /** @type {string[]} */
  const removed = []
  /** @type {Array<{before: string, after: string}>} */
  const changed = []
  for (const h of hunks) {
    const gone = h.removed.filter(isAssertionLine)
    gone.forEach((line, i) => {
      const before = line.trim()
      const next = h.added[i]
      if (next === undefined || !isAssertionLine(next)) removed.push(before)
      else if (next.trim() !== before) changed.push({ before, after: next.trim() })
    })
  }
  return { removed, changed }
}

/**
 * @param {string} text  NUL-separated output of `git diff --name-status -z`
 * @returns {Array<{status: string, oldPath: string, newPath: string}>}
 */
function parseNameStatus(text) {
  const t = String(text).split('\0')
  /** @type {Array<{status: string, oldPath: string, newPath: string}>} */
  const out = []
  let i = 0
  while (i < t.length && t[i] !== '') {
    const status = t[i]
    if (status[0] === 'R' || status[0] === 'C') {
      out.push({ status: status[0], oldPath: t[i + 1], newPath: t[i + 2] })
      i += 3
    } else {
      out.push({ status: status[0], oldPath: t[i + 1], newPath: t[i + 1] })
      i += 2
    }
  }
  return out
}

/**
 * Build the test-edit report of a pull request.
 *
 * `run(file, args)` runs a command in the repo and resolves `{ code, stdout, stderr }`; it must not throw for a
 * non-zero exit. Throws an Error when gh or git fails in a way that makes the report meaningless.
 *
 * @param {{pr: number|string, base?: string|null, globs?: string[]}} input
 * @param {{run: (file: string, args: string[]) => Promise<ExecResult>}} io
 * @returns {Promise<TestEditReport>}
 */
export async function testEditReport(input, io) {
  const { pr } = input
  const globs = input.globs || DEFAULT_TEST_GLOBS
  const run = io.run
  /** @param {string[]} args */
  const git = (args) => run('git', ['--literal-pathspecs', ...args])
  /**
   * @param {string[]} args
   * @param {string} what
   */
  const gitOrThrow = async (args, what) => {
    const r = await git(args)
    if (r.code !== 0) throw new Error(`git ${what} failed (exit ${r.code}): ${String(r.stderr || '').trim().slice(0, 300)}`)
    return r.stdout
  }

  const view = await run('gh', ['pr', 'view', String(pr), '--json', 'commits,body,baseRefName,headRefOid'])
  if (view.code !== 0) throw new Error(`gh pr view ${pr} failed (exit ${view.code}): ${String(view.stderr || '').trim().slice(0, 300)}`)
  let info
  try {
    info = JSON.parse(view.stdout)
  } catch {
    throw new Error(`gh pr view ${pr} printed no JSON`)
  }
  const head = String(info.headRefOid || '')
  const base = input.base || info.baseRefName
  if (!head) throw new Error(`gh pr view ${pr} gave no headRefOid`)
  if (!base) throw new Error(`gh pr view ${pr} gave no baseRefName; pass --base`)

  const bodySection = /^Test edits:/m.test(String(info.body || '').replace(/\r/g, ''))
  /** @returns {TestEditReport} */
  const empty = (/** @type {string|null} */ note) => ({
    testFirstCommit: null,
    files: [],
    assertionsRemoved: 0,
    assertionsChanged: 0,
    bodySection,
    note,
  })

  if ((await git(['cat-file', '-e', `${head}^{commit}`])).code !== 0) {
    await gitOrThrow(['fetch', 'origin', `pull/${pr}/head`], `fetch origin pull/${pr}/head`)
    await gitOrThrow(['cat-file', '-e', `${head}^{commit}`], `cat-file ${head}`)
  }

  const listing = await gitOrThrow(['rev-list', '--reverse', '--parents', `origin/${base}..${head}`], `rev-list origin/${base}..${head}`)
  const commits = listing
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [sha, ...parents] = l.trim().split(/\s+/)
      return { sha, parents }
    })

  let testFirstCommit = null
  for (const c of commits) {
    if (c.parents.length > 1) continue
    const names = await gitOrThrow(
      ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only', '--diff-filter=ACMRT', '-M', '-z', c.sha],
      `diff-tree ${c.sha}`,
    )
    if (names.split('\0').some((n) => n !== '' && isTestFile(n, globs))) {
      testFirstCommit = c.sha
      break
    }
  }
  if (testFirstCommit === null) return empty('no commit on the branch adds or changes a test file')

  // Merges from the base branch whose lines are subtracted: those not already part of the test-first commit.
  const merges = []
  for (const c of commits) {
    if (c.parents.length < 2) continue
    const anc = await git(['merge-base', '--is-ancestor', c.sha, testFirstCommit])
    if (anc.code !== 0) merges.push(c)
  }

  const names = await gitOrThrow(['diff', '-M', '--name-status', '-z', testFirstCommit, head], 'diff --name-status')
  /** @type {FileEdits[]} */
  const files = []
  for (const e of parseNameStatus(names)) {
    if (e.status === 'A' || !isTestFile(e.oldPath, globs)) continue
    const paths = e.newPath === e.oldPath ? [e.oldPath] : [e.oldPath, e.newPath]
    const diffArgs = ['diff', '-M', '-U0', '--no-color', '--no-ext-diff']
    let hunks = parseHunks(await gitOrThrow([...diffArgs, testFirstCommit, head, '--', ...paths], `diff ${e.newPath}`))
    if (hunks.length === 0) continue
    for (const m of merges) {
      const taken = parseHunks(await gitOrThrow([...diffArgs, m.parents[0], m.sha, '--', ...paths], `diff ${m.sha} ${e.newPath}`))
      hunks = dropTakenLines(hunks, taken)
    }
    const { removed, changed } = classifyHunks(hunks)
    if (removed.length > 0 || changed.length > 0) files.push({ path: e.newPath, removed, changed })
  }

  return {
    testFirstCommit,
    files,
    assertionsRemoved: files.reduce((n, f) => n + f.removed.length, 0),
    assertionsChanged: files.reduce((n, f) => n + f.changed.length, 0),
    bodySection,
    note: null,
  }
}
