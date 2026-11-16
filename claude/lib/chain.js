// Chain logic: when a finished wave lets the next one start by itself. Pure functions with the runtime's
// workflow() injected; the chain-loop workflow script only wires them. Bundled into claude/workflows/chain-loop.js.
import { compareWaves } from './gates.js';

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
export function firstPassRate(waveResult) {
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
export function shouldContinue(waveResult, project, nextWave, firstPassRate) {
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
 * Run waves in order through the runtime's workflow(waveLoop, ...), one call per wave. A wave-loop call that
 * throws or returns nothing stops the chain and is reported once; it is never retried. `gates` (the parsed gate
 * checklist, an array) is forwarded unchanged on every child call; when it is undefined the child args carry no
 * `gates` key (the v1 shape). The session re-reads the gate file and relaunches the chain to pick up changes.
 * `waveLoop` is what workflow() is called with: the name 'wave-loop' (the default) or `{ scriptPath }`. A name resolves
 * from the session's own .claude/workflows, which can be another copy of the loop (loop 2.3.0). `loopVersion`, when
 * given, must equal every wave result's loopVersion; a wave that reports another one (or none) stops the chain as a
 * child_error that names both versions, so a stale wave-loop never runs a second wave.
 * @param {{ project: any, waves: Array<{ wave: string, tasks: any[], tail?: any }>, workflow: (ref: any, args: any) => Promise<any>, log?: (s: string) => void, gates?: any[], waveLoop?: string | { scriptPath: string }, loopVersion?: string }} io
 * @returns {Promise<{ waves: any[], stoppedBecause: string, remaining: string[], error?: { wave: string, message: string } }>}
 */
export async function runChain({ project, waves, workflow, log = () => {}, gates, waveLoop = 'wave-loop', loopVersion }) {
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
      /** @type {any} */
      const childArgs = { project, wave: ids[i], tasks: w.tasks || [], tail: w.tail ?? null };
      if (gates !== undefined) childArgs.gates = gates;
      result = await workflow(waveLoop, childArgs);
      if (!result || typeof result !== 'object') throw new Error('wave-loop returned nothing');
      if (loopVersion !== undefined && result.loopVersion !== loopVersion) {
        const where = typeof waveLoop === 'string' ? `the workflow named '${waveLoop}'` : `${waveLoop.scriptPath}`;
        throw new Error(`chain-loop is loop ${loopVersion}, but ${where} reported ${result.loopVersion ? `loop ${result.loopVersion}` : 'no loop version'}: another copy of the loop ran this wave. Pass args.waveLoop = { scriptPath: '<the loop checkout>/claude/workflows/wave-loop.js' } or relink the project's .claude/workflows, then relaunch`);
      }
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
