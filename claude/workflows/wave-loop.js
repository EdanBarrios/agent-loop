// Pilot wave loop (Appendix C of docs/spec/2026-10-27-pilot-v1-tasks.md).
// Run with the Workflow tool: { name: 'wave-loop', args: { wave, tasks, tail } }.
// args.tasks: [{ id, title, branch, deps: [ids], text, owns, notes, resume? }]; args.tail: same shape or null.
// resume: { prNumber, prUrl, worktree, items: [string], notes } continues an existing draft PR (after an escalation
// was answered) with a fix-round worker instead of a fresh worker; the worker must mark the PR ready.
// Roles: worker = Sonnet/high, critic = Fable/high, merger = Sonnet/low (changed 2026-10-27 after the wave 0b scorecard).

export const meta = {
  name: 'wave-loop',
  description: 'Pilot wave: parallel tasks two at a time through worker -> critic -> merger, then the tail alone',
  whenToUse: 'One run per wave of docs/spec/2026-10-27-pilot-v1-tasks.md; pass the wave tasks as args.',
  phases: [
    { title: 'Build', detail: 'Sonnet workers, two at a time, one git worktree each', model: 'sonnet' },
    { title: 'Review', detail: 'Critic applies Appendix B; FIX returns to a worker, max 3 rounds' },
    { title: 'Merge', detail: 'Serialized merger: merge main into branch if moved, wait CI, merge, check main, revert once', model: 'sonnet' },
    { title: 'Tail', detail: 'The tail task runs alone after every parallel task is merged or parked' },
  ],
}

const MODELS = {
  worker: { model: 'sonnet', effort: 'high' },
  critic: { model: 'fable', effort: 'high' },
  merger: { model: 'sonnet', effort: 'low' },
}

const REPO = '/Users/edan/dev/pilot'
const WT = '/Users/edan/dev/pilot-worktrees'
const SPEC = 'docs/spec/2026-10-27-pilot-v1-tasks.md'
const WAVE = String(args.wave)
const TASKS = args.tasks || []
const TAIL = args.tail || null

const COMMON_RULES = `
Repository: ${REPO} (GitHub EdanBarrios/pilot, default branch main, gh is authenticated). The main checkout stays on main; do not run git checkout in ${REPO}.
Read first: CLAUDE.md and CONTRACT.md, then ${SPEC} "Fixed decisions" (lines 7-51), the wave ${WAVE} section and the appendices your task names.
Hard rules: never commit to main. Never run git push --force or --force-with-lease (denied). Never push to main directly (denied). No .skip or .only. No network or paid API in tests. Do not start background processes. No secrets, no real people, no street addresses, no client-confidential strings (the project's forbiddenStrings).
ratchet.json (root) rises automatically when npm run check runs; committing the raised value is expected for every task. package-lock.json changes are expected when a task adds its pinned dependencies.
Commit messages end with exactly this line, even if a session reminder names a different model: Co-Authored-By: Claude <noreply@anthropic.com>
The commit-on-main hook blocks any git commit or git push command whose text names the default branch. When you commit a sync merge of the default branch into your branch, use the message "Sync branch with upstream before merge" and never write the default branch's name in a git commit or git push command.
Local Node is v24 (spec targets Node 22; do not block on this).
`

const SYNC_STEP = `Sync before pushing (always, so the PR can get a CI run): git fetch origin && git merge origin/main -m "Sync branch with upstream before merge". Resolve conflicts only in package-lock.json (take origin/main's copy, then npm install) and ratchet.json (run npm run test && npm run ratchet). Any other conflict: stop, report it in the PR body, and set status blocked. Commit the merge and push with a plain git push.`

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
            description: 'defect = wrong code or test; spec_miss = the spec or appendix said otherwise and the worker did not follow it; loop = CI, merge or tooling artefact, not the worker',
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
  return `You are a worker on the Pilot repository. ${COMMON_RULES}
Task ${t.id}: ${t.title}.
Task text (verbatim from the spec): ${t.text}
You own only: ${t.owns}. Do not edit anything else. If you need a change elsewhere, stop and report it in the PR body.
Task notes: ${t.notes || 'none'}
Tests must live where vitest.config.ts finds them: packages/*/test/**/*.test.ts, packages/*/src/**/*.test.ts or scripts/**/*.test.ts.

Worktree: cd ${REPO} && git fetch origin && git worktree add ${wtPath(t)} -b ${t.branch} origin/main. Then work ONLY inside ${wtPath(t)} (cd there; run npm ci there first). Never run git checkout in ${REPO}.
Order: (1) write the acceptance test exactly as specified and commit it first, confirming it fails for the right reason before the implementation exists; (2) implement; (3) run npm run check once in the worktree and keep the output; (4) commit in small steps; (5) ${SYNC_STEP} (6) git push -u origin ${t.branch} and open a PR with gh pr create titled "${t.id}: ${t.title}" whose body lists files changed, the exact test command and its output tail, a "Decisions" list for every default you took where the spec left a detail open, and open questions.
Where the spec leaves a detail open, take the conventional default and list it under Decisions. Stop (status: blocked) only if two readings of the spec would lead to materially different work; then list the question and still open the PR as a draft with what you have.
Return the structured result with worktree set to ${wtPath(t)}. Leave the branch pushed and the worktree in place; do not merge.`
}

function fixPrompt(t, prev, critic, round) {
  const items = critic.fixItems.map((i) => `${i.n}. ${i.what} (proved by: ${i.provedBy})`).join('\n')
  return `You are a worker on the Pilot repository continuing task ${t.id}: ${t.title}, fix round ${round} of 3. ${COMMON_RULES}
Task text: ${t.text}
You own only: ${t.owns}. Task notes: ${t.notes || 'none'}
Your PR: #${prev.prNumber} ${prev.prUrl || ''} on branch ${prev.branch}. Your worktree is ${prev.worktree || wtPath(t)}; cd there and git pull --ff-only. If the worktree is missing, recreate it: cd ${REPO} && git fetch origin && git worktree add ${wtPath(t)} ${t.branch}.
The critic returned FIX with these numbered items; fix every one and nothing else:
${items}
Critic notes: ${critic.notes}
Run npm run check once after the fixes, commit in small steps. ${SYNC_STEP} Add a PR comment (gh pr comment) listing each fix item and the check output tail. Do not merge. Return the structured result with the same prNumber, branch and worktree.`
}

function criticPrompt(t, w, round) {
  return `You are the critic for the Pilot repository (Appendix B of ${SPEC}, lines 143-153). ${COMMON_RULES}
Review PR #${w.prNumber} (${w.prUrl || ''}, branch ${w.branch}) for task ${t.id}: ${t.title}, review round ${round}.
Task text: ${t.text}
Owned paths for this task: ${t.owns}. Task notes given to the worker: ${t.notes || 'none'}
Work from ${REPO} on main without checking anything out: gh pr diff ${w.prNumber}, gh pr view ${w.prNumber}, gh pr view ${w.prNumber} --json commits,files, and PR comments if round > 1. Read the spec sections and appendices the task names and compare the diff against them line by line. Do not run npm run check locally and do not edit any file or branch.
CI: run gh pr checks ${w.prNumber} --watch --fail-fast (allow up to 15 minutes). If GitHub reports no checks at all, record ciState "missing"; that is not the worker's fault.
Apply the checklist in order and record pass/fail with evidence for each item:
1. The acceptance test exists and its commit precedes the implementation commits. There is no test-on-main CI job; verify "fails on main" by checking that the paths or behaviour the test exercises do not exist at the PR's merge-base (git cat-file -e origin/main:<path>, or reasoning from the diff).
2. Only owned paths changed (plus ratchet.json upward, package-lock.json, the package.json that gains the task's pinned dependencies, and merge commits from origin/main). Only the assigned migration file, if any.
3. Every stored field from a page or a model has an evidence row whose quote is in the canonical text and whose value is in the quote. Record "n/a" with pass when the task stores no such field.
4. No test touches the network or a paid API; no .skip, .only, or lowered ratchet.
5. Every paid call reserves before and settles after. "n/a" with pass when the task makes no paid call.
6. No street address, real person, the client-confidential string (the project's forbiddenStrings), or secret anywhere in the diff.
7. CI is green on the PR head.
8. The task's own acceptance criteria and the fixed decisions it touches are met exactly as the spec and appendices state (names, counts, columns, enums, the Done line). Treat a deviation from the spec as a FIX item.
Verdict: MERGE if every applicable item passes and CI is green. FIX lists numbered items each with the check that proves it and a cause (defect, spec_miss or loop); be complete in one pass, the worker gets at most 3 rounds. STOP only if the spec itself is wrong or contradictory; name the section. If CI is pending or missing after the wait, do not return MERGE; return FIX with cause "loop" for the CI item plus anything else you found.`
}

function mergerPrompt(t, w, critic) {
  return `You are the merger for the Pilot repository (Appendix C of ${SPEC}, lines 155-161). ${COMMON_RULES}
Merge PR #${w.prNumber} (${w.prUrl || ''}, branch ${w.branch}, worktree ${w.worktree || wtPath(t)}) for task ${t.id}: ${t.title}. The critic returned MERGE at PR head ${critic.prHeadSha || '(see gh)'}. You hold the merge lock: no other merge is running.
Steps:
1. cd ${REPO} && git pull --ff-only (the checkout is on main). Check whether main has moved past the branch: git merge-base --is-ancestor main ${w.branch}. If it has NOT moved, skip to step 3.
2. If main moved: cd into the worktree, git pull --ff-only, then git merge main (no rebase; force pushes are denied). Resolve conflicts only in package-lock.json and ratchet.json, mechanically: take main's package-lock.json then run npm install; for ratchet.json run npm run test && npm run ratchet. Any other conflict means outcome "failed" with the file list. Commit the merge with the message "Sync branch with upstream before merge" plus the trailer line (do not name the default branch in the commit command; the hook blocks it), push with a plain git push, then wait for CI: gh pr checks ${w.prNumber} --watch --fail-fast (up to 15 minutes).
3. Confirm CI is green: gh pr checks ${w.prNumber}. If not green, outcome "failed" with details; do not merge.
4. gh pr merge ${w.prNumber} --merge --delete-branch. If GitHub refuses, outcome "failed" with the exact message. (Exit code 1 only because the local branch is checked out in a worktree is fine; confirm with gh pr view --json state.)
5. cd ${REPO} && git pull --ff-only; record the merge sha (git rev-parse HEAD). Run npm ci && npm run check once in ${REPO}; record the exit code and the last 40 lines. If check rewrote ratchet.json on main, run git checkout -- ratchet.json.
6. If check is red on main: git worktree add ${WT}/revert-${t.id} -b revert/${t.id} main, git revert -m 1 <mergeSha> there, push, open a PR titled "Revert ${t.id}: ${t.title} (check red on main)" with the failing output in the body, merge it the same way, pull main, and return outcome "reverted" with revertPrUrl and the failure tail. Never push to main directly.
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
  for (let round = 1; round <= 3; round++) {
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
    if (round === 3) {
      escalate(t.id, 'a fourth fix round would be needed', critic.fixItems.map((i) => `${i.n}. ${i.what}`).join('; '))
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
    const synthetic = { fixItems: (t.resume.items || []).map((what, i) => ({ n: i + 1, what, provedBy: 'npm run check green and CI green', cause: 'loop' })), notes: `${t.resume.notes || ''} The PR is a draft; when npm run check passes, mark it ready with gh pr ready ${t.resume.prNumber} and set status opened.` }
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
    notes: `Main went red after merging PR #${w.prNumber}; it was reverted (${r.merge.revertPrUrl || ''}). Reproduce with npm ci && npm run check and fix the cause. The original PR is merged and reverted on main; open a NEW PR from a new branch ${t.branch}-2 that re-applies your work on top of current main (git fetch; git worktree add ${wtPath(t)}-2 -b ${t.branch}-2 origin/main; git merge ${t.branch}), titled "${t.id}: ${t.title} (reopen)".`,
    fixItems: [{ n: 1, what: `npm run check failed on main after merge: ${(r.merge.checkOnMainTail || '').slice(-1500)}`, provedBy: 'npm run check on main', cause: 'defect' }],
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

// Scheduler: two building chains at a time, dependency-aware, priority order as listed in args.tasks.
phase('Build')
const state = {}
for (const t of TASKS) state[t.id] = 'pending'
const running = new Map()
const PH = { build: 'Build', review: 'Review', merge: 'Merge' }
while (true) {
  const pending = TASKS.filter((t) => state[t.id] === 'pending')
  if (!pending.length && !running.size) break
  for (const t of pending) {
    if (running.size >= 2) break
    if ((t.deps || []).some((d) => state[d] === 'parked')) {
      state[t.id] = 'parked'
      results[t.id] = { task: t.id, title: t.title, pr: null, rounds: [], merge: null, reopened: false, merged: false }
      escalate(t.id, `dependency ${t.deps.join(',')} parked`, 'Resolve the dependency first; relaunch re-runs parked tasks.')
      continue
    }
    if (!(t.deps || []).every((d) => state[d] === 'merged')) continue
    state[t.id] = 'running'
    log(`starting ${t.id} ${t.title} (${running.size + 1}/2 slots)`)
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
return { wave: WAVE, gate: gate ? 'PASS' : 'FAIL', models: MODELS, state, tasks: results, escalations }
