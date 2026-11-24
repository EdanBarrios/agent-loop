// Merge: merge one approved pull request, verify the default branch, revert once on red.
// Pure logic with injected I/O (run, sleep, now); scripts/merge-pr.js wires real gh, git and a real clock.
// The script exists for speed and determinism only. Whether it runs unattended is the user's own permission
// settings; a refused merge is reported and never retried another way.
// Reads or writes: writes-files (merges a pull request on the remote; on red opens one revert pull request).
// It never pushes to the default branch: every push names `origin` and the PR head branch or the revert branch.

import { waitForCi } from './ci.js'

/**
 * @typedef {Object} RunResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} [stderr]
 */

/**
 * @typedef {Object} MergeProject
 * @property {'always'|'conflict'} [syncPolicy]  default 'always'
 * @property {string} [mainCi]       name of the CI workflow that runs the check on the default branch; empty runs the check here
 * @property {string} [install]      default 'npm ci'
 * @property {string} [check]        default 'npm run check'
 * @property {string[]} [checkMutates] files the check rewrites; restored after a local check
 * @property {string} [worktrees]    parent directory of task worktrees (the revert worktree is made here)
 * @property {number} [maxBuilders]  slot count handed to slot.sh (default 2)
 * @property {string} [trailer]      commit trailer line
 */

/**
 * @typedef {Object} MergeOptions
 * @property {number|string} pr
 * @property {string} repo           the local checkout gh and git run in
 * @property {string} [worktree]     the task worktree; removed after the merge. Without it a sync uses a temporary one.
 * @property {boolean} [dryRun]
 * @property {string} [tempDir]      where a temporary worktree goes (default /tmp)
 * @property {MergeProject} [project]
 * @property {boolean} [deferMain]   after the merge, do not wait for the main CI run (only with project.mainCi): report
 *                                   mainCheck 'deferred' and let the caller run verifyMain outside its merge lock
 * @property {string} [verifyMain]   verify mode: the PR is already merged at this sha; wait for the main CI run (or the
 *                                   local check) on it and revert once on red. Nothing is merged in this mode.
 * @property {number} [mainWaitMs]   verify mode: stop waiting after this long and report outcome 'pending' (exit 5), so a
 *                                   caller with a bounded command time can call again
 */

/**
 * @typedef {Object} MergeDeps
 * @property {(command: string, o: { cwd: string }) => Promise<RunResult>|RunResult} run  one shell command; never throws on a non-zero exit
 * @property {(ms: number) => Promise<void>|void} sleep
 * @property {() => number} [now]    a clock for the elapsed-ms fields and the waits; without it elapsed is 0 and waits count the sleeps
 */

export const MERGE_EXIT = { merged: 0, refused: 2, reverted: 3, error: 4, pending: 5 }
export const SYNC_MESSAGE = 'Sync branch with upstream before merge'
export const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>'
export const UNKNOWN_REREADS = 3
export const UNKNOWN_WAIT_MS = 10000
export const HEAD_POLL_MS = 5000
export const HEAD_POLLS = 6
export const MAIN_POLL_MS = 20000
export const MAIN_APPEAR_MS = 3 * 60 * 1000
export const MAIN_TIMEOUT_MS = 15 * 60 * 1000
export const LOG_LINES = 40

const PR_FIELDS = 'title,state,headRefName,baseRefName,headRefOid,mergeStateStatus,mergeable'
const READ_ONLY = /^(gh pr (view|checks)|gh run (list|view)|git (fetch origin|merge-base|rev-parse|diff --name-only))\b/

export const LOAD_WARN_FACTOR = 4

/**
 * The machine-load warning the preflight dry run reports: a 1-minute load average above `factor` times the core count
 * means other heavy jobs are running, which slowed waves 3 to 4 times (wave 12 of the pilot project). It warns; it never blocks.
 * @param {number} load1 the 1-minute load average @param {number} cores @param {number} [factor]
 * @returns {{ load1: number, cores: number, threshold: number, high: boolean }}
 */
export function machineLoad(load1, cores, factor) {
  const f = typeof factor === 'number' && factor > 0 ? factor : LOAD_WARN_FACTOR
  const c = Number.isInteger(cores) && cores > 0 ? cores : 1
  const l = typeof load1 === 'number' && isFinite(load1) ? Math.round(load1 * 100) / 100 : 0
  const threshold = f * c
  return { load1: l, cores: c, threshold, high: l > threshold }
}

/** A planned early end of the run, with the outcome it reports. */
class Stop extends Error {
  /** @param {'refused'|'error'|'dry-run'} outcome @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(outcome, message, extra) {
    super(message)
    this.outcome = outcome
    this.extra = extra || {}
  }
}

/** Quote a shell word only when it needs it, so recorded calls stay readable. */
export function sh(value) {
  const s = String(value)
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** @param {string} text @param {number} n */
function lastLines(text, n) {
  return String(text || '').trimEnd().split('\n').slice(-n).join('\n')
}

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(String(text || '').trim())
  } catch {
    return null
  }
}

/**
 * Merge one pull request the critic approved, verify the default branch, and revert once if it is red.
 * Assumes the caller holds the merge lock: this is the only merger on the repository.
 *
 * Exit codes: 0 merged and the default branch is green, 2 refused (CI not green, a sync conflict, or GitHub
 * refused the merge), 3 reverted (the default branch was red; one revert PR was merged and it is green again),
 * 4 error (the revert PR was not green, main is still red after the revert, or anything unexpected).
 * A dry run reports outcome 'dry-run' with exit 0 and `wouldRun`, the write calls it did not make.
 *
 * mainCheck says what was done about the default branch after the merge:
 * - 'skipped:unchanged': the merge commit's tree equals the tree of the PR head whose CI was green (main had not moved
 *   past the branch), so CI already checked exactly this tree and the check on main is not waited for.
 * - 'deferred': deferMain was set (and mainCi is set): the caller runs verify mode for this merge outside its lock.
 * - 'green', 'red' (then reverted), 'pending' (verify mode ran out of mainWaitMs), 'unknown' (an error), or null when
 *   nothing was merged.
 * Exit 5 (pending) happens only in verify mode.
 *
 * @param {MergeOptions} opts
 * @param {MergeDeps} deps
 * @returns {Promise<Record<string, any>>} { outcome, exit, mergeSha, mainSha, ciState, failing, conflictFiles, revertPrUrl, message, logTail, ciWaitMs, mergeMs, mainCheckMs, revertMs, elapsedMs }
 */
export async function mergePr(opts, deps) {
  const n = String(opts.pr)
  const repo = opts.repo
  const project = opts.project || {}
  const policy = project.syncPolicy || 'always'
  const mainCi = project.mainCi || ''
  const trailer = project.trailer || DEFAULT_TRAILER
  // project.mergeMethod: 'merge' (default, a merge commit) or 'squash' (one commit per PR, so a branch's intermediate
  // commits never reach the default branch's history). The revert of a squash commit needs no -m 1.
  const method = project.mergeMethod === undefined ? 'merge' : project.mergeMethod
  const dry = Boolean(opts.dryRun)
  const tempDir = opts.tempDir || '/tmp'
  const now = deps.now || (() => 0)
  const sleep = deps.sleep
  const started = now()

  const result = {
    outcome: 'error',
    exit: MERGE_EXIT.error,
    mergeSha: null,
    mainSha: null,
    ciState: null,
    failing: [],
    conflictFiles: [],
    revertPrUrl: null,
    message: '',
    logTail: '',
    ciWaitMs: 0,
    mergeMs: 0,
    mainCheckMs: 0,
    revertMs: 0,
    elapsedMs: 0,
    mainCheck: null,
  }
  /** @type {string[]} */
  const wouldRun = []
  let base = ''
  let head = ''
  let title = ''
  let fetched = false
  let tempWorktree = ''
  let revertWorktree = ''
  if (method !== 'merge' && method !== 'squash') {
    // "cannot read" makes wave-loop's preflight fail the wave before any worker starts.
    result.message = `cannot read config: project.mergeMethod must be "merge" or "squash", not ${JSON.stringify(method)}`
    return result
  }

  /** Run one command; in a dry run a write call is recorded and not made. */
  const run = async (command, cwd = repo) => {
    if (dry && !READ_ONLY.test(command)) {
      wouldRun.push(command)
      return { code: 0, stdout: '', stderr: '' }
    }
    const r = await deps.run(command, { cwd })
    return { code: r.code, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
  }
  /** Run a command that must succeed; a failure stops the run with an error. */
  const must = async (command, cwd, what) => {
    const r = await run(command, cwd)
    if (r.code !== 0) throw new Stop('error', `${what || command} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`)
    return r
  }
  const fetchOnce = async () => {
    if (fetched) return
    await must('git fetch origin', repo, 'git fetch origin')
    fetched = true
  }
  const readPr = async () => {
    const r = await run(`gh pr view ${n} --json ${PR_FIELDS}`)
    const pr = r.code === 0 ? parseJson(r.stdout) : null
    if (!pr || typeof pr !== 'object') throw new Stop('error', `could not read PR #${n}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
    return pr
  }

  try {
    if (opts.verifyMain) return await verifyOnly(String(opts.verifyMain))
    let pr = await readPr()
    if (pr.state !== 'OPEN') throw new Stop('refused', `PR #${n} is ${pr.state}, not OPEN; nothing was merged.`)
    base = pr.baseRefName
    head = pr.headRefName
    title = String(pr.title || '')
    if (!base || !head || base === head) throw new Stop('error', `PR #${n} has head branch "${head}" and base branch "${base}"; refusing to touch it.`)

    // 1. Sync main into the branch only as the policy says.
    let headSha = pr.headRefOid
    let needSync
    if (policy === 'always') {
      await fetchOnce()
      const r = await run(`git merge-base --is-ancestor origin/${base} origin/${head}`)
      if (r.code !== 0 && r.code !== 1) throw new Stop('error', `git merge-base failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`)
      needSync = r.code === 1
    } else if (policy === 'conflict') {
      // BEHIND is never relied on; only a conflict syncs. UNKNOWN is re-read, then treated as a conflict.
      for (let i = 0; i < UNKNOWN_REREADS && pr.mergeable === 'UNKNOWN'; i++) {
        await sleep(UNKNOWN_WAIT_MS)
        pr = await readPr()
      }
      needSync = pr.mergeable === 'CONFLICTING' || pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'DIRTY'
      headSha = pr.headRefOid
    } else {
      throw new Stop('error', `unknown syncPolicy "${policy}"`)
    }
    if (needSync) headSha = await sync(headSha)

    // 2. Wait for CI on the head that will be merged.
    const tCi = now()
    const ci = await waitForCi(Number(n), (command) => run(command), { sleep, now: deps.now })
    result.ciWaitMs += now() - tCi
    result.ciState = ci.state
    result.failing = ci.failing
    result.logTail = ci.logTail
    if (ci.state !== 'green') {
      const names = ci.failing.length ? ` (${ci.failing.join(', ')})` : ''
      throw new Stop('refused', `CI is ${ci.state} on PR #${n}${names}; nothing was merged.`)
    }

    // 3. Merge, pinned to the head that was green.
    const mergeCmd = `gh pr merge ${n} --${method} --delete-branch --match-head-commit ${headSha}`
    if (dry) {
      wouldRun.push(mergeCmd)
      throw new Stop('dry-run', 'Dry run: CI is green; the merge was not made.')
    }
    const mergeSha = await mergeAndRead(n, mergeCmd, 'refused')
    result.mergeSha = mergeSha
    await removeWorktree(opts.worktree, head)

    // 4. Verify the default branch; revert once on red. Skipped when the merged tree is the tree CI checked.
    const tMain = now()
    const pull = await run('git pull --ff-only')
    if (await treeUnchanged(mergeSha, headSha)) {
      result.mainCheck = 'skipped:unchanged'
      result.mainSha = mergeSha
      result.mainCheckMs += now() - tMain
      return finish('merged', `PR #${n} merged; the check on the default branch was skipped: the merge commit's tree is the tree CI checked on the PR head ${headSha}.`)
    }
    if (opts.deferMain && mainCi) {
      result.mainCheck = 'deferred'
      result.mainCheckMs += now() - tMain
      return finish('merged', `PR #${n} merged; the check on the default branch is deferred: run merge-pr.js ${n} --verify-main ${mergeSha}.`)
    }
    const verdict = await verifyMain(mergeSha, pull)
    result.mainCheckMs += now() - tMain
    return await settleMain(mergeSha, verdict)
  } catch (e) {
    if (e instanceof Stop) {
      Object.assign(result, e.extra)
      if (e.outcome === 'dry-run') return finish('dry-run', e.message)
      return finish(e.outcome, e.message)
    }
    return finish('error', `unexpected error: ${e && e.message ? e.message : String(e)}`)
  } finally {
    await cleanupTemp()
  }

  /**
   * True when the merge commit's tree equals the tree of the PR head that was merged. CI on the PR checked that tree
   * (the head itself, or GitHub's merge ref, which has the same tree when main is already in the head), so a check on
   * the default branch would test nothing new. Any failure to read either tree means "not proven": the check runs.
   * @param {string} mergeSha @param {string} headSha
   */
  async function treeUnchanged(mergeSha, headSha) {
    if (!headSha) return false
    const a = await run(`git rev-parse ${mergeSha}^{tree}`)
    const b = await run(`git rev-parse ${headSha}^{tree}`)
    const ta = a.code === 0 ? a.stdout.trim() : ''
    const tb = b.code === 0 ? b.stdout.trim() : ''
    return /^[0-9a-f]{40,64}$/.test(ta) && ta === tb
  }

  /** The verdict on the default branch after a merge: green finishes, red reverts once, anything else is an error. */
  async function settleMain(mergeSha, verdict) {
    if (verdict.state === 'pending') {
      result.mainCheck = 'pending'
      return finish('pending', `PR #${n} is merged (${mergeSha}); its run on the default branch has not finished yet: call --verify-main again.`)
    }
    if (verdict.state === 'unknown') {
      result.mainCheck = 'unknown'
      throw new Stop('error', `PR #${n} is merged (${mergeSha}) but the default branch could not be verified: ${verdict.message}`)
    }
    if (verdict.state === 'green') {
      result.mainCheck = 'green'
      result.mainSha = verdict.sha
      return finish('merged', `PR #${n} merged; the default branch is green.`)
    }
    result.mainCheck = 'red'
    result.logTail = verdict.tail
    const tRevert = now()
    try {
      await revert(mergeSha, verdict.tail)
    } finally {
      result.revertMs += now() - tRevert
    }
    return finish('reverted', `The default branch was red after PR #${n}; it was reverted through ${result.revertPrUrl} and is green again.`)
  }

  /** Verify mode: the PR is merged at `sha` already (a deferred main check); verify the default branch, revert once on red. */
  async function verifyOnly(sha) {
    if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Stop('error', `--verify-main needs a commit sha, got "${sha}"`)
    const pr = await readPr()
    if (pr.state !== 'MERGED') throw new Stop('error', `PR #${n} is ${pr.state}, not MERGED; --verify-main checks a merge that was made.`)
    base = pr.baseRefName
    head = pr.headRefName
    title = String(pr.title || '')
    if (!base) throw new Stop('error', `PR #${n} has no base branch.`)
    result.mergeSha = sha
    result.ciState = 'green'
    const tMain = now()
    const pull = await run('git pull --ff-only')
    const verdict = await verifyMain(sha, pull, opts.mainWaitMs)
    result.mainCheckMs += now() - tMain
    return settleMain(sha, verdict)
  }

  /** Merge main into the branch in the worktree, push the head branch, wait for GitHub to show the new head. */
  async function sync(oldHead) {
    await fetchOnce()
    let wt = opts.worktree
    if (wt) {
      const cur = await must('git rev-parse --abbrev-ref HEAD', wt, 'git rev-parse')
      if (cur.stdout.trim() !== head) throw new Stop('error', `worktree ${wt} is on "${cur.stdout.trim()}", not on the PR head branch "${head}".`)
      await must(`git merge --ff-only origin/${head}`, wt, 'bringing the worktree up to the pushed head')
    } else {
      wt = `${tempDir}/merge-pr-${n}-sync`
      await must(`git worktree add --detach ${sh(wt)} origin/${head}`, repo, 'making a temporary worktree')
      tempWorktree = wt
    }
    const m = await run(`git merge --no-edit -m ${sh(SYNC_MESSAGE)} -m ${sh(trailer)} origin/${base}`, wt)
    if (m.code !== 0) {
      const u = await run('git diff --name-only --diff-filter=U', wt)
      const files = u.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      await run('git merge --abort', wt)
      if (files.length) {
        throw new Stop('refused', `Syncing the default branch into ${head} conflicts in ${files.join(', ')}; nothing was pushed.`, { conflictFiles: files })
      }
      throw new Stop('error', `git merge failed (exit ${m.code}): ${(m.stderr || m.stdout).trim().slice(0, 400)}`)
    }
    if (dry) {
      wouldRun.push(`git push origin HEAD:${head}`)
      throw new Stop('dry-run', 'Dry run: the default branch would be merged into the branch first; the sync was not made.')
    }
    const sha = (await must('git rev-parse HEAD', wt, 'git rev-parse')).stdout.trim()
    if (sha === oldHead) return oldHead
    await must(`git push origin HEAD:${head}`, wt, 'pushing the synced branch')
    for (let i = 0; i < HEAD_POLLS; i++) {
      const seen = await readPr()
      if (seen.headRefOid === sha) return sha
      await sleep(HEAD_POLL_MS)
    }
    throw new Stop('error', `GitHub did not show the pushed head ${sha} on PR #${n}; nothing was merged.`)
  }

  /**
   * Run a `gh pr merge` command and return the merge commit sha. gh can exit non-zero only because the local
   * branch is checked out in a worktree: the PR state decides. One attempt, never another way.
   * @param {string} prNumber @param {string} command @param {'refused'|'error'} failure
   */
  async function mergeAndRead(prNumber, command, failure) {
    const m = await run(command)
    const v = await run(`gh pr view ${prNumber} --json state,mergeCommit`)
    const view = v.code === 0 ? parseJson(v.stdout) : null
    if (m.code !== 0 && !(view && view.state === 'MERGED')) {
      throw new Stop(failure, `gh pr merge ${prNumber} was refused: ${(m.stderr || m.stdout).trim().slice(0, 500) || `exit ${m.code}`}`)
    }
    const sha = view && view.mergeCommit && view.mergeCommit.oid
    if (!sha) throw new Stop('error', `PR #${prNumber} was merged but its merge commit could not be read.`)
    return sha
  }

  /** Remove the task worktree and its local branch (ignore errors; never forced, so unsaved work stays). */
  async function removeWorktree(wt, branch) {
    if (!wt) return
    await run(`git worktree remove ${sh(wt)}`)
    await run('git worktree prune')
    await run(`git branch -D ${sh(branch)}`)
  }

  async function cleanupTemp() {
    if (dry) return
    for (const wt of [tempWorktree, revertWorktree]) {
      if (wt) await deps.run(`git worktree remove ${sh(wt)}`, { cwd: repo })
    }
  }

  /**
   * The default branch after a merge: the main CI run on that commit, or the local check.
   * @param {string} sha @param {RunResult} [pulled] the result of a `git pull --ff-only` already made @param {number} [budgetMs]
   */
  async function verifyMain(sha, pulled, budgetMs) {
    const pull = pulled || (await run('git pull --ff-only'))
    if (pull.code !== 0 && !mainCi) throw new Stop('error', `git pull --ff-only failed on the default branch: ${String(pull.stderr || '').trim().slice(0, 300)}`)
    if (mainCi) return waitMainRun(sha, budgetMs)
    return localCheck()
  }

  /** @param {string} sha @param {number} [budgetMs] past this, a run that has appeared but not finished is 'pending' */
  async function waitMainRun(sha, budgetMs) {
    const command = `gh run list --branch ${sh(base)} --workflow ${sh(mainCi)} --commit ${sha} --json databaseId,status,conclusion`
    const t0 = now()
    let slept = 0
    const elapsed = () => (deps.now ? now() - t0 : slept)
    for (;;) {
      const r = await run(command)
      const runs = r.code === 0 ? parseJson(r.stdout) : null
      const latest = Array.isArray(runs) && runs.length ? runs[0] : null
      if (latest && latest.status === 'completed') {
        if (latest.conclusion === 'success') return { state: 'green', sha, tail: '', message: '' }
        if (latest.conclusion === 'failure') {
          const log = await run(`gh run view ${latest.databaseId} --log-failed`)
          return { state: 'red', sha, tail: lastLines(log.stdout || log.stderr, LOG_LINES), message: '' }
        }
        // Cancelled, timed out and the like say nothing about the code: never revert on them.
        return { state: 'unknown', sha, tail: '', message: `the "${mainCi}" run ${latest.databaseId} ended ${latest.conclusion || 'without a result'}` }
      }
      if (latest && budgetMs && elapsed() >= budgetMs && elapsed() < MAIN_TIMEOUT_MS) return { state: 'pending', sha, tail: '', message: '' }
      if (elapsed() >= (latest ? MAIN_TIMEOUT_MS : MAIN_APPEAR_MS)) {
        return { state: 'unknown', sha, tail: '', message: latest ? `the "${mainCi}" run on ${sha} did not finish in time` : `no "${mainCi}" run appeared for ${sha}` }
      }
      await sleep(MAIN_POLL_MS)
      slept += MAIN_POLL_MS
    }
  }

  async function localCheck() {
    const slot = `SLOT_MAX=${project.maxBuilders || 2} ${sh(`${repo}/.claude/slot.sh`)} sh -c ${sh(`${project.install || 'npm ci'} && ${project.check || 'npm run check'}`)}`
    const r = await run(slot)
    const mutates = project.checkMutates || []
    if (mutates.length) await run(`git checkout -- ${mutates.map(sh).join(' ')}`)
    const sha = (await run('git rev-parse HEAD')).stdout.trim()
    if (r.code === 0) return { state: 'green', sha, tail: '', message: '' }
    return { state: 'red', sha, tail: lastLines(`${r.stdout}\n${r.stderr}`, LOG_LINES), message: '' }
  }

  /** Open one revert PR, merge it only when its CI is green, and check the default branch again. No second revert. */
  async function revert(mergeSha, tail) {
    const branch = `revert/pr-${n}`
    const wt = `${project.worktrees || tempDir}/revert-pr-${n}`
    await must('git fetch origin', repo, 'git fetch origin')
    await must(`git worktree add ${sh(wt)} -b ${branch} origin/${base}`, repo, 'making the revert worktree')
    revertWorktree = wt
    const rv = await run(`git revert ${method === 'merge' ? '-m 1 ' : ''}--no-commit ${mergeSha}`, wt)
    if (rv.code !== 0) {
      await run('git revert --abort', wt)
      throw new Stop('error', `The revert of ${mergeSha} does not apply cleanly (${(rv.stderr || rv.stdout).trim().slice(0, 300)}); no revert PR was opened and the default branch is red.`)
    }
    await must(`git commit -m ${sh(`Revert PR #${n}: check red after the merge`)} -m ${sh(trailer)}`, wt, 'committing the revert')
    const revertHead = (await must('git rev-parse HEAD', wt, 'git rev-parse')).stdout.trim()
    await must(`git push origin ${branch}`, wt, 'pushing the revert branch')
    const body = `The check failed on the default branch after PR #${n} was merged (merge commit ${mergeSha}). This PR reverts that merge once. It is merged only when its own CI is green; there is no second revert.\n\nFailing output:\n\n\`\`\`\n${tail}\n\`\`\`\n`
    const create = await must(
      `gh pr create --base ${sh(base)} --head ${branch} --title ${sh(`Revert PR #${n}: ${title || 'merged PR'} (check red on the default branch)`)} --body ${sh(body)}`,
      repo,
      'opening the revert PR',
    )
    const url = create.stdout.trim().split('\n').pop().trim()
    const num = (url.match(/\/pull\/(\d+)/) || [])[1]
    result.revertPrUrl = url
    if (!num) throw new Stop('error', `Could not read the revert PR number from "${url}".`)

    const ci = await waitForCi(Number(num), (command) => run(command), { sleep, now: deps.now })
    if (ci.state !== 'green') {
      throw new Stop('error', `The revert PR ${url} is ${ci.state}${ci.failing.length ? ` (${ci.failing.join(', ')})` : ''}; it was not merged and no second revert will be made. The default branch is red.`)
    }
    const revertMerge = await mergeAndRead(num, `gh pr merge ${num} --${method} --delete-branch --match-head-commit ${revertHead}`, 'error')
    await run(`git worktree remove ${sh(wt)}`)
    await run('git worktree prune')
    await run(`git branch -D ${branch}`)
    revertWorktree = ''
    const again = await verifyMain(revertMerge)
    result.mainSha = again.sha
    if (again.state !== 'green') {
      throw new Stop('error', `The default branch is still ${again.state === 'red' ? 'red' : 'unverified'} after the revert merged through ${url}; no second revert will be made. ${again.message}`.trim())
    }
  }

  /** @param {string} outcome @param {string} message */
  function finish(outcome, message) {
    result.outcome = outcome
    result.exit = outcome === 'dry-run' ? 0 : MERGE_EXIT[outcome]
    if (outcome === 'error' && result.mergeSha && !result.mainCheck) result.mainCheck = 'unknown'
    result.message = message
    result.elapsedMs = now() - started
    result.mergeMs = Math.max(0, result.elapsedMs - result.ciWaitMs - result.mainCheckMs - result.revertMs)
    if (dry) result.wouldRun = wouldRun
    return result
  }
}
