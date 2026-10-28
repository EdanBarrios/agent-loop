// Wave loop: parallel tasks through worker -> critic -> merger, then a tail task alone.
// Run with the Workflow tool: { name: 'wave-loop', args: { project, wave, tasks, tail } }.
// args.project: the parsed contents of the repo's .claude/loop.local.json (see README.md, "Project config").
// args.tasks: [{ id, title, branch, deps: [ids], text, owns, notes, resume? }]; args.tail: same shape or null.
// resume: { prNumber, prUrl, worktree, items: [string], notes } continues an existing draft PR (after an escalation
// was answered) with a fix-round worker instead of a fresh worker; the worker must mark the PR ready.
// Role defaults: worker = Sonnet/high, critic = Fable/high, merger = Sonnet/low (set after the first scorecards,
// 2026-10-27); project.models overrides per role.

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

const DEFAULT_MODELS = {
  worker: { model: 'sonnet', effort: 'high' },
  critic: { model: 'fable', effort: 'high' },
  merger: { model: 'sonnet', effort: 'low' },
}
const MODELS = { ...DEFAULT_MODELS, ...(P.models || {}) }

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
Order: (1) write the acceptance test exactly as specified and commit it first, confirming it fails for the right reason before the implementation exists; (2) implement; (3) run ${CHECK_CMD} once in the worktree and keep the output (the slot wrapper waits for a free check slot on this machine; that wait is expected); (4) commit in small steps; (5) ${SYNC_STEP} (6) git push -u origin ${t.branch} and open a PR with gh pr create titled "${t.id}: ${t.title}" whose body lists files changed, the exact test command and its output tail, a "Decisions" list for every default you took where the spec left a detail open, and open questions.
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
Run ${CHECK_CMD} once after the fixes, commit in small steps. ${SYNC_STEP} Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.`
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
    critic = await agent(criticPrompt(t, w, round), { label: `critic:${t.id} r${round}`, phase: ph.review, schema: CRITIC_SCHEMA, ...MODELS.critic })
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
    const next = await agent(fixPrompt(t, w, critic, round), { label: `worker:${t.id} fix${round}`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
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
  r.pr = { number: worker.prNumber, url: worker.prUrl, branch: worker.branch, decisions: worker.decisions, questions: worker.questions, checkExitCode: worker.checkExitCode }
  if (worker.status === 'blocked' || !worker.prNumber) {
    escalate(t.id, 'worker blocked (ambiguity)', worker.questions.join('; ') || 'no PR opened')
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
  const again = await agent(fixPrompt(t, w, fix, 'reopen'), { label: `worker:${t.id} reopen`, phase: ph.build, schema: WORKER_SCHEMA, ...MODELS.worker })
  if (!again || again.status === 'blocked') {
    escalate(t.id, 'worker blocked after revert', again ? again.questions.join('; ') : 'no result')
    return r
  }
  const w2 = { ...again, prNumber: again.prNumber || w.prNumber, prUrl: again.prUrl || w.prUrl, branch: again.branch || w.branch, worktree: again.worktree || w.worktree }
  const critic2 = await agent(criticPrompt(t, w2, 'reopen'), { label: `critic:${t.id} reopen`, phase: ph.review, schema: CRITIC_SCHEMA, ...MODELS.critic })
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
const gate = everyMerged && checkGreen && escalations.length === 0
log(gate ? `Wave ${WAVE} machine gate: PASS` : `Wave ${WAVE} machine gate: FAIL`)
return { project: NAME, wave: WAVE, gate: gate ? 'PASS' : 'FAIL', models: MODELS, state, tasks: results, escalations }
