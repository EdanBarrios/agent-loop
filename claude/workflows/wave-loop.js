// Wave loop: parallel tasks through worker -> critic (beside a CI wait) -> merge, then a tail task alone.
// Run with the Workflow tool: { name: 'wave-loop', args: { project, wave, tasks, tail } }.
// args.project: the parsed contents of the repo's .claude/loop.local.json (see README.md, "Project config").
// args.tasks: [{ id, title, branch, deps: [ids], text, owns, notes, lane?, resume? }]; args.tail: same shape or null.
// lane is 'fast' or 'normal' (default normal), set by the session from the task's `Lane:` line in the spec.
// CI and the merge are commands, not model work (v2.1): scripts/wait-ci.js and scripts/merge-pr.js, each run by one
// low-cost relay agent that returns the command's stdout and exit code; this script parses the JSON line itself.
// project.loopScripts is the directory holding them (default <repo>/.claude/scripts). Before any worker starts, a
// preflight relay runs `merge-pr.js 0 --repo <repo> --dry-run`; a block or a missing script fails the wave.
// project.merger = 'agent' restores the v2 merger agent (the CI relay and the verdict rules stay on).
// project.fastLane { enabled, maxPerWave, denyPaths, testCountCommand }: a `Lane: fast` task skips the critic when
// fastLaneEligible (claude/lib/lane.js) agrees after the CI result.
// resume: { prNumber, prUrl, worktree, items: [string], notes } continues an existing draft PR (after an escalation
// was answered) with a fix-round worker instead of a fresh worker; the worker must mark the PR ready.
// Role defaults: worker = Sonnet/high, critic = Fable/high, merger = Sonnet/low (set after the first scorecards,
// 2026-10-27), pinned by full model id; project.models overrides per role.
// args.gates: the project's gate checklist, already parsed from project.gates by the session (scripts have no fs).
// An open item with before <= this wave returns { gate: 'BLOCKED', blockedBy: [ids] } before any agent starts.
// project.realityCheck: { command, readOnly: true, timeoutSec }: run after the machine gate through a small
// haiku/low agent; a block gap (or a check that does not run cleanly) fails the gate with a reality_gap escalation.
// Result: { project, wave, gate, models, state, tasks, escalations, reality, decisions, timings, loopVersion }. reality is null when no
// check is configured, else { ok, gaps, error? }; decisions are the workers' `id | choice | reason | reversible` lines.
// timings[taskId] = { ciWaitMs, mergeMs, mainCheckMs } copied from the scripts' JSON lines, plus localCheckMs from the
// worker's structured result (this script has no clock). tasks[id].merge.script.mainCheck is 'skipped:unchanged' when
// the check on main was skipped because the merged tree is the tree CI checked.
// tasks[id].rounds[n].criticSkipped is 'ci-only' when a later round reused the previous MERGE (scripts/ci-only.js).
// This script never calls workflow(): chain-loop calls it, and nesting is one level.
// LOOP_VERSION equals package.json "version" (a test holds them equal). The preflight dry run prints the version of the
// loop scripts it ran; a different or missing one fails the wave, because the Workflow tool resolves 'wave-loop' from the
// session's own .claude/workflows, which can be another copy of the loop than the project's linked scripts. The result
// carries loopVersion so a scorecard can tell which loop ran.

export const meta = {
  name: 'wave-loop',
  description: 'One wave of spec tasks: parallel tasks through worker -> critic beside a CI wait -> merge script, then the tail alone',
  whenToUse: 'One run per wave of the project spec; pass .claude/loop.local.json as args.project and the wave tasks as args.tasks.',
  phases: [
    { title: 'Preflight', detail: 'One relay runs merge-pr.js --dry-run; a block or a missing script fails the wave', model: 'sonnet' },
    { title: 'Build', detail: 'Workers, a few at a time, one git worktree each', model: 'sonnet' },
    { title: 'Review', detail: 'Critic applies the checklist beside a wait-ci.js relay; FIX returns to a worker, max 3 rounds' },
    { title: 'Merge', detail: 'Serialized merge-pr.js relay: sync if needed, wait CI, merge; the check on main is skipped when the merged tree is the tree CI checked, else watched outside the lock; revert once', model: 'sonnet' },
    { title: 'Tail', detail: 'The tail task runs alone after every parallel task is merged or parked' },
  ],
}

const P = args.project || {}
for (const k of ['name', 'repo', 'github', 'worktrees', 'spec']) {
  if (!P[k]) throw new Error(`args.project.${k} is missing. Read .claude/loop.local.json in the repo and pass it as args.project.`)
}

// The runtime accepts only self-contained scripts, so the libs are bundled here by scripts/bundle-workflows.js.
// Order matters: bundled names share one scope (the bundler refuses duplicates), and a lib may use an earlier one.
// @bundle-start gates
// generated from claude/lib/gates.js by scripts/bundle-workflows.js: do not edit
// Gate checklist: the up-front list of human steps a project spec needs before a wave may start.
// Pure functions; the CLI in scripts/gates.js does the file I/O.

/**
 * @typedef {Object} Gate
 * @property {string} id
 * @property {string} what
 * @property {string} why
 * @property {'human'} owner
 * @property {string} before  wave id the item must be settled before, e.g. '0', '0a', '3'
 * @property {'minutes'|'hours'|'days'} leadTime
 * @property {'open'|'done'|'waived'} status
 * @property {string} evidence
 */

const STATUSES = ['open', 'done', 'waived'];
const LEAD_TIMES = ['minutes', 'hours', 'days'];
const OWNERS = ['human'];
const STRING_FIELDS = ['id', 'what', 'why', 'before', 'evidence'];
// Longest lead time sorts first: those are the items that stall a wave.
const LEAD_RANK = { days: 0, hours: 1, minutes: 2 };

/**
 * Natural sort of wave ids: digit runs compare as numbers, other text as text, and a shorter
 * id sorts before a longer one it prefixes, so 0 < 0a < 0b < 1 < 2 < 10.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareWaves(a, b) {
  const pa = String(a).match(/\d+|\D+/g) ?? [];
  const pb = String(b).match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    const numeric = /^\d/.test(x) && /^\d/.test(y);
    if (numeric) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (x !== y) {
      // A digit run sorts before a letter run; otherwise plain code-unit order.
      if (/^\d/.test(x)) return -1;
      if (/^\d/.test(y)) return 1;
      return x < y ? -1 : 1;
    }
  }
  return Math.sign(pa.length - pb.length);
}

/**
 * Validate a gate checklist. Every error names the offending item id.
 * @param {string|unknown} json  the parsed array, or its JSON text
 * @returns {Gate[]}
 */
function loadGates(json) {
  let data = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch (err) {
      throw new Error(`gates: invalid JSON: ${/** @type {Error} */ (err).message}`);
    }
  }
  if (!Array.isArray(data)) throw new Error('gates: expected an array of gate items');
  const seen = new Set();
  data.forEach((item, index) => {
    const label = item && typeof item === 'object' && typeof item.id === 'string' && item.id ? item.id : `#${index}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`gates: item ${label} is not an object`);
    }
    for (const field of [...STRING_FIELDS, 'owner', 'leadTime', 'status']) {
      if (!(field in item)) throw new Error(`gates: item ${label} is missing field "${field}"`);
    }
    for (const field of STRING_FIELDS) {
      if (typeof item[field] !== 'string') throw new Error(`gates: item ${label} field "${field}" must be a string`);
    }
    for (const field of ['id', 'what', 'why', 'before']) {
      if (item[field].trim() === '') throw new Error(`gates: item ${label} field "${field}" must not be empty`);
    }
    if (!OWNERS.includes(item.owner)) {
      throw new Error(`gates: item ${label} has bad owner "${item.owner}" (expected ${OWNERS.join('|')})`);
    }
    if (!LEAD_TIMES.includes(item.leadTime)) {
      throw new Error(`gates: item ${label} has bad leadTime "${item.leadTime}" (expected ${LEAD_TIMES.join('|')})`);
    }
    if (!STATUSES.includes(item.status)) {
      throw new Error(`gates: item ${label} has bad status "${item.status}" (expected ${STATUSES.join('|')})`);
    }
    if (seen.has(item.id)) throw new Error(`gates: duplicate id ${item.id}`);
    seen.add(item.id);
  });
  return /** @type {Gate[]} */ (data);
}

/**
 * Open items that must be settled before `wave` starts (before <= wave), longest lead time first,
 * then by wave, then by id. Done and waived items never block. With no `wave`, every open item.
 * @param {Gate[]} gates
 * @param {string} [wave]
 * @returns {Gate[]}
 */
function openBefore(gates, wave) {
  return gates
    .filter((g) => g.status === 'open' && (wave === undefined || compareWaves(g.before, wave) <= 0))
    .sort(
      (a, b) =>
        LEAD_RANK[a.leadTime] - LEAD_RANK[b.leadTime] ||
        compareWaves(a.before, b.before) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
// @bundle-end gates
// @bundle-start reality
// generated from claude/lib/reality.js by scripts/bundle-workflows.js: do not edit
// Reality gate runner: runs a project's read-only reality check and reads its contract JSON.
// Pure apart from the injected `exec`; the caller treats `ok: false` as a `block`.

/**
 * @typedef {Object} RealityConfig
 * @property {string} command      shell command that prints the contract JSON and exits 0
 * @property {true} readOnly       must be exactly true; the runner refuses otherwise
 * @property {number} [timeoutSec] default 60
 *
 * @typedef {Object} ExecResult
 * @property {number} code         process exit code
 * @property {string} stdout
 * @property {boolean} [timedOut]  true when the command was killed for exceeding the timeout
 *
 * @typedef {Object} Gap
 * @property {string} id
 * @property {'block'|'warn'} severity
 * @property {string} what
 *
 * @typedef {{ ok: true, gaps: Gap[], blocking: Gap[] } | { ok: false, error: string, gaps: [] }} RealityResult
 */

const DEFAULT_TIMEOUT_SEC = 60;
const SEVERITIES = ['block', 'warn'];

/**
 * Check parsed JSON against the contract `{ gaps: [{ id, severity, what }] }`.
 * @param {unknown} value
 * @returns {string|null} the problem, or null when valid
 */
function contractProblem(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'output is not a JSON object';
  }
  const gaps = /** @type {{ gaps?: unknown }} */ (value).gaps;
  if (!Array.isArray(gaps)) return 'output has no "gaps" array';
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    if (g === null || typeof g !== 'object' || Array.isArray(g)) return `gaps[${i}] is not an object`;
    if (typeof g.id !== 'string' || g.id === '') return `gaps[${i}].id is not a non-empty string`;
    if (!SEVERITIES.includes(g.severity)) return `gaps[${i}] (${g.id}) has severity other than block or warn`;
    if (typeof g.what !== 'string') return `gaps[${i}] (${g.id}).what is not a string`;
  }
  return null;
}

/** @param {string} error @returns {RealityResult} */
function failed(error) {
  return { ok: false, error, gaps: [] };
}

/**
 * Run the reality check.
 * Throws (a configuration error, not a check outcome) when `cfg.readOnly !== true`.
 * Every other failure resolves to `{ ok: false, error, gaps: [] }`, which the caller treats as a block.
 * @param {RealityConfig} cfg
 * @param {(command: string, timeoutSec: number) => ExecResult | Promise<ExecResult>} exec
 * @returns {Promise<RealityResult>}
 */
async function runReality(cfg, exec) {
  if (!cfg || cfg.readOnly !== true) {
    throw new Error('reality check refused: realityCheck.readOnly must be true');
  }
  if (typeof cfg.command !== 'string' || cfg.command.trim() === '') {
    throw new Error('reality check refused: realityCheck.command is missing');
  }
  const timeoutSec =
    typeof cfg.timeoutSec === 'number' && cfg.timeoutSec > 0 ? cfg.timeoutSec : DEFAULT_TIMEOUT_SEC;

  /** @type {ExecResult} */
  let res;
  try {
    res = await exec(cfg.command, timeoutSec);
  } catch (e) {
    return failed(`reality command could not run: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.timedOut) return failed(`reality command timed out after ${timeoutSec}s`);
  if (res.code !== 0) return failed(`reality command exited with code ${res.code}`);

  // Strict: the whole of stdout (surrounding whitespace aside) must be the JSON object.
  let parsed;
  try {
    parsed = JSON.parse(String(res.stdout));
  } catch (e) {
    return failed(`reality command output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const problem = contractProblem(parsed);
  if (problem) return failed(`reality command output breaks the contract: ${problem}`);

  const gaps = parsed.gaps;
  return { ok: true, gaps, blocking: gaps.filter((/** @type {Gap} */ g) => g.severity === 'block') };
}
// @bundle-end reality
// @bundle-start envelope
// generated from claude/lib/envelope.js by scripts/bundle-workflows.js: do not edit
// Decision envelope: decides whether a recommendation is auto-accepted by the loop or goes to a human.
// Pure functions, no I/O. The rules are the spec section "Decision envelope".

/**
 * @typedef {Object} Rec
 * @property {string} id
 * @property {string} text
 * @property {string} evidence        a quote, fixture, source or command output; an opinion is not evidence
 * @property {string} reverseCost
 * @property {string} wouldBeWrongIf  what observation would show the recommendation is wrong
 * @property {boolean} reversible     true only if one revert PR or one config edit undoes it
 * @property {number} costCents       integer cents
 * @property {string[]} touches       'invariant', 'fixed_decision' or any other string
 * @property {string} category
 */

/**
 * @typedef {Object} Classification
 * @property {'accept'|'ask'} decision
 * @property {string} reason
 */

/**
 * @typedef {Object} LedgerEntry
 * @property {string} [id]
 * @property {'accept'|'ask'} [decision]
 * @property {string|null} [reversedBy]  set when a later decision or PR reversed this one
 * @property {boolean} [failed]
 */

/**
 * Categories a human always decides, from the spec: spending money or raising a cap; creating,
 * rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording;
 * irreversible production steps (schema migrations on a real database, sends, deletes, DNS);
 * changing a fixed decision or invariant. Written in normalised form (see normaliseCategory).
 */
const HUMAN_ONLY_CATEGORIES = Object.freeze([
  'money',
  'spend',
  'cost_cap',
  'secret',
  'secrets',
  'account',
  'accounts',
  'quota',
  'quotas',
  'vendor_plan',
  'vendor_plans',
  'legal',
  'privacy',
  'irreversible_production',
  'schema_migration',
  'send',
  'sends',
  'delete',
  'dns',
  'fixed_decision',
  'invariant',
]);

/** Touch values that always need a human, whatever else is true. */
const PROTECTED_TOUCHES = ['invariant', 'fixed_decision'];

/**
 * Lower-case, trim, and turn runs of spaces and hyphens into one underscore, so
 * 'Vendor-Plan', 'vendor plan' and ' vendor_plan ' are the same category.
 * @param {unknown} value
 * @returns {string}
 */
function normaliseCategory(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

/** @param {unknown} value */
function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

/** @param {unknown} value */
function isCents(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Classify a recommendation. It is accepted only when every envelope condition holds; otherwise
 * it is asked, and the reason names every rule that failed.
 * @param {Rec|null|undefined} rec
 * @param {{ envelope?: { maxCostCents?: number, humanOnly?: string[] } }} [project]
 * @returns {Classification}
 */
function classify(rec, project) {
  if (rec === null || typeof rec !== 'object') {
    return { decision: 'ask', reason: 'no recommendation to classify' };
  }
  const envelope = project?.envelope ?? {};
  const cap = isCents(envelope.maxCostCents) ? envelope.maxCostCents : 0;
  const extra = Array.isArray(envelope.humanOnly) ? envelope.humanOnly.map(normaliseCategory) : [];
  const humanOnly = new Set([...HUMAN_ONLY_CATEGORIES, ...extra].filter(Boolean));

  const failed = [];

  if (isBlank(rec.evidence)) failed.push('evidence is empty (an opinion is not evidence)');
  if (isBlank(rec.wouldBeWrongIf)) failed.push('wouldBeWrongIf is empty (no way to tell it is wrong)');
  if (rec.reversible !== true) failed.push('not reversible by one revert PR or one config edit');

  if (!isCents(rec.costCents)) {
    failed.push('cost is not a non-negative integer number of cents');
  } else if (rec.costCents > cap) {
    failed.push(`cost ${rec.costCents} cents is over the cap of ${cap} cents`);
  }

  const touches = Array.isArray(rec.touches) ? rec.touches.map(normaliseCategory) : [];
  for (const t of PROTECTED_TOUCHES) {
    if (touches.includes(t)) failed.push(`touches ${t}`);
  }

  const category = normaliseCategory(rec.category);
  if (humanOnly.has(category)) failed.push(`category ${category} is human-only`);

  if (failed.length > 0) return { decision: 'ask', reason: failed.join('; ') };

  const costNote = rec.costCents === 0 ? 'no cost' : `cost ${rec.costCents} cents within the cap of ${cap}`;
  return {
    decision: 'accept',
    reason: `inside the envelope: evidence given, reversible, ${costNote}, touches no invariant or fixed decision, category ${category || 'none'} is not human-only`,
  };
}

/**
 * Summarise a decision log. Reversal rate is reversed / all decisions, 0 for an empty log.
 * @param {LedgerEntry[]} decisions
 * @returns {{ accepted: number, asked: number, reversed: number, failures: number, reversalRate: number }}
 */
function ledger(decisions) {
  if (!Array.isArray(decisions)) throw new TypeError('ledger: decisions must be an array');
  let accepted = 0;
  let asked = 0;
  let reversed = 0;
  let failures = 0;
  for (const d of decisions) {
    if (d?.decision === 'accept') accepted += 1;
    else if (d?.decision === 'ask') asked += 1;
    if (d?.reversedBy) reversed += 1;
    if (d?.failed === true) failures += 1;
  }
  const reversalRate = decisions.length === 0 ? 0 : reversed / decisions.length;
  return { accepted, asked, reversed, failures, reversalRate };
}
// @bundle-end envelope
// @bundle-start ci
// generated from claude/lib/ci.js by scripts/bundle-workflows.js: do not edit
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

const CI_POLL_MS = 20000
const CI_TIMEOUT_MS = 20 * 60 * 1000
const CI_MISSING_MS = 2 * 60 * 1000
const CI_LOG_TAIL_CHARS = 3000

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
async function waitForCi(prNumber, exec, opts) {
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
function combineVerdict(criticVerdict, ci) {
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
// @bundle-end ci
// @bundle-start lane
// generated from claude/lib/lane.js by scripts/bundle-workflows.js: do not edit
// Fast-lane check: decides whether a task may skip the critic. Pure functions, no I/O: the workflow
// supplies every input (changed files, added diff text, test counts, Decisions lines, the CI result),
// the worker reports none of them. The rules are the spec's "Fast lane" fixed decision.
// The path matcher here also serves the critic's owned-paths check.


/**
 * @typedef {Object} FastLaneConfig
 * @property {boolean} [enabled]          default false; a human turns it on per project
 * @property {string[]} [denyPaths]       path patterns no fast-lane task may touch (default DEFAULT_DENY_PATHS)
 * @property {number} [maxPerWave]        default 3
 * @property {string} [testCountCommand]  prints the test count; none configured means not eligible
 */

/**
 * @typedef {Object} LaneInput
 * @property {{ id?: string, lane?: string, owns?: string[]|string }} task
 * @property {string[]} changedFiles     from `gh pr view --json files`
 * @property {string} addedText          added lines of `gh pr diff`
 * @property {string[]|string} decisions the PR body's `Decisions:` lines (id | choice | reason | reversible)
 * @property {{ forbiddenStrings?: string[], fastLane?: FastLaneConfig }} project
 * @property {{ state?: string }} ci     the waitForCi result
 * @property {{ before: number, after: number }} testCount  from fastLane.testCountCommand on the default branch and on the PR head
 * @property {number} laneUsedInWave     fast-lane tasks already taken in this wave
 */

const DEFAULT_MAX_PER_WAVE = 3;

/**
 * Used when the project sets no fastLane.denyPaths: the loop's own workflow files, hookify rules and
 * agent prompts, plus CI definitions. A project that sets denyPaths replaces this list.
 */
const DEFAULT_DENY_PATHS = Object.freeze([
  'claude/workflows/',
  'claude/agents/',
  'claude/hookify.*',
  '.claude/',
  '.github/workflows/',
]);

/** @param {string} p repo-relative path with forward slashes and no leading './' */
function cleanPath(p) {
  let s = String(p).trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/\/{2,}/g, '/');
}

/** True for paths that must never match anything: absolute, or with a '..' segment. */
function escapes(p) {
  return p.startsWith('/') || p.split('/').includes('..');
}

/** @param {string} pattern */
function patternToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += '[^/]*';
      }
    } else {
      source += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}(?:/.*)?$`);
}

/**
 * The one path matcher. `pattern` is a path prefix made of whole segments: 'scripts/' and 'scripts'
 * both cover everything under scripts/, 'scripts/a.js' covers that file (not 'scripts/a.js.bak'), and
 * '*' inside a segment is a wildcard ('claude/hookify.*', 'tests/fixtures/timings-*.json'; '**'
 * crosses segments). Absolute paths, '..' segments and empty patterns never match.
 * @param {string} file
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesPath(file, pattern) {
  const f = cleanPath(file);
  const p = cleanPath(pattern).replace(/\/+$/, '');
  if (f === '' || p === '' || p === '.' || escapes(f) || escapes(p)) return false;
  return patternToRegExp(p).test(f);
}

/**
 * Owns as the spec writes it is either a list of path prefixes or the task's prose with the paths in
 * backticks; both give a list of patterns.
 * @param {string[]|string|undefined|null} owns
 * @returns {string[]}
 */
function parseOwns(owns) {
  if (Array.isArray(owns)) return owns.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  if (typeof owns !== 'string') return [];
  const ticked = [...owns.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
  if (ticked.length > 0) return ticked;
  return owns.split(/[,\s]+/).map((x) => x.replace(/[.;]+$/, '')).filter(Boolean);
}

/**
 * Files that no Owns entry covers. Serves the fast-lane check and the critic's owned-paths check.
 * @param {string[]} files
 * @param {string[]|string} owns
 * @returns {string[]}
 */
function filesOutsideOwns(files, owns) {
  const patterns = parseOwns(owns);
  return (files || []).filter((f) => !patterns.some((p) => matchesPath(f, p)));
}

/** Decisions: lines of `id | choice | reason | reversible`, with list markers, blanks and the heading ignored. */
function decisionLines(decisions) {
  const raw = Array.isArray(decisions) ? decisions : typeof decisions === 'string' ? decisions.split(/\r?\n/) : [];
  return raw
    .map((l) => String(l).trim().replace(/^[-*]\s+/, ''))
    .filter((l) => l !== '' && !/^decisions:?$/i.test(l) && !/^(none|n\/a)\.?$/i.test(l));
}

const HUMAN_ONLY_WORDS = HUMAN_ONLY_CATEGORIES
  // 'invariant' and 'fixed_decision' appear in benign sentences ("touches no invariant"); the deny
  // paths and the forbidden strings guard those, and the critic's STOP rule still applies elsewhere.
  .filter((c) => c !== 'invariant' && c !== 'fixed_decision')
  .map((c) => c.replace(/_/g, ' '));

/**
 * Check the PR's Decisions lines against the envelope (claude/lib/envelope.js). A line carries no
 * category, cost or touches, so those are checked from what it does carry: it must be readable,
 * reversible, give a reason, and name no human-only category as a whole word.
 * @returns {string|null} the first problem, or null
 */
function decisionProblem(decisions) {
  for (const line of decisionLines(decisions)) {
    const parts = line.split('|').map((x) => x.trim());
    if (parts.length !== 4 || !parts[0] || !parts[1]) {
      return `Decisions line cannot be read as "id | choice | reason | reversible": "${line}"`;
    }
    const [id, choice, reason, reversible] = parts;
    const verdict = classify({
      id,
      text: choice,
      evidence: reason,
      // The line has no field for it; CI and the default-branch check are the observation that would show it wrong.
      wouldBeWrongIf: 'CI or the check on the default branch fails',
      reverseCost: 'one revert PR',
      reversible: /^(true|yes|y)$/i.test(reversible),
      costCents: 0,
      touches: [],
      category: '',
    });
    if (verdict.decision !== 'accept') return `decision ${id} is outside the envelope: ${verdict.reason}`;
    const text = `${choice} ${reason}`.toLowerCase();
    const hit = HUMAN_ONLY_WORDS.find((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(text));
    if (hit) return `decision ${id} is outside the envelope: it names the human-only category "${hit}"`;
  }
  return null;
}

/**
 * Decide whether a task may take the fast lane (skip the critic).
 * @param {LaneInput} input
 * @returns {{ eligible: boolean, reason: string }}
 */
function fastLaneEligible(input) {
  const { task, changedFiles, addedText, decisions, project, ci, testCount, laneUsedInWave } = input || {};
  const no = (reason) => ({ eligible: false, reason });
  const cfg = project?.fastLane ?? {};

  if (cfg.enabled !== true) return no('fastLane.enabled is not true for this project');
  if (task?.lane !== 'fast') return no('the task is not marked Lane: fast (default normal)');

  const cap = Number.isInteger(cfg.maxPerWave) && cfg.maxPerWave >= 0 ? cfg.maxPerWave : DEFAULT_MAX_PER_WAVE;
  const used = Number.isInteger(laneUsedInWave) && laneUsedInWave > 0 ? laneUsedInWave : 0;
  if (used >= cap) return no(`the per-wave fast-lane cap is reached (${used} of ${cap})`);

  if (typeof cfg.testCountCommand !== 'string' || cfg.testCountCommand.trim() === '') {
    return no('no fastLane.testCountCommand is configured, so the test count cannot be compared');
  }

  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length === 0) return no('no changed files were reported for the PR');

  const outside = filesOutsideOwns(files, task.owns);
  if (outside.length > 0) return no(`changed files outside Owns: ${outside.join(', ')}`);

  const deny = Array.isArray(cfg.denyPaths) ? cfg.denyPaths : DEFAULT_DENY_PATHS;
  const denied = files.filter((f) => deny.some((p) => matchesPath(f, p)));
  if (denied.length > 0) return no(`changed files under denyPaths: ${denied.join(', ')}`);

  const haystack = String(addedText ?? '').toLowerCase();
  const forbidden = (project?.forbiddenStrings ?? []).filter((s) => typeof s === 'string' && s !== '' && haystack.includes(s.toLowerCase()));
  if (forbidden.length > 0) return no(`the added text contains a forbidden string: ${forbidden.join(', ')}`);

  if (ci?.state !== 'green') return no(`CI is not green (${ci?.state ?? 'no result'})`);

  const { before, after } = testCount ?? {};
  if (!Number.isFinite(before) || !Number.isFinite(after)) return no('the test count is missing or not a number');
  if (after < before) return no(`test count fell from ${before} to ${after}`);

  const problem = decisionProblem(decisions);
  if (problem) return no(problem);

  return {
    eligible: true,
    reason: `fast lane: ${files.length} file(s) inside Owns, none denied, no forbidden string, CI green, test count ${before} to ${after}, decisions inside the envelope (${used + 1} of ${cap} this wave)`,
  };
}
// @bundle-end lane

// Full model ids, so the scorecard baseline cannot drift (verified on the Workflow runtime 2026-11-01).
const DEFAULT_MODELS = {
  worker: { model: 'claude-sonnet-5-5', effort: 'high' },
  critic: { model: 'claude-fable-5-1', effort: 'high' },
  merger: { model: 'claude-sonnet-5-5', effort: 'low' },
}
const MODELS = { ...DEFAULT_MODELS, ...(P.models || {}) }
// The reality check only runs a shell command and returns its output; its result is read by deterministic code.
const REALITY_MODEL = { model: 'claude-haiku-5-5', effort: 'low', ...((P.models || {}).reality || {}) }
// A critic that hits a usage limit is retried once on this model, and later critics start on it.
const CRITIC_FALLBACK = { model: 'opus', effort: 'high' }

const NAME = P.name
const LOOP_VERSION = '2.2.2'
const REPO = P.repo
const WT = P.worktrees
const SPEC = P.spec
const INSTALL = P.install || 'npm ci'
const CHECK = P.check || 'npm run check'
const TRAILER = P.trailer || 'Co-Authored-By: Claude <noreply@anthropic.com>'
const MAX_BUILDERS = P.maxBuilders || 2 // machine-wide check slots (memory bound)
const MAX_CHAINS = P.maxChains || 6 // task chains in flight at once (worker, critic, merger)
const SLOT = `SLOT_MAX=${MAX_BUILDERS} ${REPO}/.claude/slot.sh `
const INSTALL_CMD = SLOT + INSTALL
const CHECK_CMD = SLOT + CHECK
const MAIN_CI = P.mainCi || '' // name of the CI workflow that runs the check on pushes to main; empty = merger runs the check locally
const SYNC_POLICY = P.syncPolicy || 'always' // 'always': merge main into the branch before merging; 'conflict': only when GitHub reports a conflict
const FIX_ROUNDS = P.fixRounds || 3
// Rounds that send a worker back to finish a check it returned before (see finishIfUnfinished).
const FINISH_ROUNDS = P.finishRounds || 2
// v2.1: project.quickCheck is what a worker runs instead of the full check (CI runs the full check on the PR). It is a shell
// command run in the worktree; {files} is replaced by the worker with the files it changed. Unset keeps the v2 prompts.
const QUICK_CHECK = typeof P.quickCheck === 'string' ? P.quickCheck.trim() : ''
const LOCAL_CHECK_NAME = QUICK_CHECK ? 'the quick check' : CHECK // how worker-facing text and logs name the worker's own check
const CHECK_WAIT = `If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked.`
// What the worker prompts say about the quick check. The workflow has no clock, so the worker times the check.
// The quick check runs through the slot wrapper (machine-wide check slots): wave 12's 12.1 worker ran its tests beside
// a rescue's full checks at a load average of 200 to 480 and took 58.9 min against 25.7 min for a task of its size.
const QUICK_RULE = `The quick check is: ${QUICK_CHECK} ({files} is replaced by you with the files you changed, space separated, relative to the worktree). Run it in the worktree through the machine-wide slot wrapper, so its tests count against the check slots every session on this machine shares: ${SLOT}sh -c '<the quick check, files filled in>' (write any single quote inside it as '\\''). The wrapper waits for a free slot, so the command can take several minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy. Do not run the full check (${CHECK}) yourself. CI runs the full check on the PR and that satisfies a project rule such as 'a change is done when \`${CHECK}\` exits 0'. Time the quick check (slot wait included) with date +%s before and after and set localCheckMs in your result to the elapsed milliseconds (an integer). Set checkCommand to the quick check as you ran it (files filled in) and checkExitCode to its exit code.`
// readFirst entries: a plain string is read as written (a whole file, or free text such as 'spec.md section "X"').
// An entry that names sections, as 'CONTRACT.md#Owner map#Schema' or { path, sections: [...] }, is read only in those
// sections plus the sections the task names: CONTRACT.md grew to 69 KB and was re-read on every worker turn (wave 12).
function readFirstEntry(e) {
  let path = ''
  let sections = []
  if (e && typeof e === 'object') {
    path = String(e.path || '')
    sections = Array.isArray(e.sections) ? e.sections.map(String) : []
  } else {
    const parts = String(e).split('#').map((x) => x.trim())
    path = parts[0]
    sections = parts.slice(1).filter(Boolean)
  }
  if (!sections.length) return path
  return `${path} (only the sections ${sections.map((x) => `"${x}"`).join(', ')} and the sections your task names; find them with grep -n '^#' ${path} and read just those line ranges, never the whole file)`
}
const READ_FIRST = (P.readFirst && P.readFirst.length ? P.readFirst : ['CLAUDE.md']).map(readFirstEntry).join('; ')
const FORBIDDEN = (P.forbiddenStrings || []).length ? ` No project-confidential strings (${P.forbiddenStrings.join(', ')}).` : ''
const EXTRA_RULES = (P.extraRules || []).length ? ' ' + P.extraRules.join(' ') : ''
const SIDE_FILES = P.sideFiles || 'No generated files are expected to change beyond what the task touches.'
const SIDE_FILES_SHORT = P.sideFiles ? `the side files the project allows (${P.sideFiles})` : 'nothing else'
// Edits outside a task's owned files follow the project's own rule (its CLAUDE.md or another readFirst file). Six stops
// in waves 6 to 12 of Pilot were 1-to-20-line test, replay or generated-file edits the task's own change forced.
const OUTSIDE_EDITS = 'Edits outside owned files'
const OWN_RULE = `Edits outside these paths follow the project's own rule on them (in the read-first files). If that rule allows small mechanical edits outside a task's files (for example to a test, replay script or generated block that breaks only because of your change), make each edit it allows, within its limit and with no assertion removed or weakened, and list each one under "${OUTSIDE_EDITS}" in the PR body (file, lines changed, and why your change forces it) instead of stopping. Anything else outside your paths, or any outside edit when the project has no such rule, is an ownership question: do not edit it; stop (status blocked) and report it in the PR body.`
const SYNC_CONFLICTS = P.syncConflicts
  ? `Resolve conflicts only in ${P.syncConflicts}. Any other conflict: stop, report it in the PR body, and set status blocked.`
  : 'Any conflict: stop, report it in the PR body, and set status blocked.'
const CHECK_MUTATES = P.checkMutates || []
const CRITIC_EXTRA = P.criticChecks || []
const WORKER_NOTES = P.workerNotes || ''
const PROJECT_NOTES = P.notes || ''
const WAVE = String(args.wave)
const TASKS = args.tasks || []
const TAIL = args.tail || null
const REALITY_CHECK = P.realityCheck || null
// v2.1: CI and the merge are scripts in the loop checkout, each run by one relay agent.
const SCRIPTS = P.loopScripts || `${REPO}/.claude/scripts`
const MERGER_AGENT = P.merger === 'agent' // the v2 merger agent, kept as the rollback
const FAST_LANE = P.fastLane || {}
// A fast-lane task needs a test-count command; without one nothing is eligible, so such a task keeps the normal path.
const FAST_LANE_ON = FAST_LANE.enabled === true && typeof FAST_LANE.testCountCommand === 'string' && FAST_LANE.testCountCommand.trim() !== ''
const FAST_LANE_CAP = Number.isInteger(FAST_LANE.maxPerWave) && FAST_LANE.maxPerWave >= 0 ? FAST_LANE.maxPerWave : DEFAULT_MAX_PER_WAVE
const CI_RELAY_MAX_MIN = 9 // one foreground relay call (Bash max 10 min) must be able to finish; 'pending' handling covers slower CI
const CI_CHUNK_MIN = 1.5 // one relay call waits at most this long: well under the Bash tool's 120 s default timeout
const CI_MISSING_MIN = 2 // wait-ci.js reports 'missing' after 2 minutes without a real check (CI_MISSING_MS in claude/lib/ci.js)
const CI_FIX_WAIT_MIN = 5 // on a FIX verdict the workflow waits at most this long for a CI result still running
const CI_TIMEOUT_NOTE = 'the 20-minute wait-ci.js timeout'

// Before anything starts: a bad reality config or gate list fails now, not after a whole wave has run.
if (REALITY_CHECK) {
  if (REALITY_CHECK.readOnly !== true) throw new Error('args.project.realityCheck.readOnly must be true: the reality check must be read-only.')
  if (typeof REALITY_CHECK.command !== 'string' || REALITY_CHECK.command.trim() === '') throw new Error('args.project.realityCheck.command is missing.')
}
if (args.gates === undefined && P.gates) {
  throw new Error(`args.gates is missing: read ${P.gates} (project.gates), parse it and pass the array as args.gates. A project with gates configured never runs a wave unchecked.`)
}
if (args.gates !== undefined) {
  const open = openBefore(loadGates(args.gates), WAVE)
  if (open.length) {
    log(`Wave ${WAVE} BLOCKED by open gate items: ${open.map((g) => g.id).join(', ')}`)
    return {
      project: NAME,
      wave: WAVE,
      gate: 'BLOCKED',
      blockedBy: open.map((g) => g.id),
      blocked: open.map((g) => ({ id: g.id, what: g.what, before: g.before, leadTime: g.leadTime })),
      models: MODELS,
      state: {},
      tasks: {},
      escalations: [],
      reality: null,
      decisions: [],
    }
  }
}

const COMMON_RULES = `
Repository: ${REPO} (GitHub ${P.github}, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in ${REPO}.
Read first: ${READ_FIRST}; then the wave ${WAVE} section of ${SPEC} and anything your task names.
Hard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). Do not start background processes. No secrets, no real people, no street addresses in the repo.${FORBIDDEN}${EXTRA_RULES}
${SIDE_FILES}
Commit messages end with exactly this line, even if a session reminder names a different model: ${TRAILER}
The commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message "Sync branch with upstream before merge" and never write the default branch's name in a git commit or git push command.
${PROJECT_NOTES}
`

const SYNC_STEP = `Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m "Sync branch with upstream before merge" -m "${TRAILER}". ${SYNC_CONFLICTS} Commit the merge and push with a plain git push.`

// Task 4.2: what a worker may decide alone. The spec's End goal, Budget and Decision envelope sections are read by the
// worker itself (scripts have no filesystem), so a project spec without them still works.
const AUTONOMY = `Autonomy: before starting, READ the sections 'End goal', 'Budget' and 'Decision envelope' of ${SPEC} if present (a spec without them still works: then decide only what the conventional default settles). They bound what you may decide yourself.
Inside the envelope, decide: take the choice and do not ask. Outside it, stop and ask (status blocked, the question in questions, and the PR opened as a draft with what you have). A choice is inside the envelope only when all hold: it is reversible by one revert PR or one config edit; it costs nothing or is under the project's cost cap; it touches no project invariant and no fixed decision; it is not in a human-only category (spending money or raising a cap; creating, rotating or sharing a secret; accounts, quotas and vendor plans; legal or privacy wording; irreversible production steps; changing a fixed decision or invariant; plus any extra human-only categories the spec names).
Write each decision in the PR body under \`Decisions:\`, one line per decision, exactly as: id | choice | reason | reversible (id is a short label such as D1; reversible is yes or no; no "|" inside a field). Return the same lines in the decisions array of your structured result. On a later round, add new lines to that block (gh pr edit) instead of replacing it.
When you stop and ask, name the envelope rule the choice fell outside (reversible, cost, invariant or fixed decision, or the human-only category) in each question, so the escalation says why a human is needed.
A decision the critic has already failed once, whose replacement also fails, is not decided a third time: stop (status blocked) and ask, naming the decision id and that it failed twice.
You may spawn read-only research or spike subagents (they edit no file and run no write command) to settle an external fact before you decide.`

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['opened', 'blocked'] },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    prNumber: { type: 'integer' },
    prUrl: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    checkCommand: { type: 'string' },
    checkExitCode: { type: 'integer' },
    localCheckMs: { type: 'integer' },
    checkOutputTail: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'branch', 'worktree', 'filesChanged', 'checkCommand', 'checkExitCode', 'decisions', 'questions'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['MERGE', 'FIX', 'STOP'] },
    prHeadSha: { type: 'string' },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'integer' }, pass: { type: 'boolean' }, evidence: { type: 'string' } },
        required: ['item', 'pass', 'evidence'],
      },
    },
    fixItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          what: { type: 'string' },
          provedBy: { type: 'string' },
          cause: {
            type: 'string',
            enum: ['defect', 'spec_miss', 'loop'],
            description: 'defect = wrong code or test; spec_miss = the spec said otherwise and the worker did not follow it; loop = CI, merge or tooling artefact, not the worker',
          },
        },
        required: ['n', 'what', 'provedBy', 'cause'],
      },
    },
    stopSection: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['verdict', 'checklist', 'fixItems', 'notes'],
}

const REALITY_SCHEMA = {
  type: 'object',
  properties: {
    stdout: { type: 'string' },
    code: { type: 'integer' },
    timedOut: { type: 'boolean' },
  },
  required: ['stdout', 'code'],
}

const MERGER_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['merged', 'reverted', 'failed'] },
    mergeSha: { type: 'string' },
    mainSha: { type: 'string' },
    checkOnMainExitCode: { type: 'integer' },
    checkOnMainTail: { type: 'string' },
    revertPrUrl: { type: 'string' },
    details: { type: 'string' },
  },
  required: ['outcome', 'details'],
}

// A relay agent runs exactly one command and returns what it printed; the workflow reads the JSON line itself.
const RELAY_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ran', 'blocked'] },
    exitCode: { type: 'integer' },
    stdout: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['status'],
}

// The fast-lane facts the workflow cannot read itself (it has no shell). Test counts come back as the command's raw
// output and are parsed in code.
const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ran', 'blocked'] },
    changedFiles: { type: 'array', items: { type: 'string' } },
    addedText: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    testCountBeforeOut: { type: 'string' },
    testCountAfterOut: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['status'],
}

function wtPath(t) {
  return `${WT}/${t.id}`
}

function workerPrompt(t) {
  return `You are a worker on the ${NAME} repository. ${COMMON_RULES}
Task ${t.id}: ${t.title}.
Task text (verbatim from the spec): ${t.text}
You own only: ${t.owns}. ${OWN_RULE}
Task notes: ${t.notes || 'none'}
${WORKER_NOTES}
${AUTONOMY}

Worktree: cd ${REPO} && git fetch origin && git worktree add ${wtPath(t)} -b ${t.branch} origin/main. Then work ONLY inside ${wtPath(t)} (cd there; run ${INSTALL_CMD} there first). Never run git checkout in ${REPO}.
Order: (1) write the acceptance test exactly as specified and commit it first, confirming it fails for the right reason before the implementation exists; (2) implement; (3) ${
    QUICK_CHECK
      ? `run the quick check once in the worktree and keep the output. ${QUICK_RULE} ${CHECK_WAIT}`
      : `run ${CHECK_CMD} once in the worktree and keep the output (the slot wrapper waits for a free check slot on this machine, so the command can take up to 15 minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy; ${CHECK_WAIT});`
  } (4) commit in small steps; (5) ${SYNC_STEP} (6) git push -u origin ${t.branch} and open a PR with gh pr create titled "${t.id}: ${t.title}" whose body lists files changed, the exact test command and its output tail, a "Decisions" list for every default you took where the spec left a detail open, and open questions.
Where the spec leaves a detail open, take the conventional default and list it under Decisions. Stop (status: blocked) if two readings of the spec would lead to materially different work or if a choice falls outside the envelope; then list the question and still open the PR as a draft with what you have.
Return the structured result with worktree set to ${wtPath(t)}. Leave the branch pushed and the worktree in place; do not merge.`
}

function fixPrompt(t, prev, critic, round) {
  const items = critic.fixItems.map((i) => `${i.n}. ${i.what} (proved by: ${i.provedBy})`).join('\n')
  return `You are a worker on the ${NAME} repository continuing task ${t.id}: ${t.title}, fix round ${round} of ${FIX_ROUNDS}. ${COMMON_RULES}
Task text: ${t.text}
You own only: ${t.owns}. ${OWN_RULE} Task notes: ${t.notes || 'none'}
${WORKER_NOTES}
${AUTONOMY}
Your PR: #${prev.prNumber} ${prev.prUrl || ''} on branch ${prev.branch}. Your worktree is ${prev.worktree || wtPath(t)}; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd ${REPO} && git fetch origin && git worktree add ${wtPath(t)} ${t.branch}.
The critic returned FIX with these numbered items; fix every one and nothing else:
${items}
Critic notes: ${critic.notes}
${
    QUICK_CHECK
      ? `Run the quick check once after the fixes. ${QUICK_RULE} ${CHECK_WAIT} Commit in small steps.`
      : `Run ${CHECK_CMD} once after the fixes (up to 15 minutes including the slot wait; maximum Bash timeout, and if the tool moves it to the background wait for its notification; ${CHECK_WAIT}), commit in small steps.`
  } ${SYNC_STEP} Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.`
}

// A worker that returns before its check has finished (checkExitCode -1) is sent back to finish it, at most
// FINISH_ROUNDS times, instead of being escalated. Wave 5 of Pilot (28 Oct 2026) lost a whole relaunch to this:
// nine tasks queued on two check slots and a sleeping laptop made two workers give up and report "blocked".
function checkUnfinished(w) {
  return !!w && typeof w.checkExitCode === 'number' && w.checkExitCode < 0
}

function finishPrompt(t, prev, attempt) {
  const pr = prev.prNumber
    ? `Your PR: #${prev.prNumber} ${prev.prUrl || ''}; if it is a draft, mark it ready with gh pr ready ${prev.prNumber} once the check passes.`
    : 'No PR exists yet; step (4) opens it.'
  return `You are a worker on the ${NAME} repository finishing task ${t.id}: ${t.title} (finish attempt ${attempt} of ${FINISH_ROUNDS}). ${COMMON_RULES}
Task text: ${t.text}
You own only: ${t.owns}. ${OWN_RULE} Task notes: ${t.notes || 'none'}
${WORKER_NOTES}
${AUTONOMY}
The previous worker on this task returned before ${LOCAL_CHECK_NAME} had finished, so nothing has been reviewed. Branch ${prev.branch || t.branch}, worktree ${prev.worktree || wtPath(t)}; cd there (if the worktree is missing: cd ${REPO} && git fetch origin && git worktree add ${wtPath(t)} ${t.branch}). ${pr}
Its open questions were: ${(prev.questions || []).join('; ') || 'none'}. Answer each by taking the conventional default and listing it under Decisions, unless two readings of the spec would lead to materially different work.
Steps: (1) make sure every change is committed; (2) ${
    QUICK_CHECK
      ? `run the quick check once and wait for it to finish. ${QUICK_RULE} If the Bash tool moves it to the background, wait for its completion notification and read its output; you may not return while it runs;`
      : `run ${CHECK_CMD} once and wait for it to finish: with the slot wait it can take 15 minutes; use the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output; you may not return while it runs;`
  } (3) if it fails, fix the cause inside the files you own and run it again, at most twice; (4) ${SYNC_STEP} Push, and if no PR exists open it with gh pr create titled "${t.id}: ${t.title}", its body listing files changed, the check command and output tail, Decisions and open questions.
Return the structured result with the real exit code of the last check. Set status blocked for a genuine ambiguity in the spec or a choice outside the envelope, and for nothing else, never for a slow or unfinished check.`
}

async function finishIfUnfinished(t, w, ph, tag) {
  for (let attempt = 1; attempt <= FINISH_ROUNDS && checkUnfinished(w); attempt++) {
    log(`${t.id}: worker returned before ${LOCAL_CHECK_NAME} finished (${tag}); finish attempt ${attempt}`)
    const next = await callWorker(t, finishPrompt(t, w, attempt), { label: `worker:${t.id} finish${attempt}`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
    if (!next) return w
    w = { ...next, prNumber: next.prNumber || w.prNumber, prUrl: next.prUrl || w.prUrl, branch: next.branch || w.branch, worktree: next.worktree || w.worktree }
  }
  if (checkUnfinished(w)) w = { ...w, status: 'blocked' }
  return w
}

function criticChecklist() {
  const core = [
    `The acceptance test exists and its commit precedes the implementation commits. Verify "fails on main" by checking that the paths or behaviour the test exercises do not exist at the PR's merge-base (git cat-file -e origin/main:<path>, or reasoning from the diff). Every test that asserts a rejection, refusal, quarantine or error also has a positive control in the same file: the same function, called the same way, accepting the unaltered valid input. A negative-only test passes for the wrong reason when arguments are swapped or a path does not exist (a 50-case mutation test in another project passed this way); a missing control fails this item.`,
    `Only owned paths changed (plus ${SIDE_FILES_SHORT} and merge commits from origin/main), apart from the files listed under "${OUTSIDE_EDITS}" in the PR body when the project's rules (in its read-first files) allow such edits. Check each listed edit: it is mechanical (it only follows the task's own change, such as a renamed key or call, a new required argument, an updated expected string or a regenerated block), it is within the project's limit, and it removes or weakens no assertion (no deleted or loosened expect, no deleted test case, no widened tolerance). A listed edit that fails any of these, or any other changed file outside the owned paths, fails this item.`,
    `No test touches the network or a paid API; no .skip, .only, or disabled test, and no lowered test count.`,
    `No street address, real person, secret${FORBIDDEN ? ' or project-confidential string' : ''} anywhere in the diff.`,
    `CI result supplied by the workflow; n/a. The workflow waits for CI in code and combines it with your verdict. Record n/a with pass.`,
    `The task's own acceptance criteria and every fixed decision it touches are met exactly as the spec states (names, counts, columns, enums, the Done line). Treat a deviation from the spec as a FIX item.`,
    CRITIC_EXTRA.length
      ? `Each of the project's own critic checks, in order (one result for this item, with each check's result in the evidence; it fails if any listed check fails):\n${CRITIC_EXTRA.map((s, i) => `   7.${i + 1} ${s}`).join('\n')}`
      : `The project's own critic checks (criticChecks): the project defines none, so record n/a.`,
    `Every entry in the PR body's \`Decisions:\` block (lines of the form id | choice | reason | reversible) is inside the decision envelope as the 'Decision envelope' section of ${SPEC} defines it: reversible by one revert PR or one config edit, within the cost cap, no project invariant or fixed decision touched, not in a human-only category. A decision outside the envelope is a FIX item. Record n/a when the PR took no decisions.`,
  ]
  return core.map((s, i) => `${i + 1}. ${s}`).join('\n')
}

function criticPrompt(t, w, round) {
  return `You are the critic for the ${NAME} repository. ${COMMON_RULES}
Review PR #${w.prNumber} (${w.prUrl || ''}, branch ${w.branch}) for task ${t.id}: ${t.title}, review round ${round}.
Task text: ${t.text}
Owned paths for this task: ${t.owns}. Task notes given to the worker: ${t.notes || 'none'}
Work from ${REPO} on main without checking anything out: gh pr diff ${w.prNumber}, gh pr view ${w.prNumber}, gh pr view ${w.prNumber} --json commits,files, and PR comments if round > 1. Read the spec sections the task names and compare the diff against them line by line. Do not run ${CHECK} locally and do not edit any file or branch.
Apply the checklist in order and record pass/fail with evidence for each item; record "n/a" with pass when an item does not apply to this task:
${criticChecklist()}
Verdict: MERGE if every applicable item passes. FIX lists numbered items each with the check that proves it and a cause (defect, spec_miss or loop); be complete in one pass, the worker gets at most ${FIX_ROUNDS} rounds. STOP only if the spec itself is wrong or contradictory; name the section. Do not watch or wait for CI and do not look at its status: the workflow waits for CI itself and combines the result with your verdict.`
}

function mergerPrompt(t, w, critic) {
  const restore = CHECK_MUTATES.length ? ` If check rewrote ${CHECK_MUTATES.join(' or ')} on main, run git checkout -- ${CHECK_MUTATES.join(' ')}.` : ''
  const conflicts = SYNC_CONFLICTS.replace('set status blocked', 'return outcome "failed" with the file list')
  const syncBranch = `cd into the worktree, git pull --ff-only, then git merge main (no rebase; force pushes are denied). ${conflicts} Commit the merge with the message "Sync branch with upstream before merge" plus the trailer line (do not name the default branch in the commit command; the hook blocks it), push with a plain git push, then wait for CI: gh pr checks ${w.prNumber} --watch --fail-fast (up to 15 minutes).`
  const syncSteps =
    SYNC_POLICY === 'conflict'
      ? `1. cd ${REPO} && git pull --ff-only (the checkout is on main). Run gh pr view ${w.prNumber} --json mergeable -q .mergeable. If it prints MERGEABLE, skip to step 3: the branch need not contain the latest main, the check on main after the merge is the test of the combination.
2. If it prints CONFLICTING (or UNKNOWN after three tries 10 s apart): ${syncBranch}`
      : `1. cd ${REPO} && git pull --ff-only (the checkout is on main). Check whether main has moved past the branch: git merge-base --is-ancestor main ${w.branch}. If it has NOT moved, skip to step 3.
2. If main moved: ${syncBranch}`
  const verifySteps = MAIN_CI
    ? `5. cd ${REPO} && git pull --ff-only; record the merge sha (git rev-parse HEAD). Do not run ${CHECK} locally. Wait for the "${MAIN_CI}" workflow run on main for that sha: gh run list --branch main --workflow ${MAIN_CI} --commit <mergeSha> --json databaseId,status,conclusion (retry every 20 s until the run appears, up to 3 minutes), then gh run watch <databaseId> --exit-status (up to 15 minutes). checkOnMainExitCode is 0 when the conclusion is success, else 1 with the last 40 lines of gh run view <databaseId> --log-failed as checkOnMainTail.`
    : `5. cd ${REPO} && git pull --ff-only; record the merge sha (git rev-parse HEAD). Run ${INSTALL_CMD} && ${CHECK_CMD} once in ${REPO}; record the exit code and the last 40 lines.${restore}`
  return `You are the merger for the ${NAME} repository. ${COMMON_RULES}
Merge PR #${w.prNumber} (${w.prUrl || ''}, branch ${w.branch}, worktree ${w.worktree || wtPath(t)}) for task ${t.id}: ${t.title}. The critic returned MERGE at PR head ${critic.prHeadSha || '(see gh)'}. You hold the merge lock: no other merge is running.
Steps:
${syncSteps}
3. Confirm CI is green: gh pr checks ${w.prNumber}. If not green, outcome "failed" with details; do not merge.
4. gh pr merge ${w.prNumber} --merge --delete-branch. If GitHub refuses, outcome "failed" with the exact message. (Exit code 1 only because the local branch is checked out in a worktree is fine; confirm with gh pr view --json state.)
${verifySteps}
6. If the check on main is red: git worktree add ${WT}/revert-${t.id} -b revert/${t.id} main, git revert -m 1 <mergeSha> there, push, open a PR titled "Revert ${t.id}: ${t.title} (check red on main)" with the failing output in the body, merge it the same way, pull main, and return outcome "reverted" with revertPrUrl and the failure tail. Never push to main directly.
7. Otherwise return outcome "merged" with mergeSha, mainSha and checkOnMainExitCode 0.
Finally remove the task worktree: cd ${REPO} && git worktree remove --force ${w.worktree || wtPath(t)} && git worktree prune && git branch -D ${w.branch} (ignore errors). Leave ${REPO} on main. Do not edit source files.`
}

// The critic role: a call that throws a usage-limit error, or returns null (the runtime's answer when the subagent dies
// on a terminal API error such as a usage limit), is retried once on CRITIC_FALLBACK, and the swap is recorded in
// models.critic, so every later critic call (any task, any round) starts on the fallback. A null or usage limit on the
// fallback itself is not retried. Any other error propagates.
let criticModel = MODELS.critic
function isUsageLimit(e) {
  return /usage limit|limit reached|rate.?limit|quota|\b429\b/i.test(e && e.message ? e.message : String(e))
}
function swapCritic(used, reason) {
  if (criticModel === used) {
    criticModel = { ...CRITIC_FALLBACK, swappedFrom: { model: used.model, effort: used.effort }, reason }
    log(`critic ${reason === 'usage_limit' ? 'hit a usage limit' : 'returned nothing'} on ${used.model}; swapped to ${CRITIC_FALLBACK.model}/${CRITIC_FALLBACK.effort}`)
  }
}
async function callCritic(prompt, opts) {
  const used = criticModel
  let reason = null
  try {
    const r = await agent(prompt, { ...opts, ...used })
    if (r !== null && r !== undefined) return r
    if (used.model === CRITIC_FALLBACK.model) return r
    reason = 'agent_returned_nothing'
  } catch (e) {
    if (!isUsageLimit(e)) throw e
    if (used.model === CRITIC_FALLBACK.model) {
      log(`critic hit a usage limit on the fallback model ${used.model} too; not retried again`)
      return null
    }
    reason = 'usage_limit'
  }
  swapCritic(used, reason)
  try {
    return await agent(prompt, { ...opts, model: criticModel.model, effort: criticModel.effort })
  } catch (e2) {
    if (!isUsageLimit(e2)) throw e2
    log(`critic retry on ${criticModel.model} hit a usage limit too`)
    return null
  }
}

const escalations = []
function escalate(id, what, question) {
  escalations.push({ task: id, what, question })
  log(`ESCALATION ${id}: ${what}`)
}

let mergeLock = Promise.resolve()
function withMergeLock(fn) {
  const p = mergeLock.then(fn, fn)
  mergeLock = p.catch(() => {})
  return p
}

const results = {}

function roundRecord(round, critic, ci) {
  return {
    round,
    verdict: critic ? critic.verdict : null,
    ci: ci ? ci.state : null,
    fixItems: critic ? critic.fixItems : [],
    notes: critic ? critic.notes : null,
    checklist: critic ? critic.checklist : [],
  }
}

// ---- Relays: one low-cost agent runs one command and hands back its stdout and exit code. ----
// The workflow parses the JSON line itself and never trusts a summary typed by the relay.
// Haiku/low by default (Edan, 2026-11-14): a relay copies stdout and an exit code, and the CI relays cost 16 to 17% of
// a wave's tokens on Sonnet. project.models.relay overrides it; project.models.merger now only sets the v2 merger agent.
// In script mode the 'merger:' labels are relays, so the result reports models.merger as the relay model too.
const RELAY_MODEL = { model: 'claude-haiku-5-5', effort: 'low', ...((P.models || {}).relay || {}) }

function relayPrompt(command) {
  return `You are a relay for the ${NAME} repository. You run exactly one shell command and report what it printed. You do not interpret, summarise, repair or retry anything.
FIRST RULE: the Bash tool call that runs the command MUST include the parameter timeout=600000. Without it the command is moved to the background after 120 seconds and the task fails. Do not set run_in_background.
If you see "moved to the background" anyway: do not end your turn and do not run the command again. Read the output file the tool reported with the Read tool, again and again (at most 30 reads), until it contains the JSON line the command prints, and return that.
Run exactly this command with the Bash tool from ${REPO} (cd there first):
${command}
It can take many minutes. Never end your turn while the command is still running. Never run a second copy of the command.
Run no other command except cd. Do not edit any file, branch or setting. If the command fails, report that; do not retry it and do not try another way.
If the permission system denies the command, or the tool refuses to run it, return status "blocked" with the denial text in note, and stop.
Otherwise return status "ran", exitCode as the command's exit code, and stdout as exactly what the command printed on stdout (verbatim: nothing added, removed, reordered or summarised).`
}

async function relay(command, label, phaseName) {
  const r = await agent(relayPrompt(command), { label, phase: phaseName, schema: RELAY_SCHEMA, ...RELAY_MODEL })
  if (!r) return { status: 'none' }
  if (r.status === 'blocked') return { status: 'blocked', note: r.note || '' }
  return { status: 'ran', exitCode: Number.isInteger(r.exitCode) ? r.exitCode : null, stdout: String(r.stdout == null ? '' : r.stdout), note: r.note || '' }
}

// The last line of stdout that is a JSON object; the scripts print exactly one.
function parseJsonLine(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l.startsWith('{') || !l.endsWith('}')) continue
    try {
      const v = JSON.parse(l)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {
      // not JSON: keep looking
    }
  }
  return null
}

function tailOf(text, n) {
  const t = String(text || '').trim()
  return t.length > n ? '...' + t.slice(-n) : t
}

// Elapsed times come from the scripts' JSON lines (this script has no clock); only numbers are added.
const timings = {}
function addTiming(id, key, ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return
  const o = timings[id] || (timings[id] = {})
  o[key] = (o[key] || 0) + ms
}

// Every worker call goes through here: the worker's own timing of its local check (localCheckMs, an integer it measured
// with date +%s) is copied into timings[taskId], summed over rounds. slotWaitMs has no source (slot.sh reports no wait).
async function callWorker(t, prompt, opts) {
  const w = await agent(prompt, opts)
  if (w && Number.isInteger(w.localCheckMs) && w.localCheckMs >= 0) addTiming(t.id, 'localCheckMs', w.localCheckMs)
  return w
}

const taskStates = {}
function taskState(t) {
  return taskStates[t.id] || (taskStates[t.id] = { criticUsed: false, fastFixUsed: false, laneCounted: false, conflictFixes: 0 })
}
let fastLaneUsed = 0 // fast-lane tasks found eligible in this wave; incremented in the same step as the eligibility call

const CI_STATES = ['green', 'red', 'pending', 'missing']
function roundLabel(tag) {
  return tag === 'reopen' ? 'reopen' : `r${tag}`
}

// Wait for the PR's CI through wait-ci.js in chunks: each relay call runs `wait-ci.js --timeout-min <= CI_CHUNK_MIN`, so it
// ends well inside the Bash tool's 120 s default timeout and can never be moved to the background. A chunk that reports
// 'pending' (wait-ci.js prints state 'pending', exit 0, when its own timeout passes) is called again until the overall
// budget (CI_RELAY_MAX_MIN, or CI_FIX_WAIT_MIN when bounded) is spent; then 'pending' is the result, as before. A 'missing'
// from a chunk shorter than CI_MISSING_MIN is not final: wait-ci.js caps its missing window at its own timeout.
// Chunk 1 keeps the label `ci:<id> r<n>`; later chunks add ` c2`, ` c3`. A result with no parseable JSON line is run once more
// (label + ` retry`); a block or an empty relay result is not retried. Never throws: { ok: false, what, question }.
async function awaitCi(t, w, tag, ph, bounded) {
  const budgetMin = bounded ? CI_FIX_WAIT_MIN : CI_RELAY_MAX_MIN
  const base0 = `ci:${t.id} ${roundLabel(tag)}${bounded ? ' fix' : ''}`
  let spentMin = 0
  let elapsedMs = 0
  let last = null
  for (let chunk = 1; spentMin < budgetMin; chunk++) {
    const chunkMin = Math.min(CI_CHUNK_MIN, budgetMin - spentMin)
    const command = `node ${SCRIPTS}/wait-ci.js ${w.prNumber} --repo ${REPO} --timeout-min ${chunkMin}`
    const base = chunk === 1 ? base0 : `${base0} c${chunk}`
    let line = null
    for (let attempt = 0; attempt < 2 && !line; attempt++) {
      const rr = await relay(command, attempt ? `${base} retry` : base, ph.review)
      if (rr.status === 'blocked') {
        return { ok: false, what: `CI relay blocked: ${command}`, question: `The permission system refused ${command}${rr.note ? ` (${rr.note})` : ''}. Allow it or run it by hand, then relaunch the wave.` }
      }
      if (rr.status === 'none') return { ok: false, what: 'CI relay returned nothing', question: `Relaunch the wave; it re-runs only parked tasks. Command: ${command}` }
      const parsed = parseJsonLine(rr.stdout)
      if (parsed && CI_STATES.includes(parsed.state)) line = parsed
    }
    if (!line) return { ok: false, what: 'wait-ci.js printed no JSON line twice', question: `Run ${command} by hand and relaunch the wave.` }
    spentMin += chunkMin
    if (typeof line.elapsedMs === 'number' && isFinite(line.elapsedMs)) elapsedMs += line.elapsedMs
    last = { state: line.state, failing: Array.isArray(line.failing) ? line.failing : [], logTail: String(line.logTail || ''), polls: line.polls }
    if (line.state === 'green' || line.state === 'red') break
    if (line.state === 'missing' && spentMin >= CI_MISSING_MIN) break
  }
  // Budget spent while chunks kept saying pending (or a short-window missing): that is the pending-CI timeout.
  if (last && last.state === 'missing' && spentMin < CI_MISSING_MIN) last = { ...last, state: 'pending' }
  return { ok: true, ci: last, elapsedMs }
}

function parseCount(out) {
  const m = String(out || '').match(/\d+/g)
  return m ? Number(m[m.length - 1]) : NaN
}

function factsPrompt(t, w) {
  const n = w.prNumber
  const wt = w.worktree || wtPath(t)
  const cmd = FAST_LANE.testCountCommand
  return `You gather facts about one pull request of the ${NAME} repository for a deterministic check. You run read-only commands and report their output. You do not interpret it, edit any file, or run any other command except cd.
Work from ${REPO} (cd there first). Run these commands, one after the other:
1. gh pr view ${n} --json files -q '.files[].path'  -> changedFiles: one array entry per path.
2. gh pr diff ${n}  -> addedText: every added line (lines starting with a single + that are not the +++ header), the leading + removed, joined with newlines, verbatim.
3. gh pr view ${n} --json body -q .body  -> decisions: the lines under the Decisions: heading of the PR body, up to the first blank line or the next heading, verbatim, one array entry per line; an empty array when there is no such block.
4. cd ${REPO} && ${cmd}  -> testCountBeforeOut: its stdout, verbatim.
5. cd ${wt} && ${cmd}  -> testCountAfterOut: its stdout, verbatim.
If the permission system denies a command, or a command cannot be run, return status "blocked" with the reason in note and stop; do not try another way. Otherwise return status "ran" with the five fields.`
}

async function gatherFacts(t, w, tag, ph) {
  const r = await agent(factsPrompt(t, w), { label: `facts:${t.id} ${roundLabel(tag)}`, phase: ph.review, schema: FACTS_SCHEMA, ...RELAY_MODEL })
  if (!r || r.status !== 'ran' || !Array.isArray(r.changedFiles)) return null
  return {
    changedFiles: r.changedFiles,
    addedText: String(r.addedText || ''),
    decisions: Array.isArray(r.decisions) ? r.decisions : [],
    testCount: { before: parseCount(r.testCountBeforeOut), after: parseCount(r.testCountAfterOut) },
  }
}

// Escalation text for a CI result that is neither green nor red.
function ciEscalation(decision, ci) {
  if (ci.state === 'pending') return { what: `CI still pending after ${CI_TIMEOUT_NOTE} (pending-CI timeout); not the worker's fault, so no FIX round`, question: 'Check why the CI run is stuck or queued, then relaunch the wave; it re-runs only parked tasks.' }
  if (ci.state === 'missing') return { what: 'no CI checks were reported (missing); not the worker\'s fault, so no FIX round and no merge', question: 'Check that the PR triggers CI, then relaunch the wave.' }
  return { what: decision.reason, question: 'See the workflow transcript.' }
}

// Critic round 2 and later: when the previous critic said MERGE at head H and the only changes since H are CI-only
// (no new commit, formatting or lint-autofix commits, or sync merges from the default branch with no conflict), the
// MERGE stands and no critic runs again. scripts/ci-only.js decides from the diff (claude/lib/delta.js); a relay that
// fails or a line that is not clear means the critic runs. Wave 12 spent 296k tokens on two such rounds.
const SHA_RE = /^[0-9a-f]{7,64}$/
async function ciOnlySince(t, w, tag, ph, since) {
  const command = `node ${SCRIPTS}/ci-only.js ${w.prNumber} --repo ${REPO} --since ${since}`
  const x = await relay(command, `delta:${t.id} ${roundLabel(tag)}`, ph.review)
  if (x.status !== 'ran') return null
  const line = parseJsonLine(x.stdout)
  return line && line.ciOnly === true ? line : null
}

// One review round: the critic and the CI wait run in parallel, combineVerdict decides.
// approved: the previous round's MERGE critic result, if any (see ciOnlySince).
// Returns { action: 'merge'|'fix'|'stop'|'nocritic'|'escalate', critic, ci, fixItems, notes, what, question }.
async function reviewRound(t, w, tag, ph, approved) {
  const st = taskState(t)
  const rec = (critic, ci, extra) => results[t.id].rounds.push({ ...roundRecord(tag, critic, ci), ...(extra || {}) })
  const criticCall = () => callCritic(criticPrompt(t, w, tag), { label: `critic:${t.id} ${roundLabel(tag)}`, phase: ph.review, schema: CRITIC_SCHEMA })
  let critic = null
  let ci = null
  let ciP = null
  let skipped = null

  const ownCount = st.laneCounted ? 1 : 0
  if (t.lane === 'fast' && FAST_LANE_ON && !st.criticUsed && fastLaneUsed - ownCount < FAST_LANE_CAP) {
    // Fast lane: no critic is started beside the CI wait. The facts are gathered in parallel with it.
    const ciFirst = awaitCi(t, w, tag, ph, false)
    const factsP = gatherFacts(t, w, tag, ph)
    factsP.catch(() => {})
    const c = await ciFirst
    if (!c.ok) {
      rec(null, null)
      return { action: 'escalate', what: c.what, question: c.question }
    }
    ci = c.ci
    addTiming(t.id, 'ciWaitMs', c.elapsedMs)
    if (ci.state === 'red') {
      if (st.fastFixUsed) {
        rec(null, ci, { lane: 'fast' })
        return { action: 'escalate', what: 'fast-lane task: CI is red again after its one FIX round', question: `Failing: ${ci.failing.join(', ') || 'unnamed check'}. Look at the PR and relaunch.` }
      }
      st.fastFixUsed = true
      const d = combineVerdict({ verdict: 'FIX', fixItems: [] }, ci)
      rec({ verdict: 'FIX', fixItems: d.fixItems, notes: d.reason, checklist: [] }, ci, { lane: 'fast' })
      return { action: 'fix', fixItems: d.fixItems, notes: d.reason }
    }
    if (ci.state !== 'green') {
      const d = combineVerdict('MERGE', ci)
      rec(null, ci, { lane: 'fast' })
      return { action: 'escalate', ...ciEscalation(d, ci) }
    }
    const facts = await factsP
    if (facts) {
      const lane = fastLaneEligible({
        task: { id: t.id, lane: t.lane, owns: t.owns },
        changedFiles: facts.changedFiles,
        addedText: facts.addedText,
        decisions: facts.decisions,
        project: P,
        ci,
        testCount: facts.testCount,
        laneUsedInWave: fastLaneUsed - ownCount,
      })
      if (lane.eligible) {
        if (!st.laneCounted) {
          st.laneCounted = true
          fastLaneUsed++
        }
        rec({ verdict: 'MERGE', fixItems: [], notes: lane.reason, checklist: [] }, ci, { lane: 'fast' })
        log(`${t.id}: ${lane.reason}`)
        return { action: 'merge', critic: null, ci }
      }
      log(`${t.id}: not fast lane, the critic reviews it: ${lane.reason}`)
    } else {
      log(`${t.id}: fast-lane facts unavailable, the critic reviews it`)
    }
    critic = await criticCall()
  } else {
    ciP = awaitCi(t, w, tag, ph, false)
    ciP.catch(() => {})
    if (approved && approved.verdict === 'MERGE' && SHA_RE.test(String(approved.prHeadSha || ''))) {
      const delta = await ciOnlySince(t, w, tag, ph, approved.prHeadSha)
      if (delta) {
        skipped = { criticSkipped: 'ci-only', ciOnlyReason: String(delta.reason || '') }
        critic = { ...approved, notes: `critic round ${tag} skipped: CI-only change since ${approved.prHeadSha} (${delta.reason || 'no reason given'}). ${approved.notes || ''}`.trim() }
        log(`${t.id} critic round ${tag}: skipped (CI-only change)`)
      }
    }
    if (!critic) critic = await criticCall()
  }
  st.criticUsed = true

  if (!critic) {
    rec(null, null)
    return { action: 'nocritic' }
  }
  if (!skipped) log(`${t.id} critic round ${tag}: ${critic.verdict}`)
  if (critic.verdict === 'STOP') {
    // CI does not change a STOP, so the workflow does not wait for it.
    rec(critic, null)
    return { action: 'stop', critic }
  }
  if (!ci) {
    let res
    if (critic.verdict === 'MERGE') {
      res = await ciP
    } else {
      // FIX: wait for a CI result still running for at most CI_FIX_WAIT_MIN more minutes, then start the fix round.
      const NOT_YET = {}
      const peek = await Promise.race([ciP, Promise.resolve(NOT_YET)])
      if (peek !== NOT_YET) {
        res = peek
      } else {
        const bounded = awaitCi(t, w, tag, ph, true)
        bounded.catch(() => {})
        res = await Promise.race([ciP, bounded])
      }
    }
    if (!res.ok) {
      rec(critic, null, skipped)
      return { action: 'escalate', critic, what: res.what, question: res.question }
    }
    ci = res.ci
    addTiming(t.id, 'ciWaitMs', res.elapsedMs)
  }
  const d = combineVerdict(critic, ci)
  rec(critic, ci, skipped)
  if (d.action === 'merge') return { action: 'merge', critic, ci }
  if (d.action === 'fix') return { action: 'fix', critic, ci, fixItems: d.fixItems, notes: critic.notes }
  return { action: 'escalate', critic, ci, ...ciEscalation(d, ci) }
}

// ---- Merge: merge-pr.js through a relay (or the v2 merger agent when project.merger = 'agent'). ----
let mergeBlocked = null // set when a merge relay is blocked; later merge relays then escalate without running

function failedMerge(r, what, question, line) {
  r.merge = { outcome: 'failed', details: line && line.message ? line.message : question, script: line || null }
  return { kind: 'failed', what, question }
}

// Returns { kind: 'merged'|'reverted' } with r.merge set, { kind: 'failed', what, question }, or
// { kind: 'fix', fixItems, notes } when the script refused for a reason one worker round can fix.
async function mergeStep(t, w, rr, ph, reopen) {
  const r = results[t.id]
  const st = taskState(t)
  const label = `merger:${t.id}${reopen ? ' reopen' : ''}`
  if (MERGER_AGENT) {
    const m = await withMergeLock(() => agent(mergerPrompt(t, w, rr.critic || {}), { label, phase: ph.merge, schema: MERGER_SCHEMA, ...MODELS.merger }))
    r.merge = m
    if (!m) return { kind: 'failed', what: 'merger agent returned nothing', question: 'Check the PR state by hand and relaunch.' }
    if (m.outcome === 'failed') return { kind: 'failed', what: 'merge failed', question: m.details }
    return { kind: m.outcome === 'merged' ? 'merged' : 'reverted' }
  }

  // With a main CI workflow the merge relay does not wait for main's run inside the lock (--defer-main): the merge
  // script skips that wait when the merged tree is the tree CI checked (mainCheck 'skipped:unchanged'), and otherwise
  // the run is watched below by a --verify-main relay after the lock is released, so the next PR can sync and merge.
  const command = `node ${SCRIPTS}/merge-pr.js ${w.prNumber} --repo ${REPO} --worktree ${w.worktree || wtPath(t)}${MAIN_CI ? ' --defer-main' : ''}`
  const rr0 = await withMergeLock(async () => {
    if (mergeBlocked) return { status: 'skipped' }
    const x = await relay(command, label, ph.merge)
    if (x.status === 'blocked') mergeBlocked = { command, note: x.note }
    return x
  })
  if (rr0.status === 'skipped') {
    return failedMerge(r, 'merge not run: a merge relay was blocked earlier in this wave', `Not run: ${command}. The earlier block was for ${mergeBlocked.command}${mergeBlocked.note ? ` (${mergeBlocked.note})` : ''}. Allow it, then relaunch the wave.`)
  }
  if (rr0.status === 'blocked') {
    return failedMerge(r, `merge relay blocked: ${command}`, `The permission system refused ${command}${rr0.note ? ` (${rr0.note})` : ''}. It was not retried and no other way was tried. Allow it or merge PR #${w.prNumber} by hand, then relaunch.`)
  }
  if (rr0.status === 'none') {
    r.merge = null
    return { kind: 'failed', what: 'merge relay returned nothing', question: `Check the state of PR #${w.prNumber} by hand and relaunch; the merge was not re-run.` }
  }
  let line = parseJsonLine(rr0.stdout)
  if (!line || typeof line.outcome !== 'string') {
    return failedMerge(
      r,
      `merge-pr.js printed no JSON line (not re-run): ${command}`,
      `The merge was not re-run, because a second run on a merged PR reports "refused". Check the state of PR #${w.prNumber} (gh pr view ${w.prNumber} --json state,mergeCommit) and the default branch by hand. Relay exit code ${rr0.exitCode}; output tail: ${tailOf(rr0.stdout, 300) || '(empty)'}`,
    )
  }
  addTiming(t.id, 'ciWaitMs', line.ciWaitMs)
  addTiming(t.id, 'mergeMs', line.mergeMs)
  addTiming(t.id, 'mainCheckMs', line.mainCheckMs)
  if (line.mainCheck === 'skipped:unchanged') log(`${t.id}: check on main skipped: the merged tree is the tree CI checked`)
  if (line.outcome === 'merged' && line.mainCheck === 'deferred') {
    const v = await verifyDeferred(t, w, line, ph, label)
    if (v.failed) return failedMerge(r, v.what, v.question, v.line || line)
    line = v.line
    addTiming(t.id, 'mainCheckMs', line.mainCheckMs)
  }
  const exit = Number.isInteger(line.exit) ? line.exit : rr0.exitCode
  const message = String(line.message || '')

  if (exit === 0 && line.outcome === 'merged') {
    r.merge = { outcome: 'merged', mergeSha: line.mergeSha, mainSha: line.mainSha, checkOnMainExitCode: 0, checkOnMainTail: '', revertPrUrl: '', details: message, script: line }
    return { kind: 'merged' }
  }
  if (exit === 3) {
    r.merge = { outcome: 'reverted', mergeSha: line.mergeSha, mainSha: line.mainSha, checkOnMainExitCode: 1, checkOnMainTail: String(line.logTail || ''), revertPrUrl: line.revertPrUrl || '', details: message, script: line }
    return { kind: 'reverted' }
  }
  if (exit === 2) {
    const files = Array.isArray(line.conflictFiles) ? line.conflictFiles : []
    if (files.length) {
      if (st.conflictFixes >= 1) return failedMerge(r, 'sync conflict again after the conflict fix round', message || files.join(', '), line)
      st.conflictFixes++
      r.merge = { outcome: 'failed', details: message, script: line }
      return {
        kind: 'fix',
        fixItems: [{ n: 1, what: `Merging the default branch into the branch conflicts in: ${files.join(', ')}. ${SYNC_CONFLICTS}`, provedBy: 'merge-pr.js syncs the branch without a conflict', cause: 'loop' }],
        notes: `merge-pr.js refused PR #${w.prNumber}: ${message}`,
      }
    }
    if (line.ciState === 'red') {
      const d = combineVerdict({ verdict: 'FIX', fixItems: [] }, { state: 'red', failing: Array.isArray(line.failing) ? line.failing : [], logTail: String(line.logTail || '') })
      r.merge = { outcome: 'failed', details: message, script: line }
      return { kind: 'fix', fixItems: d.fixItems, notes: `merge-pr.js refused PR #${w.prNumber}: ${message}` }
    }
    const pending = line.ciState === 'pending'
    return failedMerge(r, pending ? `merge refused: CI still pending (pending-CI timeout)` : 'merge failed', message, line)
  }
  return failedMerge(r, `merge failed (exit ${exit})`, message, line)
}

// The deferred check on main: merge-pr.js --verify-main, run outside the merge lock. A call that reports 'pending' (its
// --timeout-min passed while main's run was still going) is made again, at most MAIN_VERIFY_CALLS times in all. A red main
// is reverted once by the script, as before. Returns { line } or { failed: true, what, question, line? }.
const MAIN_VERIFY_CALLS = 3
async function verifyDeferred(t, w, merged, ph, label) {
  const command = `node ${SCRIPTS}/merge-pr.js ${w.prNumber} --repo ${REPO} --verify-main ${merged.mergeSha} --timeout-min ${CI_RELAY_MAX_MIN}`
  const base = label.replace(/^merger:/, 'main:')
  let line = null
  for (let call = 1; call <= MAIN_VERIFY_CALLS; call++) {
    const x = await relay(command, call === 1 ? base : `${base} c${call}`, ph.merge)
    if (x.status === 'blocked') return { failed: true, what: `main check relay blocked: ${command}`, question: `PR #${w.prNumber} is merged at ${merged.mergeSha}, but the permission system refused ${command}${x.note ? ` (${x.note})` : ''}. Check the default branch by hand (revert once if it is red), then relaunch.` }
    if (x.status === 'none') return { failed: true, what: 'main check relay returned nothing', question: `PR #${w.prNumber} is merged at ${merged.mergeSha}; check the default branch by hand: ${command}` }
    line = parseJsonLine(x.stdout)
    if (!line || typeof line.outcome !== 'string') return { failed: true, what: `merge-pr.js --verify-main printed no JSON line: ${command}`, question: `PR #${w.prNumber} is merged at ${merged.mergeSha}; check the default branch by hand. Output tail: ${tailOf(x.stdout, 300) || '(empty)'}` }
    if (line.outcome !== 'pending') break
    if (call < MAIN_VERIFY_CALLS) addTiming(t.id, 'mainCheckMs', line.mainCheckMs)
  }
  if (line.outcome === 'pending') return { failed: true, what: `check on main still running after ${MAIN_VERIFY_CALLS} watch calls`, question: `PR #${w.prNumber} is merged at ${merged.mergeSha}; watch its run on the default branch by hand (revert once if it is red), then relaunch.`, line }
  return { line }
}

// Review and merge until the PR is merged, reverted or parked. Returns { w, state: 'merged'|'reverted'|'parked' }.
async function reviewAndMerge(t, initialWorker, ph) {
  let w = initialWorker
  let approved = null // the last critic MERGE, kept while later rounds only fix CI (see ciOnlySince)
  for (let round = 1; round <= FIX_ROUNDS; round++) {
    const rr = await reviewRound(t, w, round, ph, approved)
    approved = rr.critic && rr.critic.verdict === 'MERGE' ? rr.critic : null
    let items
    let notes
    if (rr.action === 'merge') {
      const m = await mergeStep(t, w, rr, ph, false)
      if (m.kind === 'merged' || m.kind === 'reverted') return { w, state: m.kind }
      if (m.kind === 'failed') {
        escalate(t.id, m.what, m.question)
        return { w, state: 'parked' }
      }
      items = m.fixItems
      notes = m.notes
    } else if (rr.action === 'fix') {
      items = rr.fixItems
      notes = rr.notes
    } else if (rr.action === 'nocritic') {
      escalate(t.id, 'critic agent returned nothing', 'Relaunch the wave; it re-runs only parked tasks.')
      return { w, state: 'parked' }
    } else if (rr.action === 'stop') {
      escalate(t.id, 'critic STOP', rr.critic.stopSection || rr.critic.notes)
      return { w, state: 'parked' }
    } else {
      escalate(t.id, rr.what, rr.question)
      return { w, state: 'parked' }
    }
    if (round === FIX_ROUNDS) {
      escalate(t.id, 'another fix round would be needed', items.map((i) => `${i.n}. ${i.what}`).join('; '))
      return { w, state: 'parked' }
    }
    let next = await callWorker(t, fixPrompt(t, w, { fixItems: items, notes }, round), { label: `worker:${t.id} fix${round}`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
    if (next) next = await finishIfUnfinished(t, { ...next, prNumber: next.prNumber || w.prNumber, prUrl: next.prUrl || w.prUrl, branch: next.branch || w.branch, worktree: next.worktree || w.worktree }, ph, `fix${round}`)
    if (!next) {
      escalate(t.id, 'worker agent returned nothing on a fix round', 'Relaunch the wave.')
      return { w, state: 'parked' }
    }
    if (next.status === 'blocked') {
      escalate(t.id, 'worker blocked on a fix round', next.questions.join('; '))
      return { w: next, state: 'parked' }
    }
    w = { ...next, prNumber: next.prNumber || w.prNumber, prUrl: next.prUrl || w.prUrl, branch: next.branch || w.branch, worktree: next.worktree || w.worktree }
  }
  return { w, state: 'parked' }
}

async function runTask(t, ph) {
  results[t.id] = { task: t.id, title: t.title, pr: null, rounds: [], merge: null, reopened: false, merged: false }
  const r = results[t.id]
  let worker
  if (t.resume) {
    const prev = { prNumber: t.resume.prNumber, prUrl: t.resume.prUrl || '', branch: t.branch, worktree: t.resume.worktree || wtPath(t) }
    const synthetic = { fixItems: (t.resume.items || []).map((what, i) => ({ n: i + 1, what, provedBy: `${LOCAL_CHECK_NAME} green and CI green`, cause: 'loop' })), notes: `${t.resume.notes || ''} The PR is a draft; when ${LOCAL_CHECK_NAME} passes, mark it ready with gh pr ready ${t.resume.prNumber} and set status opened.` }
    worker = await callWorker(t, fixPrompt(t, prev, synthetic, 'resume'), { label: `worker:${t.id} resume`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
    if (worker) worker = { ...worker, prNumber: worker.prNumber || prev.prNumber, prUrl: worker.prUrl || prev.prUrl, branch: worker.branch || prev.branch, worktree: worker.worktree || prev.worktree }
  } else {
    worker = await callWorker(t, workerPrompt(t), { label: `worker:${t.id}`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
  }
  if (!worker) {
    escalate(t.id, 'worker agent returned nothing', 'Relaunch the wave.')
    return r
  }
  worker = await finishIfUnfinished(t, worker, ph, t.resume ? 'resume' : 'build')
  r.pr = { number: worker.prNumber, url: worker.prUrl, branch: worker.branch, decisions: worker.decisions, questions: worker.questions, checkExitCode: worker.checkExitCode }
  if (worker.status === 'blocked' || !worker.prNumber) {
    escalate(t.id, checkUnfinished(worker) ? `${LOCAL_CHECK_NAME} unfinished after ${FINISH_ROUNDS} finish rounds` : 'worker blocked (ambiguity)', worker.questions.join('; ') || 'no PR opened')
    return r
  }
  log(`${t.id}: PR #${worker.prNumber} opened on ${worker.branch}; local check exit ${worker.checkExitCode}`)
  const { w, state: outcome } = await reviewAndMerge(t, worker, ph)
  if (outcome === 'parked') return r
  if (outcome === 'merged') {
    r.merged = true
    log(`${t.id}: merged at ${r.merge.mergeSha}, check on main exit ${r.merge.checkOnMainExitCode}`)
    return r
  }
  r.reopened = true
  log(`${t.id}: main went red after merge; reverted once, reopening for one more round`)
  const fix = {
    verdict: 'FIX',
    notes: `Main went red after merging PR #${w.prNumber}; it was reverted (${r.merge.revertPrUrl || ''}). ${QUICK_CHECK ? 'Reproduce the failure from the output in the item below, using the quick check where it covers it (CI runs the full check on the new PR), and fix the cause.' : `Reproduce with ${INSTALL_CMD} && ${CHECK_CMD} and fix the cause.`} The original PR is merged and reverted on main; open a NEW PR from a new branch ${t.branch}-2 that re-applies your work on top of current main (git fetch; git worktree add ${wtPath(t)}-2 -b ${t.branch}-2 origin/main; git merge ${t.branch}), titled "${t.id}: ${t.title} (reopen)".`,
    fixItems: [{ n: 1, what: `${CHECK} failed on main after merge: ${(r.merge.checkOnMainTail || '').slice(-1500)}`, provedBy: `${CHECK} on main`, cause: 'defect' }],
  }
  let again = await callWorker(t, fixPrompt(t, w, fix, 'reopen'), { label: `worker:${t.id} reopen`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
  if (again) again = await finishIfUnfinished(t, { ...again, prNumber: again.prNumber || w.prNumber, prUrl: again.prUrl || w.prUrl, branch: again.branch || w.branch, worktree: again.worktree || w.worktree }, ph, 'reopen')
  if (!again || again.status === 'blocked') {
    escalate(t.id, 'worker blocked after revert', again ? again.questions.join('; ') : 'no result')
    return r
  }
  const w2 = { ...again, prNumber: again.prNumber || w.prNumber, prUrl: again.prUrl || w.prUrl, branch: again.branch || w.branch, worktree: again.worktree || w.worktree }
  const rr2 = await reviewRound(t, w2, 'reopen', ph)
  if (rr2.action === 'escalate') {
    escalate(t.id, rr2.what, rr2.question)
    return r
  }
  if (rr2.action !== 'merge') {
    escalate(t.id, 'critic did not MERGE after reopen', rr2.critic ? rr2.critic.stopSection || rr2.critic.notes : 'no result')
    return r
  }
  const m2 = await mergeStep(t, w2, rr2, ph, true)
  if (m2.kind !== 'merged') {
    escalate(t.id, 'second red main (or merge failure) after reopen', m2.kind === 'fix' ? m2.fixItems.map((i) => i.what).join('; ') : r.merge ? r.merge.details : m2.question)
    return r
  }
  r.merged = true
  return r
}

// Scheduler: MAX_CHAINS task chains at a time, dependency-aware, priority order as listed in args.tasks (put the
// longest tasks first). Memory is bounded separately: install and check run through .claude/slot.sh with MAX_BUILDERS slots.
// Preflight: before any worker starts, one relay runs merge-pr.js against PR 0 in dry-run mode. It proves the script is
// linked and the relay may run it. PR 0 does not exist, so an `error` outcome that is not about the config is the
// expected answer. A block, a missing script or an unreadable config fails the wave now, not after a whole wave of work.
async function preflightMerge() {
  const command = `node ${SCRIPTS}/merge-pr.js 0 --repo ${REPO} --dry-run`
  const fail = (why) => {
    escalate('preflight', `preflight failed: ${why}`, `Run ${command} by hand. The scripts live in ${SCRIPTS} (project.loopScripts; link the loop's scripts directory there). A block is Edan's permission settings, not something the loop retries another way. Or set project.merger to "agent" to use the v2 merger agent.`)
    return false
  }
  let rr = null
  let line = null
  // A result with no parseable JSON line is run once more (the relay has misreported "no JSON line" for correct output).
  for (let attempt = 0; attempt < 2; attempt++) {
    rr = await relay(command, attempt ? 'preflight:merge retry' : 'preflight:merge', 'Preflight')
    if (rr.status === 'blocked') return fail(`the relay was blocked from running ${command}${rr.note ? ` (${rr.note})` : ''}`)
    if (rr.status === 'none') return fail(`the relay returned nothing for ${command}`)
    line = parseJsonLine(rr.stdout)
    if (line && typeof line.outcome === 'string') break
  }
  if (!line || typeof line.outcome !== 'string') {
    return fail(`${command} printed no JSON line (exit ${rr.exitCode}); the script is missing or does not run. Output tail: ${tailOf(rr.stdout, 200) || '(empty)'} ${rr.note}`.trim())
  }
  if (line.outcome === 'error' && /^(cannot read|usage:)/.test(String(line.message || ''))) return fail(String(line.message))
  if (line.loopVersion !== LOOP_VERSION) {
    return fail(`this wave-loop script is loop ${LOOP_VERSION}, but the loop scripts in ${SCRIPTS} report ${line.loopVersion ? `loop ${line.loopVersion}` : 'no version'}. The session resolved another copy of the loop: 'wave-loop' comes from the .claude/workflows of the directory the session started in. Start the session in the project repo (or relink that copy), then run the wave again`)
  }
  warnLoad(line.load)
  return true
}
// The dry run reports the machine's 1-minute load average; above the threshold (project.loadWarnFactor, default 4, x the
// core count) the wave still runs, but other heavy jobs are slowing it (README: no other heavy jobs during a wave).
function warnLoad(load) {
  if (!load || load.high !== true) return
  log(`WARNING: the machine's 1-minute load average is ${load.load1}, above ${load.threshold} (${load.cores} cores). Other heavy jobs are running; the wave runs anyway but slower. Stop them, or let them finish, before the next wave.`)
}
if (!MERGER_AGENT && !(await preflightMerge())) {
  log(`Wave ${WAVE} FAILED in preflight: ${escalations[escalations.length - 1].what}`)
  return { project: NAME, wave: WAVE, gate: 'FAIL', models: MODELS, state: {}, tasks: {}, escalations, reality: null, decisions: [], timings: {}, loopVersion: LOOP_VERSION }
}

phase('Build')
const state = {}
for (const t of TASKS) state[t.id] = 'pending'
const running = new Map()
const PH = { build: 'Build', review: 'Review', merge: 'Merge' }
while (true) {
  const pending = TASKS.filter((t) => state[t.id] === 'pending')
  if (!pending.length && !running.size) break
  for (const t of pending) {
    if (running.size >= MAX_CHAINS) break
    if ((t.deps || []).some((d) => state[d] === 'parked')) {
      state[t.id] = 'parked'
      results[t.id] = { task: t.id, title: t.title, pr: null, rounds: [], merge: null, reopened: false, merged: false }
      escalate(t.id, `dependency ${t.deps.join(',')} parked`, 'Resolve the dependency first; relaunch re-runs parked tasks.')
      continue
    }
    if (!(t.deps || []).every((d) => state[d] === 'merged')) continue
    state[t.id] = 'running'
    log(`starting ${t.id} ${t.title} (${running.size + 1}/${MAX_CHAINS} chains; ${MAX_BUILDERS} check slots machine-wide)`)
    const p = runTask(t, PH).then(
      (r) => {
        state[t.id] = r.merged ? 'merged' : 'parked'
        running.delete(t.id)
      },
      () => {
        state[t.id] = 'parked'
        running.delete(t.id)
        escalate(t.id, 'task chain threw', 'See the workflow transcript.')
      },
    )
    running.set(t.id, p)
  }
  if (running.size) await Promise.race(running.values())
  else if (pending.length) {
    for (const t of pending) {
      state[t.id] = 'parked'
      escalate(t.id, 'unschedulable', 'dependency never merged')
    }
    break
  }
}

const parallelOutcome = TASKS.map((t) => `${t.id}=${state[t.id]}`).join(' ') || '(no parallel tasks)'
log(`parallel tasks: ${parallelOutcome}`)

let tail = null
if (TAIL) {
  phase('Tail')
  if (TASKS.every((t) => state[t.id] === 'merged')) {
    tail = await runTask(TAIL, { build: 'Tail', review: 'Tail', merge: 'Tail' })
    state[TAIL.id] = tail.merged ? 'merged' : 'parked'
  } else {
    results[TAIL.id] = { task: TAIL.id, title: TAIL.title, pr: null, rounds: [], merge: null, reopened: false, merged: false }
    state[TAIL.id] = 'parked'
    escalate(TAIL.id, 'tail not run', `parallel tasks not all merged: ${parallelOutcome}`)
  }
}

const everyMerged = Object.values(state).every((s) => s === 'merged')
const last = TAIL ? tail : Object.values(results).slice(-1)[0]
const checkGreen = !!(last && last.merge && last.merge.checkOnMainExitCode === 0)
let gate = everyMerged && checkGreen && escalations.length === 0
log(gate ? `Wave ${WAVE} machine gate: PASS` : `Wave ${WAVE} machine gate: FAIL`)

// Reality gate: after the machine gate, a read-only check against the real system. Block gaps (and a check that does
// not run cleanly, which runReality reports as ok: false) fail the wave; warn gaps are only returned.
function realityPrompt(command, timeoutSec) {
  return `You run one read-only shell command for the ${NAME} repository and report its output. Do not interpret it.
Run exactly this command with the Bash tool from ${REPO} (cd there first), with the Bash timeout set to ${timeoutSec * 1000} milliseconds:
${command}
Do not modify any file, branch, database or setting; do not run any other command except to cd; do not retry; do not start background processes.
Return stdout as the command printed it (verbatim, nothing added or removed) and code as its exit code. If the command was killed for exceeding the timeout, set timedOut true; if it could not be started, set code to 127 and put the error in stdout.`
}
async function execReality(command, timeoutSec) {
  const r = await agent(realityPrompt(command, timeoutSec), { label: 'reality:check', phase: 'Reality', schema: REALITY_SCHEMA, ...REALITY_MODEL })
  if (!r || typeof r.stdout !== 'string' || typeof r.code !== 'number') throw new Error('the reality agent returned no usable result')
  return { code: r.code, stdout: r.stdout, timedOut: r.timedOut === true }
}
let reality = null
let realityModel = null
if (REALITY_CHECK) {
  phase('Reality')
  realityModel = REALITY_MODEL
  const res = await runReality(REALITY_CHECK, execReality)
  reality = res.ok ? { ok: true, gaps: res.gaps } : { ok: false, error: res.error, gaps: [] }
  const blocking = res.ok ? res.blocking : []
  if (!res.ok || blocking.length) {
    const what = res.ok ? `reality_gap: ${blocking.map((g) => g.id).join(', ')}` : `reality_gap: ${res.error}`
    escalate('reality', what, res.ok ? blocking.map((g) => `${g.id}: ${g.what}`).join('; ') : 'Fix the reality command or its environment, then relaunch.')
    gate = false
    log(`Wave ${WAVE} reality gate: FAIL`)
  } else {
    log(`Wave ${WAVE} reality gate: PASS (${res.gaps.length} warn gap${res.gaps.length === 1 ? '' : 's'})`)
  }
}

// Decisions: workers write each as `id | choice | reason | reversible` in the PR body (task 4.2) and return the lines in
// their result. Only lines in that format are collected; any other text stays in tasks[id].pr.decisions.
function parseDecision(taskId, line) {
  const parts = String(line).split('|').map((x) => x.trim())
  if (parts.length !== 4 || !parts[0] || !parts[1]) return null
  return { id: parts[0], task: taskId, choice: parts[1], reason: parts[2], reversible: /^(true|yes|y)$/i.test(parts[3]), outcome: 'accepted' }
}
const decisions = []
for (const r of Object.values(results)) {
  for (const line of (r.pr && r.pr.decisions) || []) {
    const d = parseDecision(r.task, line)
    if (d) decisions.push(d)
  }
}

const models = { ...MODELS, ...(MERGER_AGENT ? {} : { merger: RELAY_MODEL }), relay: RELAY_MODEL, critic: criticModel, ...(realityModel ? { reality: realityModel } : {}) }
return { project: NAME, wave: WAVE, gate: gate ? 'PASS' : 'FAIL', models, state, tasks: results, escalations, reality, decisions, timings, loopVersion: LOOP_VERSION }
