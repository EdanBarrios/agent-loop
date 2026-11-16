// Spec review: the decision logic behind the spec-review workflow. Pure except for the injected agent(),
// write() and log(), so tests need no Workflow runtime. The spec is "Wave 2, task 2.1" of the v2 task list.
//
// Flow: reviewer (pass 1) -> one low-effort spike per external fact -> reviewer re-run with the answers
// (only when there were facts) -> adversarial reviewer -> combine with the decision envelope. A `block`
// verdict adds exactly one more reviewer pass, never two. Nothing in the project is edited.

// Bundled into claude/workflows/spec-review.js after gates.js and envelope.js: keep top-level names unique across the three.
import { classify } from './envelope.js';
import { compareWaves } from './gates.js';

/**
 * @typedef {import('./envelope.js').Rec} Rec
 * @typedef {import('./gates.js').Gate} Gate
 * @typedef {{ file: string, find: string, replace: string }} SpecEdit
 * @typedef {{ id: string, fact: string, status: 'answered'|'open', answer: string, source: string, retrieved: string, error: string }} Spike
 * @typedef {{ id: string, verdict: 'agree'|'disagree'|'block', evidence: string, reason: string }} Verdict
 */

/** Role defaults; project.models.<role> overrides. The spike runs on a cheap model because its output is checked by its recorded source. */
export const DEFAULT_MODELS = Object.freeze({
  reviewer: { model: 'sonnet', effort: 'high' },
  spike: { model: 'haiku', effort: 'low' },
  adversary: { model: 'fable', effort: 'high' },
  writer: { model: 'haiku', effort: 'low' },
});

export const DEFAULT_OUT_DIR = '~/dev/agent-loop/docs';

const REC_FIELDS = ['id', 'kind', 'text', 'evidence', 'reverseCost', 'wouldBeWrongIf', 'reversible', 'costCents', 'touches', 'category', 'task', 'dependsOn', 'edits'];
const LEAD_ORDER = { days: 0, hours: 1, minutes: 2 };

const REC_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['defect', 'question'] },
    text: { type: 'string', description: 'the defect or question, and the recommended resolution' },
    evidence: { type: 'string', description: 'a quote, fixture, fetched source or command output; an opinion is not evidence' },
    reverseCost: { type: 'string' },
    wouldBeWrongIf: { type: 'string' },
    reversible: { type: 'boolean', description: 'true only if one revert PR or one config edit undoes it' },
    costCents: { type: 'integer' },
    touches: { type: 'array', items: { type: 'string' }, description: "'invariant', 'fixed_decision' or any other string" },
    category: { type: 'string' },
    task: { type: 'string', description: 'task id the item is about, if any' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'ids of external facts this recommendation relies on' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } },
        required: ['file', 'find', 'replace'],
      },
    },
    reasoning: { type: 'string' },
  },
  required: ['id', 'kind', 'text', 'evidence', 'reverseCost', 'wouldBeWrongIf', 'reversible', 'costCents', 'touches', 'category'],
};

export const REVIEWER_SCHEMA = {
  type: 'object',
  properties: {
    recs: { type: 'array', items: REC_SCHEMA },
    externalFacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, fact: { type: 'string' } },
        required: ['id', 'fact'],
      },
    },
    gates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string' },
          why: { type: 'string' },
          before: { type: 'string', description: 'wave id the item must be settled before' },
          leadTime: { type: 'string', enum: ['minutes', 'hours', 'days'] },
          task: { type: 'string' },
          kind: { type: 'string', enum: ['secret', 'account', 'quota', 'plan', 'legal', 'irreversible'] },
        },
        required: ['what', 'why', 'before', 'leadTime'],
      },
    },
  },
  required: ['recs', 'externalFacts', 'gates'],
};

export const SPIKE_SCHEMA = {
  type: 'object',
  properties: { fact: { type: 'string' }, answer: { type: 'string' }, source: { type: 'string' }, retrieved: { type: 'string' } },
  required: ['fact', 'answer', 'source', 'retrieved'],
};

export const ADVERSARY_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['agree', 'disagree', 'block'] },
          evidence: { type: 'string', description: 'what you checked: a fixture, a fetched source, a command output' },
          reason: { type: 'string' },
        },
        required: ['id', 'verdict', 'evidence', 'reason'],
      },
    },
  },
  required: ['verdicts'],
};

export const WRITER_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
  required: ['path', 'bytes'],
};

// ---------------------------------------------------------------------------------------------
// Gate items

const KINDS = {
  secret: { pattern: /\b(?:api|vendor|service|access|secret|private)[ -]keys?\b|\bsecrets?\b|\bcredentials?\b/i, what: 'Create the secret or key', lead: 'minutes' },
  quota: { pattern: /\bquotas?\b/i, what: 'Request the quota', lead: 'days' },
  plan: { pattern: /\b(?:paid|vendor|pricing|subscription) plans?\b/i, what: 'Choose and pay for the vendor plan', lead: 'hours' },
  account: { pattern: /\b(?:create|open|sign up for|register) an? (?:\w+ )?account\b|\baccount (?:setup|creation)\b/i, what: 'Create the account', lead: 'hours' },
  legal: { pattern: /\b(?:privacy (?:policy|page)|terms of service|legal (?:text|wording))\b/i, what: 'Write or approve the legal wording', lead: 'hours' },
  irreversible: { pattern: /\b(?:schema migrations?|migrations? (?:on|to|against) (?:the )?(?:real|production|prod)\b|\bdns\b|drop table)/i, what: 'Approve the irreversible production step', lead: 'minutes' },
};
const SLOW = /\b\d+\s*(?:business\s+)?(?:days?|weeks?)\b|\bwaitlist\b|\bmanual approval\b|\bresubmit\b|\bdays-long\b/i;

/** @param {string} text @param {string} [fallback] */
function inferLead(text, fallback = 'hours') {
  if (SLOW.test(text)) return 'days';
  return fallback;
}

/** @param {{ id: string, wave?: string }} t @param {string} fallback */
function waveOf(t, fallback) {
  if (t && t.wave !== undefined && t.wave !== '') return String(t.wave);
  const m = t && typeof t.id === 'string' ? t.id.match(/^(\d+[a-z]?)\./i) : null;
  return m ? m[1] : fallback;
}

/**
 * Deterministic safety net for step 1b: scan task texts for secrets, accounts, quotas, vendor plans, legal
 * text and irreversible production steps. One gate per task and kind, `before` is the task's wave.
 * @param {Array<{ id: string, wave?: string, text: string }>} tasks
 * @param {string} [fallbackWave]
 * @returns {Gate[]}
 */
export function scanTasks(tasks, fallbackWave = '0') {
  const out = [];
  for (const t of tasks || []) {
    const text = String(t?.text ?? '');
    for (const [kind, k] of Object.entries(KINDS)) {
      const m = text.match(k.pattern);
      if (!m) continue;
      out.push({
        id: `G-${t.id}-${kind}`,
        what: `${k.what} for task ${t.id}`,
        why: `scan: task ${t.id} mentions "${m[0]}"`,
        owner: 'human',
        before: waveOf(t, fallbackWave),
        leadTime: inferLead(text, k.lead),
        status: 'open',
        evidence: '',
      });
    }
  }
  return out;
}

/**
 * Turn the reviewer's gate items into gates.json items, fill defaults, merge with the scan (a reviewer
 * item for the same task and kind replaces the scanned one), drop duplicate ids, sort longest lead first.
 * @param {Array<Record<string, any>>} reviewerGates
 * @param {Gate[]} scanned
 * @param {string} wave  wave under review, the default for `before`
 * @param {Array<{ id: string, wave?: string }>} tasks
 * @returns {Gate[]}
 */
export function mergeGates(reviewerGates, scanned, wave, tasks) {
  const byTask = new Map((tasks || []).map((t) => [t.id, t]));
  const replaced = new Set();
  const fromReviewer = [];
  (reviewerGates || []).forEach((g, i) => {
    if (!g || typeof g.what !== 'string' || g.what.trim() === '') return;
    const task = typeof g.task === 'string' ? g.task : '';
    const kind = typeof g.kind === 'string' ? g.kind : '';
    if (task && kind) replaced.add(`G-${task}-${kind}`);
    const lead = g.leadTime in LEAD_ORDER ? g.leadTime : inferLead(`${g.what} ${g.why ?? ''}`);
    fromReviewer.push({
      id: typeof g.id === 'string' && g.id ? g.id : `G-${task || 'wave' + wave}-${kind || 'r' + (i + 1)}`,
      what: g.what,
      why: typeof g.why === 'string' && g.why ? g.why : 'raised by the spec reviewer',
      owner: 'human',
      before: typeof g.before === 'string' && g.before ? g.before : task && byTask.has(task) ? waveOf(byTask.get(task), wave) : wave,
      leadTime: lead,
      status: 'open',
      evidence: '',
    });
  });
  const seen = new Set();
  const all = [...fromReviewer, ...scanned.filter((g) => !replaced.has(g.id))].filter((g) => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });
  return all.sort((a, b) => LEAD_ORDER[a.leadTime] - LEAD_ORDER[b.leadTime] || compareWaves(a.before, b.before) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Small-wave skip

/** A wave of at most this many tasks, all `lane: 'fast'`, may skip the reviewers (fixed decision "Spec review skip"). */
export const SKIP_MAX_TASKS = 3;

/**
 * The skip rule: 1 to SKIP_MAX_TASKS tasks, every one marked `lane: 'fast'` by the session, and the
 * human-only scan (scanTasks) finds nothing. Any scan hit, any other lane, an empty list or a bigger wave
 * means the full review.
 * @param {Array<{ id: string, wave?: string, lane?: string, text: string }>} tasks
 * @returns {{ skip: boolean, reason: string }}
 */
export function smallWaveSkip(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return { skip: false, reason: 'no tasks given: full review' };
  if (list.length > SKIP_MAX_TASKS) return { skip: false, reason: `${list.length} tasks (more than ${SKIP_MAX_TASKS}): full review` };
  const notFast = list.filter((t) => t?.lane !== 'fast').map((t) => t?.id);
  if (notFast.length) return { skip: false, reason: `task ${notFast.join(', ')} is not Lane: fast: full review` };
  const hits = scanTasks(list);
  if (hits.length) return { skip: false, reason: `human-only scan hit (${hits.map((g) => g.id).join(', ')}): full review` };
  return { skip: true, reason: `${list.length} tasks, all Lane: fast, no human-only scan hit: reviewers skipped` };
}

// ---------------------------------------------------------------------------------------------
// Combining

/**
 * Step 5: classify every rec with the envelope, then let the adversary override. `disagree` and `block`
 * force `ask`; so does a missing verdict and a dependency on a fact the spikes left open.
 * @param {{ recs: Rec[], verdicts: Verdict[], spikes: Spike[], project?: object }} input
 * @returns {{ accepted: Array<Record<string, any>>, asked: Array<Record<string, any>> }}
 */
export function combine({ recs, verdicts, spikes, project }) {
  const verdictById = new Map((verdicts || []).map((v) => [v.id, v]));
  const open = new Set((spikes || []).filter((s) => s.status !== 'answered').map((s) => s.id));
  const accepted = [];
  const asked = [];
  for (const rec of recs) {
    const cls = classify(rec, project);
    const v = verdictById.get(rec.id);
    const reasons = [];
    if (cls.decision === 'ask') reasons.push(`envelope: ${cls.reason}`);
    if (!v || !['agree', 'disagree', 'block'].includes(v.verdict)) {
      reasons.push('no adversary verdict');
    } else if (v.verdict !== 'agree') {
      reasons.push(`adversary ${v.verdict}: ${v.reason || 'no reason given'}${v.evidence ? ` (${v.evidence})` : ''}`);
    }
    const openDeps = (Array.isArray(rec.dependsOn) ? rec.dependsOn : []).filter((d) => open.has(d));
    if (openDeps.length) reasons.push(`depends on open fact ${openDeps.join(', ')}`);
    const adversary = v ? { verdict: v.verdict, evidence: v.evidence ?? '', reason: v.reason ?? '' } : null;
    if (reasons.length) asked.push({ ...rec, decision: 'ask', reason: reasons.join('; '), adversary });
    else accepted.push({ ...rec, decision: 'accept', reason: cls.reason, adversary });
  }
  return { accepted, asked };
}

// ---------------------------------------------------------------------------------------------
// Prompts

/** @param {Rec} r */
function stripRec(r) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of REC_FIELDS) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

const REC_SHAPE = `Each recommendation has: id, kind (defect|question), text (the problem and your recommended resolution), evidence (a quote from the spec, a fixture, a fetched source or a command output: an opinion is not evidence and will be sent to the human), reverseCost, wouldBeWrongIf (what observation would show you are wrong), reversible (true only if one revert PR or one config edit undoes it), costCents (integer), touches (include "invariant" or "fixed_decision" if it changes one), category (one word: money, secret, account, quota, vendor_plan, legal, privacy, schema_migration, send, delete, dns, or any other), task (task id if any), dependsOn (ids of external facts it relies on), edits (exact { file, find, replace } spec edits that would apply it).`;

/**
 * @param {{ project: any, specPath: string, wave: string, tasks?: any[] }} c
 * @param {{ pass: 1|2|3, spikes?: Spike[], recs?: any[], blocked?: Array<{ rec: any, adversary: any }> }} p
 */
export function reviewerPrompt(c, p) {
  const name = c.project.name;
  const head = `You are the spec reviewer for the ${name} project. Read ${c.specPath}: the header sections (End goal, Invariants, Budget, Decision envelope, Fixed decisions, Human checklist) and the wave ${c.wave} section. You may read other files in the repository ${c.project.repo ?? ''} and run read-only commands. Edit nothing.`;
  if (p.pass === 3) {
    return `${head}
This is the one extra pass after the adversarial reviewer blocked these recommendations. For each, return one revised recommendation with the same id that answers the objection, or leave it out if no safe revision exists. Do not repeat the ones that are not listed. Return recs only (externalFacts and gates may be empty arrays).
${REC_SHAPE}
Blocked:
${JSON.stringify(p.blocked, null, 2)}`;
  }
  if (p.pass === 2) {
    // v2.3.1: a targeted pass. It revises only the recommendations that rely on an external fact, instead of re-running
    // the whole review (Warden wave 2: 13.4 min and 142K tokens to absorb 7 spike answers); every other first-pass
    // recommendation is kept as it was.
    return `${head}
This is the re-run after the spikes. Spike agents researched the external facts you listed; each answer has a recorded source. Revise only the recommendations listed below, which rely on those facts: return each one revised with the same id (set dependsOn to the facts it still relies on that are open), or leave it out if a spike answer shows it is wrong. Do not repeat or re-review any other recommendation; they are kept as they were. Add a new recommendation only when a spike answer itself shows a defect or a question that none of your recommendations covers. Return recs (externalFacts and gates may be empty arrays).
${REC_SHAPE}
Recommendations to revise:
${JSON.stringify(p.recs ?? [], null, 2)}
Spike results:
${JSON.stringify(p.spikes, null, 2)}`;
  }
  return `${head}
Review every wave ${c.wave} task against the spec for defects (ambiguity, contradiction, a missing owner or test, a dependency that is not listed) and for questions only a human can settle. Return each as a recommendation.
${REC_SHAPE}
externalFacts: facts outside the repository that you could not settle (a vendor limit, a price, an API behaviour). Give each an id F1, F2, ... and one question. Do not guess them.
Also check whether any task's change breaks a test file that another task owns (often an earlier wave's tail test that pins an exact result shape with toEqual, or an import path); a worker may edit only the paths it owns, so if one does, recommend who edits that test and record it in the spec's owner table.
gates: scan every task and every fixed decision for secrets, accounts, quotas, vendor plans, legal text and irreversible production steps. Return one gate item for each, with what, why, before (the wave id of the first task that needs it), leadTime (minutes, hours or days; days for anything with an approval queue or a quota request), task and kind (secret|account|quota|plan|legal|irreversible).`;
}

/** @param {{ specPath: string, wave: string, project: any }} c @param {Rec[]} recs */
export function adversaryPrompt(c, recs) {
  return `You are the adversarial reviewer for the ${c.project.name} project. You are given the spec (${c.specPath}, wave ${c.wave}) and a list of recommendations. You are not given how they were reached, on purpose.
Prefer evidence over argument: check each recommendation against the spec text, a fixture, a fetched source or the output of a read-only command, and record what you checked in "evidence". A disagreement with no evidence behind it is not a disagreement; an agreement with nothing checked is not an agreement.
Return one verdict per recommendation id: agree (it holds up), disagree (it is wrong or unsafe, and a human should decide), or block (it must not be applied in any form until it is reworked). Edit nothing.
Recommendations:
${JSON.stringify(recs.map(stripRec), null, 2)}`;
}

/** @param {{ project: any }} c @param {{ id: string, fact: string }} f */
export function spikePrompt(c, f) {
  return `You are a research spike for the ${c.project.name} project. Settle one external fact from documentation or a read-only probe (a GET, a --help, a dry run). Never spend money, create an account, send anything or change anything.
Fact ${f.id}: ${f.fact}
Return { fact, answer, source, retrieved }: the question, the answer, the exact URL or command you got it from, and the date you retrieved it. Return what the source says, never a recommendation. If you cannot settle it from a source, say so in the answer and leave source empty.`;
}

// ---------------------------------------------------------------------------------------------
// The run

/** @param {any} f @param {number} i */
function normaliseFact(f, i) {
  if (typeof f === 'string') return { id: `F${i + 1}`, fact: f };
  return { id: typeof f?.id === 'string' && f.id ? f.id : `F${i + 1}`, fact: String(f?.fact ?? '') };
}

/** @param {string} s */
const isBlankText = (s) => typeof s !== 'string' || s.trim() === '';

/**
 * Run one spike. A failure, a null result or an answer with no recorded source is an open fact; never retried.
 * @returns {Promise<Spike>}
 */
async function runSpike(ctx, f, agent, model) {
  /** @type {Spike} */
  const open = { id: f.id, fact: f.fact, status: 'open', answer: '', source: '', retrieved: '', error: '' };
  let r;
  try {
    r = await agent(spikePrompt(ctx, f), { label: `spike:${f.id}`, phase: 'Spikes', schema: SPIKE_SCHEMA, ...model });
  } catch (err) {
    return { ...open, error: `spike failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!r) return { ...open, error: 'spike returned nothing' };
  if (isBlankText(r.source)) return { ...open, answer: String(r.answer ?? ''), error: 'no source recorded, so the answer cannot be checked' };
  if (isBlankText(r.answer)) return { ...open, source: r.source, retrieved: String(r.retrieved ?? ''), error: 'empty answer' };
  return { id: f.id, fact: f.fact, status: 'answered', answer: r.answer, source: r.source, retrieved: String(r.retrieved ?? ''), error: '' };
}

/**
 * The review file. No date, no file (scripts have no clock); a writer failure does not lose the result.
 * Sets `out.reviewPath` when the file was written.
 * @param {{ project: { name: string }, wave: string|number, date?: string, write?: (path: string, text: string) => Promise<void>, outDir?: string }} input
 * @param {{ wave: string, reviewPath: string|null }} out
 * @param {(msg: string) => void} log
 */
async function writeReview(input, out, log) {
  if (input.date && input.write) {
    const dir = `${input.outDir ?? DEFAULT_OUT_DIR}/${String(input.project.name).toLowerCase()}`;
    const path = `${dir}/${input.date}-wave-${out.wave}-review.json`;
    try {
      await input.write(path, JSON.stringify({ ...out, reviewPath: path }, null, 2) + '\n');
      out.reviewPath = path;
    } catch (err) {
      log(`could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log('no date or writer given: the review file was not written');
  }
}

/**
 * The whole review. Returns the output object and, when `date` is given, writes it as JSON through `write`.
 * @param {{
 *   project: { name: string, models?: Record<string, {model: string, effort: string}>, envelope?: object, [k: string]: any },
 *   specPath: string,
 *   wave: string,
 *   date?: string,
 *   tasks?: Array<{ id: string, wave?: string, text: string }>,
 *   agent: (prompt: string, opts: Record<string, any>) => Promise<any>,
 *   write?: (path: string, text: string) => Promise<void>,
 *   outDir?: string,
 *   log?: (msg: string) => void,
 * }} input
 */
export async function runSpecReview(input) {
  const { project, specPath, agent } = input;
  const wave = String(input.wave);
  const log = input.log ?? (() => {});
  const tasks = input.tasks ?? [];
  const models = { ...DEFAULT_MODELS, ...(project.models ?? {}) };
  const ctx = { project, specPath, wave, tasks };

  // (0): small all-fast waves with a clean scan skip the reviewers; the scan result is the gate list (empty).
  const skip = smallWaveSkip(tasks);
  log(`spec-review: ${skip.reason}`);
  if (skip.skip) {
    const out = {
      project: project.name,
      wave,
      accepted: [],
      asked: [],
      spikes: [],
      gates: [],
      specEdits: [],
      needsSecondRound: false,
      skipped: true,
      skipReason: skip.reason,
      reviewPath: /** @type {string|null} */ (null),
    };
    await writeReview(input, out, log);
    return out;
  }

  // (1) and (1b): first reviewer pass.
  const r1 = await agent(reviewerPrompt(ctx, { pass: 1 }), { label: 'reviewer r1', phase: 'Review', schema: REVIEWER_SCHEMA, ...models.reviewer });
  if (!r1 || !Array.isArray(r1.recs)) throw new Error('spec-review: the reviewer returned nothing; nothing to combine');
  let gates = [...(r1.gates ?? [])];

  // (2): one spike per external fact, concurrently, none retried.
  const facts = (r1.externalFacts ?? []).map(normaliseFact).filter((f) => f.fact);
  const spikes = await Promise.all(facts.map((f) => runSpike(ctx, f, agent, models.spike)));
  const openCount = spikes.filter((s) => s.status === 'open').length;
  if (spikes.length) log(`spikes: ${spikes.length - openCount} answered, ${openCount} open`);

  // (3): a targeted reviewer pass, only if there were facts to give it: it revises the recommendations that rely on a
  // fact (dependsOn) and may add new ones a spike answer shows; every other first-pass recommendation is kept as it was.
  let recs = r1.recs;
  if (facts.length) {
    const factIds = new Set(facts.map((f) => f.id));
    const dependent = r1.recs.filter((r) => Array.isArray(r.dependsOn) && r.dependsOn.some((d) => factIds.has(d)));
    const r2 = await agent(reviewerPrompt(ctx, { pass: 2, spikes, recs: dependent.map(stripRec) }), { label: 'reviewer r2', phase: 'Review', schema: REVIEWER_SCHEMA, ...models.reviewer });
    if (r2 && Array.isArray(r2.recs)) {
      // In first-pass order: a revised recommendation takes its original's place (or is dropped when pass 2 left it
      // out); one pass 2 repeats without being asked is ignored; new ones go at the end.
      const revisedIds = new Set(dependent.map((r) => r.id));
      const firstIds = new Set(r1.recs.map((r) => r.id));
      const fromR2 = new Map(r2.recs.map((r) => [r.id, r]));
      recs = [
        ...r1.recs.flatMap((r) => (revisedIds.has(r.id) ? (fromR2.has(r.id) ? [fromR2.get(r.id)] : []) : [r])),
        ...r2.recs.filter((r) => !firstIds.has(r.id)),
      ];
      gates = [...gates, ...(r2.gates ?? [])];
      log(`reviewer r2 revised ${dependent.length} recommendation${dependent.length === 1 ? '' : 's'} that rely on a fact; ${r1.recs.length - dependent.length} kept from the first pass`);
    } else {
      log('reviewer re-run returned nothing; keeping the first pass');
    }
  }

  // (4): adversarial review. It sees the spec and the stripped recommendations only.
  const adv = await agent(adversaryPrompt(ctx, recs), { label: 'adversary', phase: 'Adversary', schema: ADVERSARY_SCHEMA, ...models.adversary });
  const verdicts = adv && Array.isArray(adv.verdicts) ? adv.verdicts : [];
  if (!adv) log('adversary returned nothing; every recommendation is asked');

  // (5): envelope, then the adversary's override.
  const combined = combine({ recs, verdicts, spikes, project });
  let { accepted, asked } = combined;

  // One extra reviewer pass if anything was blocked; never a second.
  const blocked = asked.filter((r) => r.adversary?.verdict === 'block');
  const needsSecondRound = blocked.length > 0;
  if (needsSecondRound) {
    const r3 = await agent(
      reviewerPrompt(ctx, { pass: 3, blocked: blocked.map((r) => ({ rec: stripRec(r), adversary: r.adversary })) }),
      { label: 'reviewer r3', phase: 'Review', schema: REVIEWER_SCHEMA, ...models.reviewer },
    );
    const revised = new Map(((r3 && Array.isArray(r3.recs)) ? r3.recs : []).map((r) => [r.id, r]));
    if (r3 && Array.isArray(r3.gates)) gates = [...gates, ...r3.gates];
    asked = asked.map((r) => (r.adversary?.verdict === 'block' ? { ...r, revision: revised.get(r.id) ?? null } : r));
  }

  const specEdits = accepted.flatMap((r) => (Array.isArray(r.edits) ? r.edits.map((e) => ({ file: e.file, find: e.find, replace: e.replace, recId: r.id })) : []));
  const out = {
    project: project.name,
    wave,
    accepted,
    asked,
    spikes,
    gates: mergeGates(gates, scanTasks(tasks, wave), wave, tasks),
    specEdits,
    needsSecondRound,
    skipped: false,
    skipReason: '',
    reviewPath: /** @type {string|null} */ (null),
  };

  await writeReview(input, out, log);
  return out;
}
