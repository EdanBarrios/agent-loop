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
export const HUMAN_ONLY_CATEGORIES = Object.freeze([
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
export function classify(rec, project) {
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
export function ledger(decisions) {
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
