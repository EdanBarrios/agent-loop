// Dependency state: is a task's PR merged, and is its merge commit on the default branch?
// Pure functions with injected I/O (depState); scripts/dep-state.js wires real git and gh.
// Not for bundling into a workflow file (it is for the CLI and tests).
// Reads or writes: reads (only `gh pr list`, and `git fetch`, `git symbolic-ref`, `git merge-base`). `git fetch`
// updates remote-tracking refs and nothing else.
//
// The rules (spec 3.1): the task's PR is the merged PR whose head branch starts with `<prefix><id>-`; with several
// (a reopen after a revert) the latest is used, that is the highest number, because the listing carries no merge time
// and a PR that reverts another is always opened after it. A task whose latest PR was reverted by a merged PR with a
// higher number whose head branch is `revert/<id>` or `revert/pr-<the PR's number>` is not merged (reason
// `reverted`). `onDefault` is true when the merge commit is an ancestor of origin/<default branch> after a fetch.

/**
 * @typedef {Object} ExecResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} [stderr]
 */

/**
 * @typedef {Object} PrRow
 * @property {number} number
 * @property {string} headRefName
 * @property {{oid?: string}|string|null} [mergeCommit]
 */

/**
 * @typedef {Object} DepEntry
 * @property {boolean} merged      a merged, not reverted PR of the task exists
 * @property {number|null} pr
 * @property {string|null} mergeSha
 * @property {boolean} onDefault   the merge commit is on the default branch after a fetch
 * @property {string|null} reason  null when merged and onDefault, else why not
 * @property {string} [note]
 */

export const PR_LIST_ARGS = ['pr', 'list', '--state', 'merged', '--limit', '1000', '--json', 'number,headRefName,mergeCommit']
export const PR_LIST_LIMIT = 1000

const SHA = /^[0-9a-f]{40}$/

/**
 * The latest merged PR of a task, or null: among the rows whose head branch starts with `<prefix><id>-`, the one with
 * the highest number.
 * @param {PrRow[]} rows
 * @param {string} id
 * @param {string} prefix
 * @returns {PrRow|null}
 */
export function taskPullRequest(rows, id, prefix) {
  const head = `${prefix}${id}-`
  /** @type {PrRow|null} */
  let best = null
  for (const row of rows) {
    if (typeof row.headRefName !== 'string' || !row.headRefName.startsWith(head)) continue
    if (best === null || row.number > best.number) best = row
  }
  return best
}

/**
 * Whether a merged PR that merged after `pr` reverted it: a row with a higher number whose head branch is
 * `revert/<id>` (the merger's red-on-main step) or `revert/pr-<number of pr>` (the branch merge.js makes).
 * @param {PrRow[]} rows
 * @param {string} id
 * @param {PrRow} pr
 * @returns {boolean}
 */
export function isReverted(rows, id, pr) {
  const names = new Set([`revert/${id}`, `revert/pr-${pr.number}`])
  return rows.some((row) => row.number > pr.number && names.has(row.headRefName))
}

/** @param {PrRow} row @returns {string|null} */
function mergeShaOf(row) {
  const mc = row.mergeCommit
  const oid = mc && typeof mc === 'object' ? mc.oid : mc
  return typeof oid === 'string' && SHA.test(oid) ? oid : null
}

/**
 * @param {string} stdout
 * @returns {PrRow[]|null} the rows, or null when the text is not a JSON list of PR rows
 */
function parseRows(stdout) {
  try {
    const rows = JSON.parse(stdout)
    if (!Array.isArray(rows)) return null
    for (const r of rows) {
      if (!r || typeof r !== 'object' || !Number.isInteger(r.number) || typeof r.headRefName !== 'string') return null
    }
    return rows
  } catch {
    return null
  }
}

/** @returns {DepEntry} */
function unmerged(reason, note) {
  /** @type {DepEntry} */
  const entry = { merged: false, pr: null, mergeSha: null, onDefault: false, reason }
  if (note !== undefined) entry.note = note
  return entry
}

/**
 * The state of each task. Never throws for a failed command: the failure is the reason of every task it affects.
 * @param {{tasks: string[], prefix?: string}} input
 * @param {{run: (file: string, args: string[]) => Promise<ExecResult>}} deps run executes in the repository
 * @returns {Promise<{tasks: Record<string, DepEntry>}>}
 */
export async function depState(input, deps) {
  const prefix = input.prefix ?? 'task/'
  const ids = [...new Set(input.tasks)]
  /** @type {Record<string, DepEntry>} */
  const tasks = {}

  /** @type {ExecResult} */
  let listed
  try {
    listed = await deps.run('gh', PR_LIST_ARGS)
  } catch {
    listed = { code: 1, stdout: '' }
  }
  const rows = listed.code === 0 ? parseRows(listed.stdout) : null
  if (rows === null) {
    for (const id of ids) tasks[id] = unmerged('gh failed')
    return { tasks }
  }

  /** @type {Array<{id: string, pr: PrRow, sha: string}>} */
  const toCheck = []
  for (const id of ids) {
    const pr = taskPullRequest(rows, id, prefix)
    if (pr === null) {
      tasks[id] =
        rows.length >= PR_LIST_LIMIT
          ? unmerged(
              'not in the newest 1000 merged PRs',
              `gh returned ${rows.length} merged PRs (its limit here is ${PR_LIST_LIMIT}) and none is a branch of task ${id}; an older merge may exist`,
            )
          : unmerged('no merged PR')
      continue
    }
    if (isReverted(rows, id, pr)) {
      tasks[id] = { merged: false, pr: pr.number, mergeSha: mergeShaOf(pr), onDefault: false, reason: 'reverted' }
      continue
    }
    const sha = mergeShaOf(pr)
    if (sha === null) {
      tasks[id] = { merged: true, pr: pr.number, mergeSha: null, onDefault: false, reason: 'no merge commit' }
      continue
    }
    toCheck.push({ id, pr, sha })
  }
  if (toCheck.length === 0) return { tasks }

  /** @param {string} file @param {string[]} args @returns {Promise<ExecResult>} */
  const safe = async (file, args) => {
    try {
      return await deps.run(file, args)
    } catch {
      return { code: 127, stdout: '' }
    }
  }
  const fetched = await safe('git', ['fetch', 'origin'])
  /** @type {string|null} */
  let ref = null
  if (fetched.code === 0) {
    const head = await safe('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    const name = head.stdout.trim()
    if (head.code === 0 && /^origin\/\S+$/.test(name)) ref = name
  }
  for (const { id, pr, sha } of toCheck) {
    if (fetched.code !== 0) {
      tasks[id] = { merged: true, pr: pr.number, mergeSha: sha, onDefault: false, reason: 'fetch failed' }
      continue
    }
    if (ref === null) {
      tasks[id] = {
        merged: true,
        pr: pr.number,
        mergeSha: sha,
        onDefault: false,
        reason: 'not on default branch',
        note: 'the default branch is unknown: git symbolic-ref refs/remotes/origin/HEAD failed',
      }
      continue
    }
    const anc = await safe('git', ['merge-base', '--is-ancestor', sha, ref])
    const onDefault = anc.code === 0
    tasks[id] = {
      merged: true,
      pr: pr.number,
      mergeSha: sha,
      onDefault,
      reason: onDefault ? null : 'not on default branch',
    }
  }
  return { tasks }
}
