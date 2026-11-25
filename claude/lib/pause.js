// Usage-limit classification (v2.4 task 1.3). Pure: the clock is passed in, because the workflow has no clock.
// Bundled into workflow files, so this file has no import and no top-level name that wave-loop.js declares.
// Reads or writes: reads.

const USAGE_LIMIT_PATTERN = /usage limit|limit reached|rate.?limit|quota|\b429\b|weekly limit/i;
const FAR_OUT_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CLOCK = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\s*\\(([^()]+)\\)';
const RESET_DATE = new RegExp(`resets\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+(\\d{1,2}),?(?:\\s+at)?\\s+${CLOCK}`, 'i');
const RESET_TIME = new RegExp(`resets(?:\\s+at)?\\s+${CLOCK}`, 'i');
const RESET_RELATIVE = /resets\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?\b)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?\b)?/i;

/**
 * Offset of an IANA zone from UTC at an instant, in ms. Throws RangeError for a zone the runtime rejects.
 * @param {string} zone
 * @param {number} ms
 * @returns {number}
 */
function zoneOffsetMs(zone, ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  /** @type {Record<string, number>} */
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Epoch ms of a wall-clock time in a zone, or null when the zone is rejected or the date does not exist.
 * @param {string} zone
 * @param {number} year
 * @param {number} month 0-based
 * @param {number} day
 * @param {number} hour 0-23
 * @param {number} minute
 * @returns {number | null}
 */
function zonedTime(zone, year, month, day, hour, minute) {
  const asUtc = new Date(Date.UTC(year, month, day, hour, minute));
  if (asUtc.getUTCMonth() !== month || asUtc.getUTCDate() !== day) return null;
  try {
    const guess = asUtc.getTime();
    const first = guess - zoneOffsetMs(zone, guess);
    return guess - zoneOffsetMs(zone, first);
  } catch {
    return null;
  }
}

/**
 * Year, month (0-based) and day of an instant on the wall clock of a zone.
 * @param {string} zone
 * @param {number} ms
 * @returns {{ year: number, month: number, day: number } | null}
 */
function zonedDate(zone, ms) {
  try {
    const d = new Date(ms + zoneOffsetMs(zone, ms));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
  } catch {
    return null;
  }
}

/**
 * 12-hour clock to 0-23, or null when out of range.
 * @param {string} h
 * @param {string | undefined} m
 * @param {string} ampm
 * @returns {{ hour: number, minute: number } | null}
 */
function to24(h, m, ampm) {
  const hour12 = Number(h);
  const minute = m === undefined ? 0 : Number(m);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  return { hour: (hour12 % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0), minute };
}

/**
 * Reset time named in a failure text, as epoch ms, or null.
 * @param {string} text
 * @param {number | null} nowMs
 * @returns {number | null}
 */
function parseResetsAt(text, nowMs) {
  if (nowMs === null || !Number.isFinite(nowMs)) return null;
  const dated = RESET_DATE.exec(text);
  if (dated) {
    const clock = to24(dated[3], dated[4], dated[5]);
    if (!clock) return null;
    const month = MONTH_NAMES.indexOf(dated[1].toLowerCase());
    const day = Number(dated[2]);
    const zone = dated[6].trim();
    const thisYear = new Date(nowMs).getUTCFullYear();
    let best = null;
    for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
      const at = zonedTime(zone, year, month, day, clock.hour, clock.minute);
      if (at !== null && at >= nowMs && (best === null || at < best)) best = at;
    }
    return best;
  }
  const timed = RESET_TIME.exec(text);
  if (timed) {
    const clock = to24(timed[1], timed[2], timed[3]);
    if (!clock) return null;
    const zone = timed[4].trim();
    const today = zonedDate(zone, nowMs);
    if (!today) return null;
    const first = zonedTime(zone, today.year, today.month, today.day, clock.hour, clock.minute);
    if (first === null) return null;
    if (first >= nowMs) return first;
    const tomorrow = zonedDate(zone, nowMs + DAY_MS);
    return tomorrow ? zonedTime(zone, tomorrow.year, tomorrow.month, tomorrow.day, clock.hour, clock.minute) : null;
  }
  const relative = RESET_RELATIVE.exec(text);
  if (relative && (relative[1] !== undefined || relative[2] !== undefined)) {
    return nowMs + (Number(relative[1] || 0) * 60 + Number(relative[2] || 0)) * 60 * 1000;
  }
  return null;
}

/**
 * Classify a failure as a usage limit or something else, and read when the limit resets.
 * `nowMs` may be null (the workflow has no clock): then `resetsAt` is null and `farOut` comes only from the text
 * `too far out`. A non-limit failure gives `resetsAt` null and `farOut` false.
 * @param {unknown} errorOrText an Error, or text
 * @param {number | null} nowMs
 * @returns {{ kind: 'usage_limit' | 'other', resetsAt: number | null, farOut: boolean }}
 */
export function classifyFailure(errorOrText, nowMs) {
  const e = /** @type {any} */ (errorOrText);
  const text = e === null || e === undefined ? '' : typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e);
  if (!USAGE_LIMIT_PATTERN.test(text)) return { kind: 'other', resetsAt: null, farOut: false };
  const resetsAt = parseResetsAt(text, nowMs === undefined ? null : nowMs);
  const far = /too far out/i.test(text) || (resetsAt !== null && nowMs !== null && resetsAt - nowMs > FAR_OUT_MS);
  return { kind: 'usage_limit', resetsAt, farOut: far };
}

/**
 * Which tasks a usage-limit pause stops. Tasks not started and tasks whose agent failed on the limit are paused; tasks
 * parked for any other reason stay parked; merged, reverted and still-running tasks are in neither (a running task's
 * result is recorded when it finishes). Order follows `tasks`.
 * @param {{ tasks: string[], state: Record<string, 'merged' | 'reverted' | 'parked' | 'running'>, failedOnLimit: string[] }} input
 *   `tasks` are the ids including the tail; a missing id in `state` means not started
 * @returns {{ paused: string[], parked: string[] }}
 */
export function pausePlan({ tasks, state, failedOnLimit }) {
  const failed = new Set(failedOnLimit || []);
  /** @type {string[]} */
  const paused = [];
  /** @type {string[]} */
  const parked = [];
  for (const id of tasks) {
    const s = state && Object.prototype.hasOwnProperty.call(state, id) ? state[id] : undefined;
    if (s === undefined) paused.push(id);
    else if (s === 'parked') (failed.has(id) ? paused : parked).push(id);
  }
  return { paused, parked };
}
