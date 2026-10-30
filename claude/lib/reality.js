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
export async function runReality(cfg, exec) {
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
