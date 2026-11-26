// Benchmark metrics (task 4.3, formerly 4.4): the record of one replayed wave and the comparison of several.
//
// Pure functions; scripts/bench.js and bench/scenario.js wire the file system and git. A record is
//   { scenario, config, loop: { commit, version }, ciJobs, makespanMs, agentMinutes, tokens: { total, perRole },
//     tasks: { merged, total }, fixRounds, escalations, reverts, holdout: { passed, total } | null,
//     load: { samples, mean, max } | null, agents, outputs }
// and `config` is the key of bench/scenario.js (configKey): records with the same key pool, others never do.
//
// Intervals are 95%: Wilson for rates, a t interval for times, counts and tokens (the constant table below, 1.96 above
// 30 degrees of freedom, no interval for fewer than 2 records) and, for the difference of two configs, Welch's with the
// degrees of freedom rounded down.
// Reads or writes: nothing (pure).

/** Two-sided 95% quantiles of Student's t for 1 to 30 degrees of freedom (index = degrees of freedom - 1). */
export const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120,
  2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];
const Z95 = 1.96;

/**
 * The two-sided 95% t quantile for a number of degrees of freedom (a whole number of at least 1).
 * @param {number} df
 */
export function tQuantile(df) {
  if (!(df >= 1)) return null;
  return df > T95.length ? Z95 : T95[Math.floor(df) - 1];
}

/**
 * 95% Wilson score interval of k successes in n trials.
 * @param {number} k
 * @param {number} n
 * @returns {{ mean: number | null, lo: number | null, hi: number | null, k: number, n: number }}
 */
export function wilson(k, n) {
  if (!(n > 0)) return { mean: null, lo: null, hi: null, k, n };
  const p = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { mean: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half), k, n };
}

/** Mean and sample standard deviation (n - 1); sd is 0 for a single value. */
function meanSd(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd };
}

/**
 * Mean with a 95% t interval; lo and hi are null for fewer than 2 values, the mean for none.
 * @param {number[]} values
 * @returns {{ mean: number | null, lo: number | null, hi: number | null, n: number }}
 */
export function tInterval(values) {
  if (values.length === 0) return { mean: null, lo: null, hi: null, n: 0 };
  const { n, mean, sd } = meanSd(values);
  if (n < 2) return { mean, lo: null, hi: null, n };
  const half = (tQuantile(n - 1) * sd) / Math.sqrt(n);
  return { mean, lo: mean - half, hi: mean + half, n };
}

/**
 * The difference of the means (b minus a) with a Welch 95% interval. The degrees of freedom are rounded down (with a
 * tolerance, so 4.0 computed as 3.9999999999 stays 4); two groups with no spread at all use n1 + n2 - 2.
 * lo, hi and df are null when a group has fewer than 2 values.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {{ diff: number | null, lo: number | null, hi: number | null, df: number | null }}
 */
export function welch(a, b) {
  if (a.length === 0 || b.length === 0) return { diff: null, lo: null, hi: null, df: null };
  const x = meanSd(a);
  const y = meanSd(b);
  const diff = y.mean - x.mean;
  if (x.n < 2 || y.n < 2) return { diff, lo: null, hi: null, df: null };
  const v1 = (x.sd * x.sd) / x.n;
  const v2 = (y.sd * y.sd) / y.n;
  const se = Math.sqrt(v1 + v2);
  if (se === 0) return { diff, lo: diff, hi: diff, df: x.n + y.n - 2 };
  const raw = (v1 + v2) ** 2 / ((v1 * v1) / (x.n - 1) + (v2 * v2) / (y.n - 1));
  const df = Math.max(1, Math.floor(raw + 1e-9));
  const half = tQuantile(df) * se;
  return { diff, lo: diff - half, hi: diff + half, df };
}

// ---- reading the pieces of a run ----

/**
 * The pass count in the output of a holdout run: vitest's JSON reporter (numPassedTests / numTotalTests) or node's TAP
 * summary (`# pass N`, `# tests N`). Null when neither is there.
 * @param {string} text
 * @returns {{ passed: number, total: number } | null}
 */
export function parseHoldoutOutput(text) {
  const s = String(text ?? '');
  const candidates = [s.trim(), ...s.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))];
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      if (j && Number.isFinite(j.numPassedTests) && Number.isFinite(j.numTotalTests)) return { passed: j.numPassedTests, total: j.numTotalTests };
    } catch {
      // not JSON: try the next candidate
    }
  }
  const pass = /^# pass (\d+)\s*$/m.exec(s);
  const tests = /^# tests (\d+)\s*$/m.exec(s);
  if (pass && tests) return { passed: Number(pass[1]), total: Number(tests[1]) };
  return null;
}

/**
 * Mean and maximum of the load average samples ({ t, load1 } lines of $BENCH_STATE/load.jsonl); null for none.
 * @param {{ t?: number, load1: number }[] | null | undefined} samples
 */
export function summarizeLoad(samples) {
  const v = (samples ?? []).map((s) => s && s.load1).filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  return { samples: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v) };
}

/** The result object of a run output: the `result` field may be a JSON string or an object. */
function resultOf(output) {
  let r = output?.result;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      r = null;
    }
  }
  return r && typeof r === 'object' ? r : {};
}

const roleOf = (label) => {
  const i = label.indexOf(':');
  return i < 0 ? label.split(' ')[0] : label.slice(0, i);
};
/** A merge relay: the `merger:<id>` agents (and their reopen and locked retries), not the `... state` check nor `main:`. */
const isMergeRelay = (label) => /^merger:/.test(label) && !/ state$/.test(label);

/**
 * The record of one replayed wave.
 * @param {{ meta: { scenario: string, configKey: string, ciJobs?: number, loop?: object, holdoutTotal?: number },
 *           outputs: object[], load: { samples: number, mean: number, max: number } | null,
 *           holdout: { passed: number | null, total: number } | null }} input
 *   outputs: the workflow run outputs ({ result, workflowProgress }), in launch order; a later output (a relaunch of the
 *   parked tasks) overrides the state of the tasks it names, and its agents and escalations add to the earlier ones.
 */
export function buildRecord({ meta, outputs, load, holdout }) {
  const agents = [];
  const state = {};
  const reverted = new Set();
  let escalations = 0;
  let fixRounds = 0;
  for (const out of outputs) {
    for (const a of out?.workflowProgress ?? []) {
      if (a && typeof a.label === 'string' && Number.isFinite(a.startedAt)) agents.push(a);
    }
    const r = resultOf(out);
    for (const [id, s] of Object.entries(r.state ?? {})) state[id] = s;
    for (const [id, t] of Object.entries(r.tasks ?? {})) {
      if (!(id in state)) state[id] = t?.merge?.outcome ?? 'parked';
      if (t?.merge?.outcome === 'reverted') reverted.add(id);
      if (Array.isArray(t?.rounds)) fixRounds += Math.max(0, t.rounds.length - 1);
    }
    for (const [id, s] of Object.entries(r.state ?? {})) if (s === 'reverted') reverted.add(id);
    escalations += Array.isArray(r.escalations) ? r.escalations.length : 0;
  }
  const first = agents.length ? Math.min(...agents.map((a) => a.startedAt)) : null;
  const merges = agents.filter((a) => isMergeRelay(a.label));
  const last = merges.length ? Math.max(...merges.map((a) => a.startedAt + (a.durationMs || 0))) : null;
  const perRole = {};
  let total = 0;
  let ms = 0;
  for (const a of agents) {
    const tok = Number.isFinite(a.tokens) ? a.tokens : 0;
    perRole[roleOf(a.label)] = (perRole[roleOf(a.label)] ?? 0) + tok;
    total += tok;
    ms += Number.isFinite(a.durationMs) ? a.durationMs : 0;
  }
  const ids = Object.keys(state);
  return {
    scenario: meta.scenario,
    config: meta.configKey,
    loop: meta.loop ?? null,
    ciJobs: meta.ciJobs ?? null,
    makespanMs: first !== null && last !== null ? last - first : null,
    agentMinutes: ms / 60000,
    tokens: { total, perRole },
    tasks: { merged: ids.filter((id) => state[id] === 'merged').length, total: ids.length },
    fixRounds,
    escalations,
    reverts: reverted.size,
    holdout: holdout ?? null,
    load: load ?? null,
    agents: agents.length,
    outputs: outputs.length,
  };
}

// ---- compare ----

const METRICS = [
  { name: 'makespanMs', get: (r) => r.makespanMs },
  { name: 'agentMinutes', get: (r) => r.agentMinutes },
  { name: 'tokens', get: (r) => r.tokens?.total },
  { name: 'fixRounds', get: (r) => r.fixRounds },
  { name: 'escalations', get: (r) => r.escalations },
  { name: 'reverts', get: (r) => r.reverts },
  { name: 'loadMean', get: (r) => r.load?.mean },
  { name: 'tasksMerged', rate: (r) => (r.tasks && r.tasks.total > 0 ? { k: r.tasks.merged, n: r.tasks.total } : null) },
  { name: 'holdoutPass', rate: (r) => (r.holdout && Number.isFinite(r.holdout.passed) && r.holdout.total > 0 ? { k: r.holdout.passed, n: r.holdout.total } : null) },
];

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

/** One metric of one group of records: values for a time or count, pooled counts for a rate. */
function groupMetric(metric, records) {
  if (metric.rate) {
    const parts = records.map(metric.rate).filter(Boolean);
    if (parts.length === 0) return null;
    const k = parts.reduce((a, p) => a + p.k, 0);
    const n = parts.reduce((a, p) => a + p.n, 0);
    const w = wilson(k, n);
    return { ...w, text: `${Math.round(w.mean * 100)}% (${Math.round(w.lo * 100)}–${Math.round(w.hi * 100)}%, n=${n})`, values: parts.map((p) => p.k / p.n) };
  }
  const values = records.map(metric.get).filter(finite);
  if (values.length === 0) return null;
  const t = tInterval(values);
  return { ...t, text: t.lo === null ? `${fmt(t.mean)} (n=${t.n})` : `${fmt(t.mean)} (${fmt(t.lo)}–${fmt(t.hi)}, n=${t.n})`, values };
}

/**
 * Groups records by config and compares them: per metric the mean with a 95% interval, and for every pair of configs
 * (in order of first appearance) the difference b minus a with a Welch 95% interval, whether the two single-config
 * intervals overlap and whether the difference interval includes 0 (null where an interval does not exist).
 * @param {object[]} records
 */
export function compareRecords(records) {
  const order = [];
  const byConfig = new Map();
  for (const r of records) {
    if (!byConfig.has(r.config)) {
      byConfig.set(r.config, []);
      order.push(r.config);
    }
    byConfig.get(r.config).push(r);
  }
  const groups = order.map((config) => {
    const rs = byConfig.get(config);
    const metrics = {};
    for (const m of METRICS) {
      const g = groupMetric(m, rs);
      if (g) {
        const { values, ...shown } = g;
        metrics[m.name] = shown;
      } else metrics[m.name] = null;
    }
    return { config, scenario: rs[0].scenario ?? null, loop: rs[0].loop ?? null, n: rs.length, metrics };
  });
  const comparisons = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const A = byConfig.get(order[i]);
      const B = byConfig.get(order[j]);
      const metrics = {};
      for (const m of METRICS) {
        const ga = groupMetric(m, A);
        const gb = groupMetric(m, B);
        if (!ga || !gb) {
          metrics[m.name] = null;
          continue;
        }
        const d = welch(ga.values, gb.values);
        const overlap = ga.lo === null || gb.lo === null ? null : !(ga.hi < gb.lo || gb.hi < ga.lo);
        const includesZero = d.lo === null ? null : d.lo <= 0 && 0 <= d.hi;
        metrics[m.name] = { diff: d.diff, lo: d.lo, hi: d.hi, df: d.df, overlap, includesZero };
      }
      comparisons.push({ a: order[i], b: order[j], metrics });
    }
  }
  return { groups, comparisons };
}
