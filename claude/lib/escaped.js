// Escaped-defect tracer: which later fix commits on the default branch changed lines that a task PR introduced?
// Pure functions with injected I/O (run); scripts/escaped.js wires real git and gh.
// Not for bundling into a workflow file (it is for the CLI and tests).
// Reads or writes: reads (only `gh pr list`, `gh pr view`, and `git rev-parse`, `git symbolic-ref`, `git log`,
// `git diff`, `git blame`).
//
// The rules (spec "Escaped defect"): a later commit on the default branch, not the merge of a task branch or of a
// `revert/` branch, that changes or deletes a line whose last change before it came from a task PR's commits is
// listed under that task. It counts (kind "fix") when its subject, or the title of the PR it merges, starts with
// `fix`; otherwise it is listed with kind "other" and does not count. One entry per (later commit, task).

/**
 * @typedef {Object} ExecResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} [stderr]
 */

/**
 * @typedef {Object} EscapedFix
 * @property {string} sha     the later commit
 * @property {string} title   the subject, or for a merge of a pull request the PR title
 * @property {'fix'|'other'} kind
 * @property {string[]} files the files (as named at the later commit's parent) holding lines of the task, sorted
 * @property {number} lines   how many changed or deleted lines of the later commit come from the task's PRs
 */

/**
 * @typedef {Object} EscapedTask
 * @property {number} pr       the latest merged PR of the task
 * @property {number[]} prs    every merged PR number of the task, ascending
 * @property {number} escaped  the number of fixes of kind "fix"
 * @property {EscapedFix[]} fixes
 */

/**
 * @typedef {Object} EscapedReport
 * @property {Record<string, EscapedTask>} tasks
 * @property {number} scanned  the later commits whose diffs were blamed
 * @property {string|null} note
 */

export const PR_LIST_ARGS = ['pr', 'list', '--state', 'merged', '--limit', '1000', '--json', 'number,headRefName,mergedAt']
export const PR_LIST_LIMIT = 1000

const SHA = /^[0-9a-f]{40}$/

/**
 * The task id of a head branch `<prefix><id>-<slug>`, where the id is digits, dots and T; null otherwise.
 * @param {string} branch
 * @param {string} prefix
 * @returns {string|null}
 */
export function taskIdOf(branch, prefix) {
  const b = String(branch || '')
  if (!b.startsWith(prefix)) return null
  const m = /^([0-9T.]+)-./.exec(b.slice(prefix.length))
  return m ? m[1] : null
}

/**
 * Whether a commit subject or PR title is a fix: it starts with `fix` (`fix:`, `fix(scope):`, `fix!:`, `Fix ...`,
 * `Fixes ...`, `Fixed ...`), case-insensitive. A word that merely starts with those letters (`fixture`) is not.
 * @param {string} title
 * @returns {boolean}
 */
export function isFixTitle(title) {
  return /^fix(?:es|ed)?(?=[\s:(!]|$)/i.test(String(title || '').trim())
}

/**
 * The changed or deleted line ranges of a `git diff -U0` text, as ranges of the old side: one per hunk that removes
 * at least one line. Pure additions, new files and binary files give none. The path is the old path.
 * @param {string} text
 * @returns {Array<{path: string, start: number, count: number}>}
 */
export function parseDiffRanges(text) {
  /** @type {Array<{path: string, start: number, count: number}>} */
  const out = []
  /** @type {string|null} */
  let path = null
  let inHeader = false
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = null
      inHeader = true
    } else if (inHeader && line.startsWith('--- ')) {
      const p = line.slice(4).replace(/\t$/, '')
      // Quoted paths (special characters) cannot be named safely: skip the file.
      path = p === '/dev/null' || p.startsWith('"') ? null : p.replace(/^a\//, '')
    } else if (line.startsWith('@@')) {
      inHeader = false
      const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line)
      if (!m || path === null) continue
      const count = m[2] === undefined ? 1 : Number(m[2])
      if (count > 0) out.push({ path, start: Number(m[1]), count })
    }
  }
  return out
}

/**
 * The origin commits of `git blame --porcelain` output, with the number of lines each one holds. Every output line
 * has one header line "<sha> <orig> <final> [<count>]"; content lines start with a tab and are skipped.
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function parseBlameOrigins(text) {
  /** @type {Map<string, number>} */
  const out = new Map()
  for (const line of String(text).split('\n')) {
    if (line.startsWith('\t')) continue
    const m = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line)
    if (m) out.set(m[1], (out.get(m[1]) || 0) + 1)
  }
  return out
}

/**
 * The pull request a first-parent commit merges: from "Merge pull request #n from owner/branch" or a squash
 * subject ending in "(#n)".
 * @param {string} subject
 * @returns {{number: number, branch: string|null}|null}
 */
function pullRequestOf(subject) {
  const merge = /^Merge pull request #(\d+) from (\S+)/.exec(subject)
  if (merge) return { number: Number(merge[1]), branch: merge[2] }
  const squash = /\(#(\d+)\)\s*$/.exec(subject)
  if (squash) return { number: Number(squash[1]), branch: null }
  return null
}

/**
 * Trace escaped defects.
 *
 * `run(file, args)` runs a command in the repo and resolves `{ code, stdout, stderr }`; it must not throw for a
 * non-zero exit. Throws an Error when gh or git fails in a way that makes the report meaningless.
 *
 * @param {{since?: string|null, prefix?: string}} input  `since` is YYYY-MM-DD
 * @param {{run: (file: string, args: string[]) => Promise<ExecResult>}} io
 * @returns {Promise<EscapedReport>}
 */
export async function escapedReport(input, io) {
  const prefix = input.prefix || 'task/'
  const since = input.since || null
  const run = io.run
  /** @type {string[]} */
  const notes = []

  /** @param {string[]} args @param {string} what */
  const git = async (args, what) => {
    const r = await run('git', ['--literal-pathspecs', ...args])
    if (r.code !== 0) throw new Error(`git ${what} failed (exit ${r.code}): ${String(r.stderr || '').trim().slice(0, 300)}`)
    return r.stdout
  }
  /** @param {string[]} args */
  const gitQuiet = (args) => run('git', args)

  // 1. The merged PRs.
  const listed = await run('gh', PR_LIST_ARGS)
  if (listed.code !== 0) throw new Error(`gh pr list failed (exit ${listed.code}): ${String(listed.stderr || '').trim().slice(0, 300)}`)
  /** @type {Array<{number: number, headRefName: string, mergedAt: string}>} */
  let all
  try {
    all = JSON.parse(listed.stdout)
    if (!Array.isArray(all)) throw new Error('not an array')
  } catch {
    throw new Error('gh pr list printed no JSON array')
  }
  if (all.length >= PR_LIST_LIMIT) {
    notes.push(`gh returned ${all.length} merged PRs (the --limit 1000 cap): older task PRs may be missing`)
  }
  /** @type {Map<number, string>} */
  const headOf = new Map()
  for (const p of all) headOf.set(Number(p.number), String(p.headRefName || ''))
  const sinceMs = since === null ? null : Date.parse(`${since}T00:00:00Z`)
  /** @type {Map<string, Array<{number: number, mergedAt: string}>>} */
  const byTask = new Map()
  for (const p of all) {
    const id = taskIdOf(String(p.headRefName || ''), prefix)
    if (id === null) continue
    if (sinceMs !== null && !(Date.parse(String(p.mergedAt)) >= sinceMs)) continue
    const list = byTask.get(id) || []
    list.push({ number: Number(p.number), mergedAt: String(p.mergedAt) })
    byTask.set(id, list)
  }
  /** @type {EscapedReport} */
  const report = { tasks: {}, scanned: 0, note: null }
  if (byTask.size === 0) {
    report.note = notes.length ? notes.join('; ') : null
    return report
  }

  // 2. The default branch and its first-parent history, oldest first.
  let ref = null
  const originHead = await gitQuiet(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead.code === 0 && originHead.stdout.trim() !== '') ref = originHead.stdout.trim()
  if (ref === null) {
    for (const c of ['origin/main', 'origin/master', 'main', 'master']) {
      if ((await gitQuiet(['rev-parse', '--verify', '--quiet', `${c}^{commit}`])).code === 0) {
        ref = c
        break
      }
    }
  }
  if (ref === null) ref = 'HEAD'
  const log = await git(['log', '--first-parent', '--reverse', '--format=%H%x1f%P%x1f%s%x1f%b%x1e', ref], `log ${ref}`)
  const commits = log
    .split('\x1e')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.trim() !== '')
    .map((rec) => {
      const [sha, parents, subject, body] = rec.split('\x1f')
      return { sha, parents: parents.split(' ').filter(Boolean), subject: subject || '', body: body || '' }
    })
  /** @type {Map<number, number>} */
  const mergeIndex = new Map()
  /** @type {boolean[]} */
  const skip = []
  commits.forEach((c, i) => {
    const pr = pullRequestOf(c.subject)
    let excluded = false
    if (pr) {
      if (!mergeIndex.has(pr.number)) mergeIndex.set(pr.number, i)
      let head = headOf.get(pr.number)
      if (head === undefined && pr.branch) head = pr.branch.slice(pr.branch.indexOf('/') + 1)
      excluded = !!head && (head.startsWith(prefix) || head.startsWith('revert/'))
    }
    skip[i] = excluded
  })

  // 3. Origins: the commits of each task PR, and the commit that merged it.
  /** @type {Map<string, {task: string, index: number}>} */
  const origins = new Map()
  let firstIndex = Infinity
  /** @type {Array<{id: string, pr: number, prs: number[]}>} */
  const tasks = []
  const ids = [...byTask.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  for (const id of ids) {
    const prs = (byTask.get(id) || []).sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.number - b.number)
    tasks.push({ id, pr: prs[prs.length - 1].number, prs: prs.map((p) => p.number).sort((a, b) => a - b) })
    for (const p of prs) {
      const index = mergeIndex.get(p.number)
      if (index === undefined) {
        notes.push(`task ${id}: no commit for PR #${p.number} on the first-parent history of ${ref}`)
        continue
      }
      firstIndex = Math.min(firstIndex, index)
      origins.set(commits[index].sha, { task: id, index })
      const view = await run('gh', ['pr', 'view', String(p.number), '--json', 'commits'])
      if (view.code !== 0) throw new Error(`gh pr view ${p.number} failed (exit ${view.code}): ${String(view.stderr || '').trim().slice(0, 300)}`)
      let info
      try {
        info = JSON.parse(view.stdout)
      } catch {
        throw new Error(`gh pr view ${p.number} printed no JSON`)
      }
      for (const c of (info && info.commits) || []) {
        if (c && SHA.test(String(c.oid))) origins.set(String(c.oid), { task: id, index })
      }
    }
  }

  /** @type {Map<string, EscapedFix[]>} */
  const fixesOf = new Map(ids.map((id) => [id, []]))

  // 4. Later commits.
  let failedBlames = 0
  for (let i = firstIndex + 1; i < commits.length; i++) {
    const c = commits[i]
    if (skip[i] || c.parents.length === 0) continue
    report.scanned++
    const parent = `${c.sha}^1`
    const diff = await git(
      ['diff', '-M', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', parent, c.sha],
      `diff ${c.sha}`,
    )
    /** @type {Map<string, {lines: number, files: Set<string>}>} */
    const hit = new Map()
    for (const r of parseDiffRanges(diff)) {
      const blame = await run('git', [
        '--literal-pathspecs',
        'blame',
        '--porcelain',
        parent,
        '-L',
        `${r.start},${r.start + r.count - 1}`,
        '--',
        r.path,
      ])
      if (blame.code !== 0) {
        failedBlames++
        continue
      }
      for (const [origin, n] of parseBlameOrigins(blame.stdout)) {
        const o = origins.get(origin)
        if (!o || o.index >= i) continue
        const h = hit.get(o.task) || { lines: 0, files: new Set() }
        h.lines += n
        h.files.add(r.path)
        hit.set(o.task, h)
      }
    }
    if (hit.size === 0) continue
    // GitHub's merge commit keeps the PR title as the first line of the body.
    const prTitle = c.subject.startsWith('Merge pull request') ? (c.body.split('\n').find((l) => l.trim() !== '') || '').trim() : ''
    const title = prTitle || c.subject
    const kind = isFixTitle(title) ? 'fix' : 'other'
    for (const [task, h] of hit) {
      const list = fixesOf.get(task) || []
      list.push({ sha: c.sha, title, kind, files: [...h.files].sort(), lines: h.lines })
      fixesOf.set(task, list)
    }
  }
  if (failedBlames > 0) notes.push(`git blame failed for ${failedBlames} line range(s); they are not counted`)

  for (const t of tasks) {
    const fixes = fixesOf.get(t.id) || []
    report.tasks[t.id] = { pr: t.pr, prs: t.prs, escaped: fixes.filter((f) => f.kind === 'fix').length, fixes }
  }
  report.note = notes.length ? notes.join('; ') : null
  return report
}
