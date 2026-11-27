// Merge: merge one approved pull request, verify the default branch, revert once on red.
// Pure logic with injected I/O (run, sleep, now); scripts/merge-pr.js wires real gh, git and a real clock.
// The script exists for speed and determinism only. Whether it runs unattended is the user's own permission
// settings; a refused merge is reported and never retried another way.
// Reads or writes: writes-files (merges a pull request on the remote; on red opens one revert pull request; the merge lock).
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
 * @property {boolean} [reuseTreeCi] default false: skip the check on the default branch when the merged tree is the tree CI checked,
 *                                   but only if the main CI workflow file shows no event-dependent behaviour (scanWorkflow)
 * @property {number} [mergeLockStaleMin] default 30: age past which a lock whose holder cannot be shown dead is taken over
 * @property {number} [mergeLockWaitMin]  default 5, at most 8: how long a held lock is waited for before the outcome is 'locked'
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
 * @typedef {Object} LockHolder
 * @property {number} pid @property {string} host @property {number|string} pr @property {string} startedAt
 */

/**
 * One try at the merge lock (makeLock builds one over a file system). `acquire` never waits: mergePr polls it.
 * @typedef {Object} MergeLock
 * @property {(o: { pr: number|string, staleMin?: number }) => Promise<{ held: boolean, holder: LockHolder|null, path: string, reason: string, note: string|null }>} acquire
 *   held true: the lock is this process's (`note` says so when a stale lock was taken over); held false: `holder` has it
 * @property {() => Promise<void>} release  idempotent; removes the lock only while owner.json still names this holder
 */

/**
 * @typedef {Object} MergeDeps
 * @property {(command: string, o: { cwd: string }) => Promise<RunResult>|RunResult} run  one shell command; never throws on a non-zero exit
 * @property {(ms: number) => Promise<void>|void} sleep
 * @property {() => number} [now]    a clock for the elapsed-ms fields and the waits; without it elapsed is 0 and waits count the sleeps
 * @property {MergeLock} [lock]      the merge lock (scripts/merge-pr.js wires it to the file system); without it no lock is taken
 */

export const MERGE_EXIT = { merged: 0, refused: 2, locked: 2, reverted: 3, error: 4, pending: 5 }
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
export const LOCK_NAME = 'agent-loop-merge.lock'
export const LOCK_POLL_MS = 5000
export const LOCK_WAIT_DEFAULT_MIN = 5
export const LOCK_WAIT_MAX_MIN = 8
export const LOCK_STALE_DEFAULT_MIN = 30
export const LOCK_YOUNG_MS = 10000
export const LOCK_TAKEOVER_STALE_MS = 60000

const WORKFLOW_DIR = '.github/workflows/'
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
  /** @param {'refused'|'error'|'dry-run'|'locked'} outcome @param {string} message @param {Record<string, unknown>} [extra] */
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
 *
 * The merge lock (deps.lock, built by makeLock over the file system) is taken before the PR is read, so the sync decision
 * and the pinned head come from after any wait; it is held through the merge, the check on main when it is not deferred,
 * and a revert, and released on every exit path, so the guarantee does not depend on the caller. A held lock is waited for
 * (polled every 5 s, project.mergeLockWaitMin, default 5, at most 8); then the outcome is 'locked', exit 2. A dry run and
 * a call without deps.lock take no lock; verify mode takes it only for a revert.
 *
 * Exit codes: 0 merged and the default branch is green, 2 refused (CI not green, a sync conflict, or GitHub
 * refused the merge), 3 reverted (the default branch was red; one revert PR was merged and it is green again),
 * 4 error (the revert PR was not green, main is still red after the revert, or anything unexpected).
 * A dry run reports outcome 'dry-run' with exit 0 and `wouldRun`, the write calls it did not make.
 *
 * mainCheck says what was done about the default branch after the merge:
 * - 'skipped:unchanged': only with project.reuseTreeCi: the merge commit's tree equals the tree of the PR head whose CI was
 *   green (main had not moved past the branch) and the main CI workflow file shows no event-dependent behaviour
 *   (scanWorkflow), so CI already checked exactly this tree and the check on main is not waited for. `treeReuse` is
 *   { allowed, reason } after a merge, whatever the answer; reuseTreeCi is off by default.
 * - 'deferred': deferMain was set (and mainCi is set): the caller runs verify mode for this merge outside its lock.
 * - 'green', 'red' (then reverted), 'pending' (verify mode ran out of mainWaitMs), 'unknown' (an error), or null when
 *   nothing was merged.
 * Exit 5 (pending) happens only in verify mode.
 *
 * outcome and mainCheck together, the only combinations this function returns:
 *   merged    skipped:unchanged | deferred | green
 *   reverted  red                                  (main was red; the revert PR merged and main is green again)
 *   pending   pending                              (verify mode only)
 *   error     null      nothing was merged
 *             unknown   merged, but main could not be verified
 *             red       merged, main red, and the revert failed or main is still red after it
 *   refused | locked | dry-run   null              (nothing was merged)
 * (merge-pr.js --state prints outcome 'state' from its own path, not from this function.)
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
    lockWaitMs: 0,
    treeReuse: null,
  }
  /** @type {string[]} */
  const wouldRun = []
  let base = ''
  let head = ''
  let title = ''
  let fetched = false
  let tempWorktree = ''
  let revertWorktree = ''
  let held = false
  /** @type {string[]} */
  const notes = []
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
    await takeLock('')
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

    // 4. Verify the default branch; revert once on red. Skipped only with project.reuseTreeCi, when the merged tree is the
    // tree CI checked and the main CI workflow shows no event-dependent behaviour.
    const tMain = now()
    const pull = await run('git pull --ff-only')
    const reuse = await reuseVerdict(mergeSha, headSha, base)
    result.treeReuse = { allowed: reuse.allowed, reason: reuse.reason }
    if (!reuse.allowed && reuse.cite) notes.push(`The check on the default branch runs: ${reuse.reason}.`)
    if (reuse.allowed) {
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
    if (held) {
      held = false
      try {
        await deps.lock.release()
      } catch (e) {
        result.message = `${result.message} The merge lock could not be released (${e && e.message ? e.message : String(e)}); remove it by hand.`.trim()
      }
    }
  }

  /**
   * Take the merge lock, waiting for a holder up to the wait limit. No lock dep, a dry run and a lock already held
   * take nothing. 'locked' when the wait runs out; an error from the lock itself is an error, not a wait.
   * @param {string} context what could not start, for the message
   */
  async function takeLock(context) {
    if (!deps.lock || dry || held) return
    const waitMin = Number.isFinite(project.mergeLockWaitMin) && project.mergeLockWaitMin >= 0 ? Math.min(project.mergeLockWaitMin, LOCK_WAIT_MAX_MIN) : LOCK_WAIT_DEFAULT_MIN
    const staleMin = Number.isFinite(project.mergeLockStaleMin) && project.mergeLockStaleMin >= 0 ? project.mergeLockStaleMin : LOCK_STALE_DEFAULT_MIN
    const waitMs = waitMin * 60 * 1000
    const t0 = now()
    let slept = 0
    const elapsed = () => (deps.now ? now() - t0 : slept)
    try {
      for (;;) {
        const r = await deps.lock.acquire({ pr: n, staleMin })
        if (r.held) {
          held = true
          if (r.note) notes.push(r.note)
          return
        }
        if (elapsed() >= waitMs) {
          const h = r.holder
          const who = h ? `PR #${h.pr} (pid ${h.pid} on ${h.host}, since ${h.startedAt})` : 'a holder whose owner.json is missing or unreadable'
          throw new Stop(
            'locked',
            `${context}the merge lock is held by ${who}${r.reason ? `: ${r.reason}` : ''}; waited ${Math.round(elapsed() / 1000)} s. Call again later. If that process is gone and its pid was reused, remove ${r.path} by hand.`,
          )
        }
        await sleep(LOCK_POLL_MS)
        slept += LOCK_POLL_MS
      }
    } finally {
      result.lockWaitMs += elapsed()
    }
  }

  /**
   * May the check on the default branch be skipped? Only with project.reuseTreeCi, when the merged tree is the tree CI
   * checked, and when the main CI workflow file at the merge commit passes scanWorkflow. `cite` says the reason belongs in
   * message (the evidence failed, as opposed to the option being off or the trees differing).
   * @param {string} mergeSha @param {string} headSha @param {string} defaultBranch
   * @returns {Promise<{ allowed: boolean, reason: string, cite: boolean }>}
   */
  async function reuseVerdict(mergeSha, headSha, defaultBranch) {
    if (project.reuseTreeCi !== true) return { allowed: false, reason: 'project.reuseTreeCi is off, so the check on the default branch always runs', cite: false }
    if (!(await treeUnchanged(mergeSha, headSha))) return { allowed: false, reason: 'the merged tree is not proven to be the tree CI checked', cite: false }
    const file = await mainWorkflow(mergeSha)
    if (!file.text) return { allowed: false, reason: file.reason, cite: true }
    const scan = scanWorkflow(file.text, defaultBranch)
    return { allowed: scan.allowed, reason: scan.allowed ? `the merged tree is the tree CI checked and ${file.path} shows no event-dependent behaviour` : `${file.path}: ${scan.reason}`, cite: !scan.allowed }
  }

  /**
   * The main CI workflow file at a commit: `.github/workflows/<mainCi>.yml` or `.yaml`, else the one file there whose
   * top-level `name:` equals mainCi (found with git ls-tree, read with git show).
   * @param {string} sha
   * @returns {Promise<{ path: string, text: string, reason: string }>}
   */
  async function mainWorkflow(sha) {
    const none = (reason) => ({ path: '', text: '', reason })
    if (!mainCi) return none('mainCi is empty, so there is no main CI workflow file to read')
    const ls = await run(`git ls-tree --name-only ${sha} ${sh(WORKFLOW_DIR)}`)
    if (ls.code !== 0) return none(`cannot list ${WORKFLOW_DIR} at ${sha}: ${(ls.stderr || ls.stdout).trim().slice(0, 200) || `exit ${ls.code}`}`)
    const files = ls.stdout.split('\n').map((l) => l.trim()).filter((l) => /\.ya?ml$/.test(l))
    const read = async (path) => {
      const r = await run(`git show ${sha}:${sh(path)}`)
      return r.code === 0 ? r.stdout : null
    }
    const fileLike = /^[\w.-]+$/.test(mainCi)
    const direct = fileLike ? [`${WORKFLOW_DIR}${mainCi}.yml`, `${WORKFLOW_DIR}${mainCi}.yaml`, `${WORKFLOW_DIR}${mainCi}`].find((f) => files.includes(f)) : undefined
    if (direct) {
      const text = await read(direct)
      return text === null ? none(`cannot read ${direct} at ${sha}`) : { path: direct, text, reason: '' }
    }
    /** @type {Array<{ path: string, text: string }>} */
    const named = []
    let unreadable = ''
    for (const f of files) {
      const text = await read(f)
      if (text === null) {
        unreadable = f
        continue
      }
      const m = /^name:[ \t]*(.*?)[ \t]*(?:#.*)?$/m.exec(text)
      const name = m ? m[1].replace(/^(["'])(.*)\1$/, '$2') : ''
      if (name === mainCi) named.push({ path: f, text })
    }
    if (named.length === 1) return { ...named[0], reason: '' }
    if (named.length > 1) return none(`several files in ${WORKFLOW_DIR} are named "${mainCi}": ${named.map((x) => x.path).join(', ')}`)
    return none(unreadable ? `cannot read ${unreadable} at ${sha}, and no other file in ${WORKFLOW_DIR} is named "${mainCi}"` : `no workflow file in ${WORKFLOW_DIR} for mainCi "${mainCi}" at ${sha}`)
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
    // A revert always runs under the lock (verify mode held none until now).
    await takeLock(`PR #${n} is merged (${mergeSha}) and the default branch is red, but the revert did not start: `)
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
    result.message = notes.length ? `${message} ${notes.join(' ')}` : message
    result.elapsedMs = now() - started
    result.mergeMs = Math.max(0, result.elapsedMs - result.ciWaitMs - result.mainCheckMs - result.revertMs - result.lockWaitMs)
    if (dry) result.wouldRun = wouldRun
    return result
  }
}

const WORKFLOW_FORBIDDEN = ['github.event_name', 'github.event.', 'github.ref', 'secrets.', 'vars.', 'schedule:']
const WORKFLOW_FILTERS = ['paths', 'paths-ignore', 'branches-ignore', 'tags', 'tags-ignore']

/**
 * A text scan of a CI workflow file (no YAML parser): does it behave the same for a push to the default branch as for
 * the pull request that was merged into it? Allowed only when it has none of `github.event_name`, `github.event.`,
 * `github.ref`, `secrets.`, `vars.` or `schedule:`, an `on:` block with both `push` and `pull_request`, no `paths`,
 * `paths-ignore`, `branches-ignore` or `tags` filter on either, a `branches` filter only on `push` and only when it lists
 * the default branch, and no job-level `if:`. Anything it cannot read with confidence is not allowed.
 * @param {string} text the workflow file @param {string} defaultBranch
 * @returns {{ allowed: boolean, reason: string }}
 */
export function scanWorkflow(text, defaultBranch) {
  const no = (reason) => ({ allowed: false, reason })
  const src = String(text ?? '')
  for (const pattern of WORKFLOW_FORBIDDEN) if (src.includes(pattern)) return no(`the workflow uses "${pattern}"`)
  const lines = src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l))
  const indent = (l) => /^ */.exec(l)[0].length
  const bare = (l) => l.replace(/\s+#.*$/, '')
  const blank = (l) => !l.trim()
  /** The lines after `lines[i]` that belong to its top-level key. */
  const bodyAfter = (i) => {
    const out = []
    for (let j = i + 1; j < lines.length; j++) {
      if (!blank(lines[j]) && indent(lines[j]) === 0) break
      out.push(lines[j])
    }
    return out
  }

  const onAt = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l))
  if (onAt < 0) return no('the workflow has no on: block')
  const inline = bare(lines[onAt]).replace(/^["']?on["']?\s*:\s*/, '').trim()
  const body = bodyAfter(onAt).map(bare).filter((l) => !blank(l))
  /** @type {Map<string, string[]>} event name -> the lines that belong to it (its inline value first) */
  const events = new Map()
  if (inline) {
    const flat = [inline, ...body].join('\n')
    if (inline.startsWith('{')) {
      if (WORKFLOW_FILTERS.concat(['branches']).some((k) => new RegExp(`(^|[\\s{,])${k}\\s*:`).test(flat))) return no('the on: block is a flow mapping with filters, which the scan does not read')
      for (const ev of ['push', 'pull_request']) if (new RegExp(`(^|[\\s{,])${ev}\\s*:`).test(flat)) events.set(ev, [])
    } else {
      const names = flat.replace(/^\[/, '').replace(/\].*$/s, '').split(/[,\s]+/).map((x) => x.replace(/^["']|["']$/g, '')).filter(Boolean)
      for (const name of names) events.set(name, [])
    }
  } else if (body.length) {
    if (/^\s*-\s/.test(body[0])) {
      for (const l of body) {
        const m = /^\s*-\s*["']?([\w-]+)["']?\s*$/.exec(l)
        if (m) events.set(m[1], [])
      }
    } else {
      const evIndent = indent(body[0])
      /** @type {string[]|null} */
      let cur = null
      for (const l of body) {
        const m = indent(l) === evIndent ? /^\s*["']?([\w-]+)["']?\s*:\s*(.*)$/.exec(l) : null
        if (m) {
          cur = m[2] ? [m[2]] : []
          events.set(m[1], cur)
        } else if (cur) cur.push(l)
      }
    }
  }
  for (const ev of ['push', 'pull_request']) if (!events.has(ev)) return no(`the on: block has no ${ev} trigger`)
  for (const ev of ['push', 'pull_request']) {
    const ls = events.get(ev) || []
    const flat = ls.join('\n')
    for (const k of WORKFLOW_FILTERS) if (new RegExp(`(^|[\\s{,])${k}\\s*:`).test(flat)) return no(`the ${ev} trigger has a ${k} filter`)
    const at = ls.findIndex((l) => /(^|[\s{,])branches\s*:/.test(l))
    if (at < 0) continue
    if (ev === 'pull_request') return no('the pull_request trigger has a branches filter')
    const rest = /branches\s*:\s*(.*)$/.exec(ls[at])[1].trim()
    const tail = [rest, ...ls.slice(at + 1)].join('\n')
    let entries = []
    if (rest.startsWith('[')) {
      const m = /^\[([^\]]*)\]/.exec(tail)
      entries = m ? m[1].split(/[,\n]/) : []
    } else if (rest) {
      entries = [rest.replace(/\s*}\s*$/, '')]
    } else {
      for (const l of ls.slice(at + 1)) {
        const m = /^\s*-\s*(.+)$/.exec(l)
        if (!m) break
        entries.push(m[1])
      }
    }
    const listed = entries.map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    if (!listed.includes(defaultBranch)) return no(`the push trigger's branches filter (${listed.join(', ') || 'empty'}) does not list the default branch ${defaultBranch}`)
  }

  const jobsAt = lines.findIndex((l) => /^jobs\s*:/.test(l))
  if (jobsAt >= 0) {
    const jobs = bodyAfter(jobsAt).map(bare).filter((l) => !blank(l))
    const jobIndent = jobs.length ? indent(jobs[0]) : 0
    let propIndent = -1
    for (const l of jobs) {
      const d = indent(l)
      if (d === jobIndent) propIndent = -1
      else if (propIndent < 0) propIndent = d
      if (d !== jobIndent && d === propIndent && /^\s*if\s*:/.test(l)) return no('a job has a job-level if:')
    }
  }
  return { allowed: true, reason: '' }
}

/**
 * The merge lock over a file system: a directory made with an atomic mkdir, holding owner.json { pid, host, pr, startedAt }
 * (written under a temporary name and renamed into the directory). One handle is one holder; scripts/merge-pr.js wires the
 * real file system, process and clock. `fs`: mkdir (throws code EEXIST when the directory exists), writeFile, rename,
 * readFile (throws when absent), rm (recursive, no error when absent), mtimeMs (throws when absent). All may be async.
 *
 * A lock is stale when its host is this host and its pid is not alive, or when its host is another host or owner.json is
 * missing or unparseable and the directory is older than `staleMin`. A live pid on this host is never stale, and a lock
 * younger than 10 s with no owner.json counts as held. A takeover takes a second mkdir (`<lock>.takeover`), re-reads
 * owner.json under it, replaces the lock only when it still shows the owner judged stale, and removes the takeover
 * directory. Known limit: a crashed holder whose pid was reused looks live; `acquire` reports the path for a human.
 *
 * @param {{ fs: { mkdir: Function, writeFile: Function, rename: Function, readFile: Function, rm: Function, mtimeMs: Function },
 *   lockPath: string|(() => string|Promise<string>), pid: number, host: string, now: () => number, alive: (pid: number) => boolean|Promise<boolean> }} o
 * @returns {MergeLock}
 */
export function makeLock(o) {
  const { fs, pid, host, now, alive } = o
  /** @type {{ dir: string, text: string }|null} */
  let mine = null
  const eexist = (e) => Boolean(e) && e.code === 'EEXIST'
  const dirOf = async () => (typeof o.lockPath === 'function' ? o.lockPath() : o.lockPath)

  async function readOwner(dir) {
    let raw = null
    try {
      raw = String(await fs.readFile(`${dir}/owner.json`))
    } catch {
      return { raw: null, owner: null }
    }
    try {
      const j = JSON.parse(raw)
      const ok = j && typeof j === 'object' && Number.isInteger(j.pid) && typeof j.host === 'string'
      return { raw, owner: ok ? { pid: j.pid, host: j.host, pr: j.pr, startedAt: String(j.startedAt ?? '') } : null }
    } catch {
      return { raw, owner: null }
    }
  }

  /** @returns {Promise<{ state: 'gone'|'held'|'stale', raw: string|null, owner: any, why: string }>} */
  async function judge(dir, staleMs, staleMin) {
    const { raw, owner } = await readOwner(dir)
    let age
    try {
      age = now() - (await fs.mtimeMs(dir))
    } catch {
      return { state: 'gone', raw, owner, why: '' }
    }
    if (owner && owner.host === host) {
      if (await alive(owner.pid)) return { state: 'held', raw, owner, why: `pid ${owner.pid} is alive on ${host}` }
      return { state: 'stale', raw, owner, why: `pid ${owner.pid} is not alive on ${host}` }
    }
    const what = owner ? `it belongs to another host (${owner.host})` : raw === null ? 'owner.json is missing' : 'owner.json is unparseable'
    if (!owner && age < LOCK_YOUNG_MS) return { state: 'held', raw, owner, why: 'owner.json is not written yet' }
    if (age > staleMs) return { state: 'stale', raw, owner, why: `${what} and the lock is ${Math.round(age / 60000)} min old (limit ${staleMin} min)` }
    return { state: 'held', raw, owner, why: owner ? `it belongs to another host (${owner.host}) and is ${Math.round(age / 60000)} min old (limit ${staleMin} min)` : `${what} and the lock is ${Math.round(age / 1000)} s old (limit ${staleMin} min)` }
  }

  async function writeOwner(dir, pr) {
    const n = Number(pr)
    const text = JSON.stringify({ pid, host, pr: Number.isInteger(n) ? n : String(pr), startedAt: new Date(now()).toISOString() })
    const tmp = `${dir}.owner.${pid}.tmp`
    try {
      await fs.writeFile(tmp, text)
      await fs.rename(tmp, `${dir}/owner.json`)
    } catch (e) {
      for (const path of [tmp, dir]) {
        try {
          await fs.rm(path)
        } catch {}
      }
      throw e
    }
    mine = { dir, text }
  }

  const describe = (j) => (j.owner ? `PR #${j.owner.pr} (pid ${j.owner.pid} on ${j.owner.host}, since ${j.owner.startedAt})` : 'an owner that left no readable owner.json')

  return {
    async acquire({ pr, staleMin }) {
      const dir = await dirOf()
      const limit = Number.isFinite(staleMin) && staleMin >= 0 ? staleMin : LOCK_STALE_DEFAULT_MIN
      const staleMs = limit * 60 * 1000
      const taken = (note) => ({ held: true, holder: null, path: dir, reason: '', note })
      const held = (j, reason) => ({ held: false, holder: j.owner, path: dir, reason: reason || j.why, note: null })
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await fs.mkdir(dir)
          await writeOwner(dir, pr)
          return taken(null)
        } catch (e) {
          if (!eexist(e)) throw e
        }
        const j = await judge(dir, staleMs, limit)
        if (j.state === 'gone') continue
        if (j.state === 'held') return held(j)
        // stale: take over under a second atomic mkdir
        const tk = `${dir}.takeover`
        try {
          await fs.mkdir(tk)
        } catch (e) {
          if (!eexist(e)) throw e
          let age = null
          try {
            age = now() - (await fs.mtimeMs(tk))
          } catch {}
          if (age !== null && age > LOCK_TAKEOVER_STALE_MS) {
            await fs.rm(tk)
            continue
          }
          return held(j, 'another process is taking the stale lock over')
        }
        try {
          const again = await judge(dir, staleMs, limit)
          if (again.state !== 'stale' || again.raw !== j.raw) continue
          await fs.rm(dir)
          try {
            await fs.mkdir(dir)
          } catch (e) {
            if (eexist(e)) continue
            throw e
          }
          await writeOwner(dir, pr)
          return taken(`Took over the stale merge lock ${dir}, held by ${describe(j)}: ${j.why}.`)
        } finally {
          await fs.rm(tk)
        }
      }
      const j = await judge(dir, staleMs, limit)
      return held(j, 'the lock kept changing hands')
    },
    async release() {
      if (!mine) return
      const { dir, text } = mine
      mine = null
      const cur = await readOwner(dir)
      if (cur.raw === text) await fs.rm(dir)
    },
  }
}
