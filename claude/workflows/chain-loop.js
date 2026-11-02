// Chain loop: runs a list of waves in order, one wave-loop call per wave, and stops when a wave's result says to.
// Run with the Workflow tool: { name: 'chain-loop', args: { project, waves: [{ wave, tasks, tail }] } }.
// args.project: the parsed .claude/loop.local.json. args.waves: the waves to run, in order, each shaped as for wave-loop.
// Each wave runs through workflow('wave-loop', { project, wave, tasks, tail }); nesting is one level, so wave-loop
// itself never calls workflow() and runs exactly as in v1. Chaining follows project.chain (default: chain after wave 1
// when the first-pass merge rate is at least 0.7; chain: false runs one wave and stops).
// Returns { waves: [waveResult...], stoppedBecause, remaining: [wave ids], error? }. stoppedBecause is one of
// complete, chain_off, gate_fail, escalation, reality_gap, first_pass_low, learning_gate, child_error.
// A wave-loop call that throws stops the chain and is reported in error; it is never retried.
// All decision logic is in claude/lib/chain.js; this script only wires the runtime's workflow() and log() to it.

export const meta = {
  name: 'chain-loop',
  description: 'Run several waves in order through wave-loop, stopping on a failed gate, an escalation, a reality gap or a low first-pass rate',
  whenToUse: 'After the learning wave of a project has been read by a human; pass .claude/loop.local.json as args.project and the waves as args.waves.',
  phases: [{ title: 'Waves', detail: 'One wave-loop run per wave, in order; the chain stops as soon as shouldContinue says no' }],
}

const P = args.project || {}
if (!P.name) throw new Error('args.project.name is missing. Read .claude/loop.local.json in the repo and pass it as args.project.')

// The runtime accepts only self-contained scripts, so the libs are bundled here by scripts/bundle-workflows.js.
// Order matters: chain.js needs compareWaves (gates.js), so gates comes first.
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
// @bundle-start chain
// generated from claude/lib/chain.js by scripts/bundle-workflows.js: do not edit
// Chain logic: when a finished wave lets the next one start by itself. Pure functions with the runtime's
// workflow() injected; the chain-loop workflow script only wires them. Bundled into claude/workflows/chain-loop.js.

const DEFAULT_AFTER = '1';
const DEFAULT_MIN_FIRST_PASS_RATE = 0.7;

/**
 * Chain settings with defaults applied. `chain: false` is handled by the caller; any other non-object
 * (undefined, true) means the defaults.
 * @param {any} project
 * @returns {{ after: string, minFirstPassRate: number }}
 */
function chainSettings(project) {
  const c = project && typeof project.chain === 'object' && project.chain !== null ? project.chain : {};
  const after = c.after === undefined || c.after === null || c.after === '' ? DEFAULT_AFTER : String(c.after);
  const rate = typeof c.minFirstPassRate === 'number' && Number.isFinite(c.minFirstPassRate) ? c.minFirstPassRate : DEFAULT_MIN_FIRST_PASS_RATE;
  return { after, minFirstPassRate: rate };
}

/**
 * Share of a wave's tasks whose first review round was MERGE (rounds[0].verdict). A wave with no tasks counts as 1.
 * @param {{ tasks?: Record<string, { rounds?: Array<{ verdict?: string | null }> }> | Array<{ rounds?: Array<{ verdict?: string | null }> }> }} waveResult
 * @returns {number}
 */
function firstPassRate(waveResult) {
  const tasks = waveResult && waveResult.tasks ? Object.values(waveResult.tasks) : [];
  if (tasks.length === 0) return 1;
  const first = tasks.filter((t) => t && Array.isArray(t.rounds) && t.rounds[0] && t.rounds[0].verdict === 'MERGE').length;
  return first / tasks.length;
}

/**
 * Whether the chain may start the next wave. Checked in this order, so the reason is the most specific one:
 * chain_off, reality_gap, gate_fail, escalation, learning_gate, first_pass_low.
 * @param {{ wave?: string, gate?: string, escalations?: Array<{ what?: string }> }} waveResult the wave that just finished
 * @param {{ chain?: false | { after?: string, minFirstPassRate?: number } }} project
 * @param {string | null} nextWave the wave that would run next (informational)
 * @param {number} firstPassRate the finished wave's first-pass merge rate
 * @returns {{ go: boolean, reason: string | null }}
 */
function shouldContinue(waveResult, project, nextWave, firstPassRate) {
  if (project && project.chain === false) return { go: false, reason: 'chain_off' };
  const { after, minFirstPassRate } = chainSettings(project);
  const escalations = Array.isArray(waveResult && waveResult.escalations) ? waveResult.escalations : [];
  if (escalations.some((e) => e && /reality_gap/.test(String(e.what ?? '')))) return { go: false, reason: 'reality_gap' };
  if (!waveResult || waveResult.gate !== 'PASS') return { go: false, reason: 'gate_fail' };
  if (escalations.length > 0) return { go: false, reason: 'escalation' };
  if (compareWaves(String(waveResult.wave), after) < 0) return { go: false, reason: 'learning_gate' };
  if (!(firstPassRate >= minFirstPassRate)) return { go: false, reason: 'first_pass_low' };
  return { go: true, reason: null };
}

/**
 * Run waves in order through the runtime's workflow('wave-loop', ...), one call per wave. A wave-loop call that
 * throws or returns nothing stops the chain and is reported once; it is never retried.
 * @param {{ project: any, waves: Array<{ wave: string, tasks: any[], tail?: any }>, workflow: (name: string, args: any) => Promise<any>, log?: (s: string) => void }} io
 * @returns {Promise<{ waves: any[], stoppedBecause: string, remaining: string[], error?: { wave: string, message: string } }>}
 */
async function runChain({ project, waves, workflow, log = () => {} }) {
  if (!Array.isArray(waves) || waves.length === 0) throw new Error('args.waves is missing or empty: pass [{ wave, tasks, tail }] in the order to run.');
  waves.forEach((w, i) => {
    if (!w || w.wave === undefined || w.wave === null || w.wave === '') throw new Error(`args.waves[${i}].wave is missing.`);
  });
  const ids = waves.map((w) => String(w.wave));
  /** @type {any[]} */
  const results = [];
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    let result;
    try {
      result = await workflow('wave-loop', { project, wave: ids[i], tasks: w.tasks || [], tail: w.tail ?? null });
      if (!result || typeof result !== 'object') throw new Error('wave-loop returned nothing');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`Chain stopped: wave ${ids[i]} failed to run (${message}); not retried`);
      return { waves: results, stoppedBecause: 'child_error', remaining: ids.slice(i + 1), error: { wave: ids[i], message } };
    }
    results.push(result);
    if (i === waves.length - 1) break;
    const rate = firstPassRate(result);
    const decision = shouldContinue(result, project, ids[i + 1], rate);
    log(`Chain after wave ${ids[i]}: gate ${result.gate}, first-pass ${Math.round(rate * 100)}%, ${decision.go ? `continue to wave ${ids[i + 1]}` : `stop (${decision.reason})`}`);
    if (!decision.go) return { waves: results, stoppedBecause: String(decision.reason), remaining: ids.slice(i + 1) };
  }
  return { waves: results, stoppedBecause: 'complete', remaining: [] };
}
// @bundle-end chain

phase('Waves')
return await runChain({ project: P, waves: args.waves, workflow, log })
