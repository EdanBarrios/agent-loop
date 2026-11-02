// Wave loop: parallel tasks through worker -> critic -> merger, then a tail task alone.
// Run with the Workflow tool: { name: 'wave-loop', args: { project, wave, tasks, tail } }.
// args.project: the parsed contents of the repo's .claude/loop.local.json (see README.md, "Project config").
// args.tasks: [{ id, title, branch, deps: [ids], text, owns, notes, resume? }]; args.tail: same shape or null.
// resume: { prNumber, prUrl, worktree, items: [string], notes } continues an existing draft PR (after an escalation
// was answered) with a fix-round worker instead of a fresh worker; the worker must mark the PR ready.
// Role defaults: worker = Sonnet/high, critic = Fable/high, merger = Sonnet/low (set after the first scorecards,
// 2026-10-27), pinned by full model id; project.models overrides per role.
// args.gates: the project's gate checklist, already parsed from project.gates by the session (scripts have no fs).
// An open item with before <= this wave returns { gate: 'BLOCKED', blockedBy: [ids] } before any agent starts.
// project.realityCheck: { command, readOnly: true, timeoutSec }: run after the machine gate through a small
// haiku/low agent; a block gap (or a check that does not run cleanly) fails the gate with a reality_gap escalation.
// Result: { project, wave, gate, models, state, tasks, escalations, reality, decisions }. reality is null when no
// check is configured, else { ok, gaps, error? }; decisions are the workers' `id | choice | reason | reversible` lines.
// This script never calls workflow(): chain-loop calls it, and nesting is one level.

export const meta = {
  name: 'wave-loop',
  description: 'One wave of spec tasks: parallel tasks through worker -> critic -> merger, then the tail alone',
  whenToUse: 'One run per wave of the project spec; pass .claude/loop.local.json as args.project and the wave tasks as args.tasks.',
  phases: [
    { title: 'Build', detail: 'Workers, a few at a time, one git worktree each', model: 'sonnet' },
    { title: 'Review', detail: 'Critic applies the checklist; FIX returns to a worker, max 3 rounds' },
    { title: 'Merge', detail: 'Serialized merger: merge main into branch if moved, wait CI, merge, check main, revert once', model: 'sonnet' },
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
const CHECK_WAIT = `If you return before it has finished, set checkExitCode to -1 and say so: the workflow sends a worker back to finish it. Never report a slow or unfinished check as status blocked.`
const READ_FIRST = (P.readFirst && P.readFirst.length ? P.readFirst : ['CLAUDE.md']).join('; ')
const FORBIDDEN = (P.forbiddenStrings || []).length ? ` No project-confidential strings (${P.forbiddenStrings.join(', ')}).` : ''
const EXTRA_RULES = (P.extraRules || []).length ? ' ' + P.extraRules.join(' ') : ''
const SIDE_FILES = P.sideFiles || 'No generated files are expected to change beyond what the task touches.'
const SIDE_FILES_SHORT = P.sideFiles ? `the side files the project allows (${P.sideFiles})` : 'nothing else'
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

const SYNC_STEP = `Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m "Sync branch with upstream before merge". ${SYNC_CONFLICTS} Commit the merge and push with a plain git push.`

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
    ciState: { type: 'string', enum: ['green', 'red', 'pending', 'missing'] },
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
  required: ['verdict', 'ciState', 'checklist', 'fixItems', 'notes'],
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

function wtPath(t) {
  return `${WT}/${t.id}`
}

function workerPrompt(t) {
  return `You are a worker on the ${NAME} repository. ${COMMON_RULES}
Task ${t.id}: ${t.title}.
Task text (verbatim from the spec): ${t.text}
You own only: ${t.owns}. Do not edit anything else. If you need a change elsewhere, stop and report it in the PR body.
Task notes: ${t.notes || 'none'}
${WORKER_NOTES}

Worktree: cd ${REPO} && git fetch origin && git worktree add ${wtPath(t)} -b ${t.branch} origin/main. Then work ONLY inside ${wtPath(t)} (cd there; run ${INSTALL_CMD} there first). Never run git checkout in ${REPO}.
Order: (1) write the acceptance test exactly as specified and commit it first, confirming it fails for the right reason before the implementation exists; (2) implement; (3) run ${CHECK_CMD} once in the worktree and keep the output (the slot wrapper waits for a free check slot on this machine, so the command can take up to 15 minutes: run it with the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output file; never run a second copy; ${CHECK_WAIT}); (4) commit in small steps; (5) ${SYNC_STEP} (6) git push -u origin ${t.branch} and open a PR with gh pr create titled "${t.id}: ${t.title}" whose body lists files changed, the exact test command and its output tail, a "Decisions" list for every default you took where the spec left a detail open, and open questions.
Where the spec leaves a detail open, take the conventional default and list it under Decisions. Stop (status: blocked) only if two readings of the spec would lead to materially different work; then list the question and still open the PR as a draft with what you have.
Return the structured result with worktree set to ${wtPath(t)}. Leave the branch pushed and the worktree in place; do not merge.`
}

function fixPrompt(t, prev, critic, round) {
  const items = critic.fixItems.map((i) => `${i.n}. ${i.what} (proved by: ${i.provedBy})`).join('\n')
  return `You are a worker on the ${NAME} repository continuing task ${t.id}: ${t.title}, fix round ${round} of ${FIX_ROUNDS}. ${COMMON_RULES}
Task text: ${t.text}
You own only: ${t.owns}. Task notes: ${t.notes || 'none'}
${WORKER_NOTES}
Your PR: #${prev.prNumber} ${prev.prUrl || ''} on branch ${prev.branch}. Your worktree is ${prev.worktree || wtPath(t)}; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd ${REPO} && git fetch origin && git worktree add ${wtPath(t)} ${t.branch}.
The critic returned FIX with these numbered items; fix every one and nothing else:
${items}
Critic notes: ${critic.notes}
Run ${CHECK_CMD} once after the fixes (up to 15 minutes including the slot wait; maximum Bash timeout, and if the tool moves it to the background wait for its notification; ${CHECK_WAIT}), commit in small steps. ${SYNC_STEP} Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.`
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
You own only: ${t.owns}. Task notes: ${t.notes || 'none'}
${WORKER_NOTES}
The previous worker on this task returned before ${CHECK} had finished, so nothing has been reviewed. Branch ${prev.branch || t.branch}, worktree ${prev.worktree || wtPath(t)}; cd there (if the worktree is missing: cd ${REPO} && git fetch origin && git worktree add ${wtPath(t)} ${t.branch}). ${pr}
Its open questions were: ${(prev.questions || []).join('; ') || 'none'}. Answer each by taking the conventional default and listing it under Decisions, unless two readings of the spec would lead to materially different work.
Steps: (1) make sure every change is committed; (2) run ${CHECK_CMD} once and wait for it to finish: with the slot wait it can take 15 minutes; use the Bash tool's maximum timeout, and if the tool moves it to the background, wait for its completion notification and read its output; you may not return while it runs; (3) if it fails, fix the cause inside the files you own and run it again, at most twice; (4) ${SYNC_STEP} Push, and if no PR exists open it with gh pr create titled "${t.id}: ${t.title}", its body listing files changed, the check command and output tail, Decisions and open questions.
Return the structured result with the real exit code of the last check. Set status blocked only for a genuine ambiguity in the spec, never for a slow or unfinished check.`
}

async function finishIfUnfinished(t, w, ph, tag) {
  for (let attempt = 1; attempt <= FINISH_ROUNDS && checkUnfinished(w); attempt++) {
    log(`${t.id}: worker returned before ${CHECK} finished (${tag}); finish attempt ${attempt}`)
    const next = await agent(finishPrompt(t, w, attempt), { label: `worker:${t.id} finish${attempt}`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
    if (!next) return w
    w = { ...next, prNumber: next.prNumber || w.prNumber, prUrl: next.prUrl || w.prUrl, branch: next.branch || w.branch, worktree: next.worktree || w.worktree }
  }
  if (checkUnfinished(w)) w = { ...w, status: 'blocked' }
  return w
}

function criticChecklist() {
  const core = [
    `The acceptance test exists and its commit precedes the implementation commits. Verify "fails on main" by checking that the paths or behaviour the test exercises do not exist at the PR's merge-base (git cat-file -e origin/main:<path>, or reasoning from the diff).`,
    `Only owned paths changed (plus ${SIDE_FILES_SHORT} and merge commits from origin/main).`,
    `No test touches the network or a paid API; no .skip, .only, or disabled test, and no lowered test count.`,
    `No street address, real person, secret${FORBIDDEN ? ' or project-confidential string' : ''} anywhere in the diff.`,
    `CI is green on the PR head.`,
    `The task's own acceptance criteria and every fixed decision it touches are met exactly as the spec states (names, counts, columns, enums, the Done line). Treat a deviation from the spec as a FIX item.`,
  ]
  return core.concat(CRITIC_EXTRA).map((s, i) => `${i + 1}. ${s}`).join('\n')
}

function criticPrompt(t, w, round) {
  return `You are the critic for the ${NAME} repository. ${COMMON_RULES}
Review PR #${w.prNumber} (${w.prUrl || ''}, branch ${w.branch}) for task ${t.id}: ${t.title}, review round ${round}.
Task text: ${t.text}
Owned paths for this task: ${t.owns}. Task notes given to the worker: ${t.notes || 'none'}
Work from ${REPO} on main without checking anything out: gh pr diff ${w.prNumber}, gh pr view ${w.prNumber}, gh pr view ${w.prNumber} --json commits,files, and PR comments if round > 1. Read the spec sections the task names and compare the diff against them line by line. Do not run ${CHECK} locally and do not edit any file or branch.
CI: run gh pr checks ${w.prNumber} --watch --fail-fast (allow up to 15 minutes). If GitHub reports no checks at all, record ciState "missing"; that is not the worker's fault.
Apply the checklist in order and record pass/fail with evidence for each item; record "n/a" with pass when an item does not apply to this task:
${criticChecklist()}
Verdict: MERGE if every applicable item passes and CI is green. FIX lists numbered items each with the check that proves it and a cause (defect, spec_miss or loop); be complete in one pass, the worker gets at most ${FIX_ROUNDS} rounds. STOP only if the spec itself is wrong or contradictory; name the section. If CI is pending or missing after the wait, do not return MERGE; return FIX with cause "loop" for the CI item plus anything else you found.`
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

// The critic role: a call that throws a usage-limit error is retried once on CRITIC_FALLBACK, and the swap is recorded
// in models.critic, so every later critic call (any task, any round) starts on the fallback. Any other error propagates.
let criticModel = MODELS.critic
function isUsageLimit(e) {
  return /usage limit|limit reached|rate.?limit|quota|\b429\b/i.test(e && e.message ? e.message : String(e))
}
async function callCritic(prompt, opts) {
  const used = criticModel
  try {
    return await agent(prompt, { ...opts, ...used })
  } catch (e) {
    if (!isUsageLimit(e)) throw e
    if (used.model === CRITIC_FALLBACK.model) {
      log(`critic hit a usage limit on the fallback model ${used.model} too; not retried again`)
      return null
    }
    if (criticModel === used) {
      criticModel = { ...CRITIC_FALLBACK, swappedFrom: { model: used.model, effort: used.effort }, reason: 'usage_limit' }
      log(`critic hit a usage limit on ${used.model}; swapped to ${CRITIC_FALLBACK.model}/${CRITIC_FALLBACK.effort}`)
    }
    try {
      return await agent(prompt, { ...opts, model: criticModel.model, effort: criticModel.effort })
    } catch (e2) {
      if (!isUsageLimit(e2)) throw e2
      log(`critic retry on ${criticModel.model} hit a usage limit too`)
      return null
    }
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

function roundRecord(round, critic) {
  return {
    round,
    verdict: critic ? critic.verdict : null,
    ci: critic ? critic.ciState : null,
    fixItems: critic ? critic.fixItems : [],
    notes: critic ? critic.notes : null,
    checklist: critic ? critic.checklist : [],
  }
}

async function reviewLoop(t, initialWorker, ph) {
  let w = initialWorker
  let critic = null
  for (let round = 1; round <= FIX_ROUNDS; round++) {
    critic = await callCritic(criticPrompt(t, w, round), { label: `critic:${t.id} r${round}`, phase: ph.review, schema: CRITIC_SCHEMA })
    results[t.id].rounds.push(roundRecord(round, critic))
    if (!critic) {
      escalate(t.id, 'critic agent returned nothing', 'Relaunch the wave; it re-runs only parked tasks.')
      return { w, critic: null }
    }
    log(`${t.id} critic round ${round}: ${critic.verdict} (CI ${critic.ciState})`)
    if (critic.verdict === 'MERGE') return { w, critic }
    if (critic.verdict === 'STOP') {
      escalate(t.id, 'critic STOP', critic.stopSection || critic.notes)
      return { w, critic }
    }
    if (round === FIX_ROUNDS) {
      escalate(t.id, 'another fix round would be needed', critic.fixItems.map((i) => `${i.n}. ${i.what}`).join('; '))
      return { w, critic }
    }
    let next = await agent(fixPrompt(t, w, critic, round), { label: `worker:${t.id} fix${round}`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
    if (next) next = await finishIfUnfinished(t, { ...next, prNumber: next.prNumber || w.prNumber, prUrl: next.prUrl || w.prUrl, branch: next.branch || w.branch, worktree: next.worktree || w.worktree }, ph, `fix${round}`)
    if (!next) {
      escalate(t.id, 'worker agent returned nothing on a fix round', 'Relaunch the wave.')
      return { w, critic }
    }
    if (next.status === 'blocked') {
      escalate(t.id, 'worker blocked on a fix round', next.questions.join('; '))
      return { w: next, critic }
    }
    w = { ...next, prNumber: next.prNumber || w.prNumber, prUrl: next.prUrl || w.prUrl, branch: next.branch || w.branch, worktree: next.worktree || w.worktree }
  }
  return { w, critic }
}

async function runTask(t, ph) {
  results[t.id] = { task: t.id, title: t.title, pr: null, rounds: [], merge: null, reopened: false, merged: false }
  const r = results[t.id]
  let worker
  if (t.resume) {
    const prev = { prNumber: t.resume.prNumber, prUrl: t.resume.prUrl || '', branch: t.branch, worktree: t.resume.worktree || wtPath(t) }
    const synthetic = { fixItems: (t.resume.items || []).map((what, i) => ({ n: i + 1, what, provedBy: `${CHECK} green and CI green`, cause: 'loop' })), notes: `${t.resume.notes || ''} The PR is a draft; when ${CHECK} passes, mark it ready with gh pr ready ${t.resume.prNumber} and set status opened.` }
    worker = await agent(fixPrompt(t, prev, synthetic, 'resume'), { label: `worker:${t.id} resume`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
    if (worker) worker = { ...worker, prNumber: worker.prNumber || prev.prNumber, prUrl: worker.prUrl || prev.prUrl, branch: worker.branch || prev.branch, worktree: worker.worktree || prev.worktree }
  } else {
    worker = await agent(workerPrompt(t), { label: `worker:${t.id}`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
  }
  if (!worker) {
    escalate(t.id, 'worker agent returned nothing', 'Relaunch the wave.')
    return r
  }
  worker = await finishIfUnfinished(t, worker, ph, t.resume ? 'resume' : 'build')
  r.pr = { number: worker.prNumber, url: worker.prUrl, branch: worker.branch, decisions: worker.decisions, questions: worker.questions, checkExitCode: worker.checkExitCode }
  if (worker.status === 'blocked' || !worker.prNumber) {
    escalate(t.id, checkUnfinished(worker) ? `${CHECK} unfinished after ${FINISH_ROUNDS} finish rounds` : 'worker blocked (ambiguity)', worker.questions.join('; ') || 'no PR opened')
    return r
  }
  log(`${t.id}: PR #${worker.prNumber} opened on ${worker.branch}; local check exit ${worker.checkExitCode}`)
  const { w, critic } = await reviewLoop(t, worker, ph)
  if (!critic || critic.verdict !== 'MERGE') return r
  r.merge = await withMergeLock(() => agent(mergerPrompt(t, w, critic), { label: `merger:${t.id}`, phase: ph.merge, schema: MERGER_SCHEMA, ...MODELS.merger }))
  if (!r.merge) {
    escalate(t.id, 'merger agent returned nothing', 'Check the PR state by hand and relaunch.')
    return r
  }
  if (r.merge.outcome === 'failed') {
    escalate(t.id, 'merge failed', r.merge.details)
    return r
  }
  if (r.merge.outcome === 'merged') {
    r.merged = true
    log(`${t.id}: merged at ${r.merge.mergeSha}, check on main exit ${r.merge.checkOnMainExitCode}`)
    return r
  }
  r.reopened = true
  log(`${t.id}: main went red after merge; reverted once, reopening for one more round`)
  const fix = {
    verdict: 'FIX',
    notes: `Main went red after merging PR #${w.prNumber}; it was reverted (${r.merge.revertPrUrl || ''}). Reproduce with ${INSTALL_CMD} && ${CHECK_CMD} and fix the cause. The original PR is merged and reverted on main; open a NEW PR from a new branch ${t.branch}-2 that re-applies your work on top of current main (git fetch; git worktree add ${wtPath(t)}-2 -b ${t.branch}-2 origin/main; git merge ${t.branch}), titled "${t.id}: ${t.title} (reopen)".`,
    fixItems: [{ n: 1, what: `${CHECK} failed on main after merge: ${(r.merge.checkOnMainTail || '').slice(-1500)}`, provedBy: `${CHECK} on main`, cause: 'defect' }],
  }
  let again = await agent(fixPrompt(t, w, fix, 'reopen'), { label: `worker:${t.id} reopen`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
  if (again) again = await finishIfUnfinished(t, { ...again, prNumber: again.prNumber || w.prNumber, prUrl: again.prUrl || w.prUrl, branch: again.branch || w.branch, worktree: again.worktree || w.worktree }, ph, 'reopen')
  if (!again || again.status === 'blocked') {
    escalate(t.id, 'worker blocked after revert', again ? again.questions.join('; ') : 'no result')
    return r
  }
  const w2 = { ...again, prNumber: again.prNumber || w.prNumber, prUrl: again.prUrl || w.prUrl, branch: again.branch || w.branch, worktree: again.worktree || w.worktree }
  const critic2 = await callCritic(criticPrompt(t, w2, 'reopen'), { label: `critic:${t.id} reopen`, phase: ph.review, schema: CRITIC_SCHEMA })
  r.rounds.push(roundRecord('reopen', critic2))
  if (!critic2 || critic2.verdict !== 'MERGE') {
    escalate(t.id, 'critic did not MERGE after reopen', critic2 ? critic2.stopSection || critic2.notes : 'no result')
    return r
  }
  const m2 = await withMergeLock(() => agent(mergerPrompt(t, w2, critic2), { label: `merger:${t.id} reopen`, phase: ph.merge, schema: MERGER_SCHEMA, ...MODELS.merger }))
  r.merge = m2
  if (!m2 || m2.outcome !== 'merged') {
    escalate(t.id, 'second red main (or merge failure) after reopen', m2 ? m2.details : 'no result')
    return r
  }
  r.merged = true
  return r
}

// Scheduler: MAX_CHAINS task chains at a time, dependency-aware, priority order as listed in args.tasks (put the
// longest tasks first). Memory is bounded separately: install and check run through .claude/slot.sh with MAX_BUILDERS slots.
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

const models = { ...MODELS, critic: criticModel, ...(realityModel ? { reality: realityModel } : {}) }
return { project: NAME, wave: WAVE, gate: gate ? 'PASS' : 'FAIL', models, state, tasks: results, escalations, reality, decisions }
