// CI wait: poll a pull request's checks in code and combine the result with the critic's verdict.
// Pure functions with injected I/O (exec, sleep); scripts/wait-ci.js wires real gh and sleep.
// No import and no export list, so scripts/bundle-workflows.js can copy this file into a workflow.
// Reads or writes: reads (only `gh pr checks` and `gh run view`).

/**
 * @typedef {Object} ExecResult
 * @property {number} code  process exit code (gh exits 8 while checks are pending and 1 on a failure)
 * @property {string} stdout
 * @property {string} [stderr]
 */

/**
 * @typedef {Object} CiResult
 * @property {'green'|'red'|'pending'|'missing'} state
 * @property {string[]} failing  names of the failed or cancelled checks
 * @property {string} logTail    tail of `gh run view --log-failed` for the failing runs, '' when none
 * @property {number} polls      how many times the checks were read
 */

/**
 * @typedef {Object} FixItem
 * @property {number} n
 * @property {string} what
 * @property {string} provedBy
 * @property {'defect'|'spec_miss'|'loop'} cause
 */

export const CI_POLL_MS = 20000
export const CI_TIMEOUT_MS = 20 * 60 * 1000
export const CI_MISSING_MS = 2 * 60 * 1000
export const CI_LOG_TAIL_CHARS = 3000

/**
 * Parse the JSON array that `gh pr checks --json ...` prints. Returns null when stdout is not a JSON array
 * (for example gh's "no checks reported" message, which goes to stderr with exit 1).
 * @param {string} stdout
 * @returns {Array<{name: string, bucket: string, link: string}> | null}
 */
function parseChecks(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  try {
    const data = JSON.parse(text)
    return Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

/**
 * Wait for the checks of a pull request to settle.
 *
 * Polls `gh pr checks <n> --json name,state,bucket,link,workflow` every `pollMs` (default 20 s). Bucket `pass`
 * is green, `skipping` is ignored, `fail` and `cancel` are red, `pending` (and any bucket gh may add later) is
 * pending. stdout is parsed whatever the exit code. Stops when no check is pending, or after `timeoutMs`
 * (default 20 min). No real check reported after `missingMs` (default 2 min) is `missing`: not the worker's fault.
 * Time is counted from the sleeps, so tests need no clock; pass `now` to count real elapsed time instead.
 *
 * @param {number|string} prNumber
 * @param {(command: string) => Promise<ExecResult>|ExecResult} exec runs one shell command, never throws on a non-zero exit
 * @param {{ sleep: (ms: number) => Promise<void>|void, pollMs?: number, timeoutMs?: number, missingMs?: number, logTailChars?: number, now?: () => number }} opts
 * @returns {Promise<CiResult>}
 */
export async function waitForCi(prNumber, exec, opts) {
  const o = opts || {}
  if (typeof o.sleep !== 'function') throw new Error('waitForCi: opts.sleep is required')
  const pollMs = o.pollMs ?? CI_POLL_MS
  const timeoutMs = o.timeoutMs ?? CI_TIMEOUT_MS
  const missingMs = Math.min(o.missingMs ?? CI_MISSING_MS, timeoutMs)
  const tailChars = o.logTailChars ?? CI_LOG_TAIL_CHARS
  const started = o.now ? o.now() : 0
  let slept = 0
  const elapsed = () => (o.now ? o.now() - started : slept)
  const command = `gh pr checks ${prNumber} --json name,state,bucket,link,workflow`

  let polls = 0
  let lastError = ''
  for (;;) {
    const r = await exec(command)
    polls++
    const parsed = parseChecks(r.stdout)
    if (parsed === null && (r.stderr || r.stdout)) lastError = String(r.stderr || r.stdout).trim().slice(0, 300)
    // A skipping check is ignored; if nothing else is left, no real check has reported yet.
    const checks = (parsed || []).filter((c) => c.bucket !== 'skipping')
    const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
    const pending = checks.filter((c) => !['pass', 'fail', 'cancel'].includes(c.bucket))

    if (checks.length > 0 && pending.length === 0) {
      if (failed.length === 0) return { state: 'green', failing: [], logTail: '', polls }
      return { state: 'red', failing: unique(failed.map((c) => c.name)), logTail: await failedLogTail(failed, exec, tailChars), polls }
    }
    if (checks.length === 0 && elapsed() >= missingMs) {
      return { state: 'missing', failing: [], logTail: lastError, polls }
    }
    if (elapsed() >= timeoutMs) {
      return { state: 'pending', failing: unique(failed.map((c) => c.name)), logTail: '', polls }
    }
    await o.sleep(pollMs)
    slept += pollMs
  }
}

/** @param {string[]} list */
function unique(list) {
  return [...new Set(list)]
}

/**
 * Tail of the failed-step log of each failing run (one `gh run view` per distinct run id).
 * @param {Array<{name: string, link: string}>} failed
 * @param {(command: string) => Promise<ExecResult>|ExecResult} exec
 * @param {number} tailChars
 * @returns {Promise<string>}
 */
async function failedLogTail(failed, exec, tailChars) {
  const runs = new Map()
  for (const c of failed) {
    const m = String(c.link || '').match(/\/actions\/runs\/(\d+)/)
    if (!m) continue
    if (!runs.has(m[1])) runs.set(m[1], [])
    runs.get(m[1]).push(c.name)
  }
  const parts = []
  for (const [id, names] of runs) {
    const r = await exec(`gh run view ${id} --log-failed`)
    const out = String(r.stdout || '')
    if (r.code !== 0 && !out.trim()) {
      parts.push(`[${names.join(', ')}] (log unavailable: ${String(r.stderr || `exit ${r.code}`).trim().slice(0, 200)})`)
    } else {
      parts.push(`[${names.join(', ')}]\n${out.slice(-tailChars).trim()}`)
    }
  }
  if (parts.length === 0) return `(log unavailable: no run id in the check link of ${unique(failed.map((c) => c.name)).join(', ')})`
  return parts.join('\n\n')
}

/**
 * Combine the critic's verdict with the CI result. Pending or missing CI is never a FIX.
 *
 * MERGE + green merges; MERGE + red is FIX with the failing check; MERGE + pending or missing escalates.
 * FIX stays FIX (a red CI appends its failing-check item to the critic's items); STOP stays STOP.
 * An unknown verdict escalates, so nothing merges on a verdict this function does not know.
 *
 * @param {{ verdict: string, fixItems?: FixItem[] } | string} criticVerdict the critic's result, or just its verdict
 * @param {{ state: string, failing?: string[], logTail?: string }} ci the waitForCi result
 * @returns {{ action: 'merge'|'fix'|'escalate'|'stop', fixItems: FixItem[], reason: string }}
 */
export function combineVerdict(criticVerdict, ci) {
  const verdict = String(typeof criticVerdict === 'string' ? criticVerdict : criticVerdict?.verdict ?? '').toUpperCase()
  const items = (typeof criticVerdict === 'object' && criticVerdict && Array.isArray(criticVerdict.fixItems) ? criticVerdict.fixItems : []).map((i) => ({ ...i }))
  const state = ci?.state

  if (verdict === 'STOP') return { action: 'stop', fixItems: items, reason: 'Critic returned STOP; CI does not change it.' }
  if (verdict !== 'MERGE' && verdict !== 'FIX') {
    return { action: 'escalate', fixItems: [], reason: `Unknown critic verdict "${verdict}"; nothing merges on it.` }
  }

  if (state === 'red') {
    const names = (ci.failing || []).join(', ') || 'unnamed check'
    const n = items.reduce((m, i) => Math.max(m, Number(i.n) || 0), 0) + 1
    items.push({
      n,
      what: `CI failed on the PR head: ${names}.${ci.logTail ? `\n${ci.logTail}` : ''}`,
      provedBy: 'CI green on the PR head',
      cause: 'defect',
    })
    return {
      action: 'fix',
      fixItems: items,
      reason: verdict === 'MERGE' ? `Critic returned MERGE but CI is red (${names}).` : `Critic returned FIX and CI is red (${names}); one round fixes both.`,
    }
  }
  if (verdict === 'FIX') return { action: 'fix', fixItems: items, reason: `Critic returned FIX; CI is ${state}.` }

  if (state === 'green') return { action: 'merge', fixItems: [], reason: 'Critic returned MERGE and CI is green.' }
  if (state === 'pending') {
    return { action: 'escalate', fixItems: [], reason: 'CI still pending after the timeout; this is not the worker\'s fault, so no FIX round.' }
  }
  if (state === 'missing') {
    return { action: 'escalate', fixItems: [], reason: 'No CI checks were reported; this is not the worker\'s fault, so no FIX round and no merge.' }
  }
  return { action: 'escalate', fixItems: [], reason: `Unknown CI state "${state}"; nothing merges on it.` }
}
