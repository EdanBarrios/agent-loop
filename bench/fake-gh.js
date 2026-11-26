#!/usr/bin/env node
// Fake GitHub for the benchmark (task 4.1): a `gh` replacement for a replayed wave, with no GitHub repository.
//
// It answers exactly the subcommands, flags and --json fields the loop's scripts, workflows and agent prompts use
// (grepped from loop 2.5.0): `pr create|view|list|edit|ready|diff|checks|merge|comment` and `run list|view|watch`.
// Anything else, a flag or a --json field included, exits 1 naming it, so a loop under test that needs more shows up
// as an error and this list grows.
//
// State: $BENCH_STATE (required; the fake refuses to run without it) holds one JSON file per PR in prs/, written under
// a temporary name and renamed, and the run records of bench/ci.js in runs/ (checks and runs come from there). The Git
// side is a bare remote: $BENCH_REMOTE, else the `remote` of $BENCH_STATE/ci.json, else the `origin` of the working
// directory. Head and base commits, files, commits, the diff and mergeability are read from it, never stored (a merged
// PR keeps the commits it had, because its branch may be deleted and its base has moved).
//
// `pr create` also creates refs/pull/<n>/head in the bare remote (scripts/test-edits.js fetches it), and the ref
// follows the branch whenever a command reads the PR. `pr merge` makes the merge inside the bare remote with git plumbing
// (merge-tree, commit-tree, update-ref: the result of `git merge --no-ff`, with no working tree), refuses with
// GitHub's message when the branch conflicts, and then calls enqueueRun of bench/ci.js for the new default-branch sha
// with event `push`, because a ref moved inside the bare remote runs no post-receive hook.
//
// Output is what gh prints off a terminal: plain text (tab separated) or compact JSON with sorted keys for --json,
// which -q/--jq filters with a small jq subset (.field, .a.b, [], [n], chained).
// Environment: BENCH_STATE, BENCH_REMOTE (optional), BENCH_POLL_MS (poll interval of --watch, default 1000).
// Reads or writes: writes-files (the state directory and the bare remote).
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueRun, listRuns, loadCiConfig, readRun } from './ci.js';

const REPO = 'bench.invalid/bench';
const USER = 'bench';
/** Sleeps without the event loop: every command is synchronous, so a test can call it in process. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** An error that ends the command with a message on stderr and an exit code. */
class Fail extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const iso = (d = new Date()) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const prUrl = (n) => `https://${REPO}/pull/${n}`;
const runUrl = (id) => `https://${REPO}/actions/runs/${id}`;

// ---- command table: flags and --json fields per subcommand ----

const JSON_OPTS = [['json', null, 'str'], ['jq', 'q', 'str']];
const PR_FIELDS = [
  'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'mergeStateStatus', 'mergeable',
  'mergeCommit', 'mergedAt', 'files', 'commits', 'comments',
];
const CHECK_FIELDS = ['name', 'state', 'bucket', 'link', 'workflow'];
const RUN_FIELDS = ['databaseId', 'status', 'conclusion', 'name'];
const COMMANDS = {
  'pr create': { pos: 0, opts: [['base', 'B', 'str'], ['head', 'H', 'str'], ['title', 't', 'str'], ['body', 'b', 'str'], ['body-file', 'F', 'str'], ['draft', 'd', 'bool']] },
  'pr view': { pos: 1, fields: PR_FIELDS, opts: [['comments', 'c', 'bool'], ...JSON_OPTS] },
  'pr list': { pos: 0, fields: PR_FIELDS, opts: [['state', 's', 'str'], ['limit', 'L', 'str'], ['base', 'B', 'str'], ['head', 'H', 'str'], ...JSON_OPTS] },
  'pr edit': { pos: 1, opts: [['title', 't', 'str'], ['body', 'b', 'str'], ['body-file', 'F', 'str'], ['base', 'B', 'str']] },
  'pr ready': { pos: 1, opts: [] },
  'pr diff': { pos: 1, opts: [] },
  'pr checks': { pos: 1, fields: CHECK_FIELDS, opts: [['watch', null, 'bool'], ['fail-fast', null, 'bool'], ...JSON_OPTS] },
  'pr merge': { pos: 1, opts: [['merge', 'm', 'bool'], ['squash', 's', 'bool'], ['rebase', 'r', 'bool'], ['delete-branch', 'd', 'bool'], ['match-head-commit', null, 'str']] },
  'pr comment': { pos: 1, opts: [['body', 'b', 'str'], ['body-file', 'F', 'str']] },
  'run list': { pos: 0, fields: RUN_FIELDS, opts: [['branch', 'b', 'str'], ['workflow', 'w', 'str'], ['commit', 'c', 'str'], ['limit', 'L', 'str'], ...JSON_OPTS] },
  'run view': { pos: 1, fields: RUN_FIELDS, opts: [['log-failed', null, 'bool'], ...JSON_OPTS] },
  'run watch': { pos: 1, opts: [['exit-status', null, 'bool']] },
};

/**
 * Splits argv into the command name, its flags and its positional arguments. An unknown subcommand, flag or --json
 * field is a Fail naming it.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const words = [];
  let i = 0;
  while (i < argv.length && words.length < 2 && !argv[i].startsWith('-')) words.push(argv[i++]);
  if (words.length === 0) throw new Fail(`bench gh: unsupported command ${JSON.stringify(argv.join(' '))}: give a subcommand such as "pr view"`);
  const name = words.join(' ');
  const spec = COMMANDS[name];
  if (!spec) throw new Fail(`bench gh: unsupported subcommand "${name}"`);
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  const pos = [];
  const byLong = new Map(spec.opts.map((o) => [o[0], o]));
  const byShort = new Map(spec.opts.filter((o) => o[1]).map((o) => [o[1], o]));
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-' || !a.startsWith('-')) {
      pos.push(a);
      continue;
    }
    let opt;
    let value;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const long = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      opt = byLong.get(long);
      if (eq >= 0) value = a.slice(eq + 1);
    } else {
      opt = byShort.get(a.slice(1));
    }
    if (!opt) throw new Fail(`bench gh: unsupported flag "${a.split('=')[0]}" for "${name}"`);
    if (opt[2] === 'bool') {
      flags[opt[0]] = true;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Fail(`bench gh: flag "${a}" needs a value`);
    }
    flags[opt[0]] = value;
  }
  if (pos.length > spec.pos) throw new Fail(`bench gh: unexpected argument ${JSON.stringify(pos[spec.pos])} for "${name}"`);
  if (flags.json !== undefined) {
    const asked = String(flags.json).split(',').filter(Boolean);
    if (asked.length === 0) throw new Fail(`bench gh: --json needs at least one field for "${name}"`);
    for (const f of asked) {
      if (!spec.fields.includes(f)) throw new Fail(`bench gh: unsupported --json field "${f}" for "${name}" (supported: ${spec.fields.join(', ')})`);
    }
    flags.json = asked;
  } else if (flags.jq !== undefined) {
    throw new Fail('bench gh: cannot use `--jq` without specifying `--json`');
  }
  return { name, flags, pos };
}

// ---- jq subset ----

/**
 * Evaluates .field, .a.b, [], [n] chains (what the loop passes to -q) and returns one output line per result.
 * @param {string} expr
 * @param {unknown} value
 * @returns {string[]}
 */
function jq(expr, value) {
  let rest = String(expr).trim();
  /** @type {Array<{ field?: string, index?: number|null }>} */
  const steps = [];
  if (!rest.startsWith('.')) throw new Fail(`bench gh: unsupported jq expression ${JSON.stringify(expr)}`);
  while (rest !== '') {
    let m;
    if ((m = /^\.(?=\[)/.exec(rest))) steps.push({});
    else if ((m = /^\.([A-Za-z_]\w*)/.exec(rest))) steps.push({ field: m[1] });
    else if ((m = /^\[(\d*)\]/.exec(rest))) steps.push({ index: m[1] === '' ? null : Number(m[1]) });
    else if (rest === '.') m = ['.'];
    else throw new Fail(`bench gh: unsupported jq expression ${JSON.stringify(expr)}`);
    rest = rest.slice(m[0].length);
  }
  let values = [value];
  for (const s of steps) {
    if (s.field !== undefined) {
      values = values.map((v) => (v !== null && typeof v === 'object' && !Array.isArray(v) && v[s.field] !== undefined ? v[s.field] : null));
    } else if (s.index === null) {
      values = values.flatMap((v) => {
        if (!Array.isArray(v)) throw new Fail(`bench gh: jq: cannot iterate over ${v === null ? 'null' : typeof v}`);
        return v;
      });
    } else if (s.index !== undefined) {
      values = values.map((v) => (Array.isArray(v) && v[s.index] !== undefined ? v[s.index] : null));
    }
  }
  return values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
}

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** Writes --json output, or the -q lines, for rows already reduced to the asked fields. */
function emitJson(ctx, flags, data) {
  const sorted = Array.isArray(data) ? data.map(sortKeys) : sortKeys(data);
  if (flags.jq !== undefined) {
    for (const line of jq(String(flags.jq), sorted)) ctx.out(`${line}\n`);
  } else {
    ctx.out(`${JSON.stringify(sorted)}\n`);
  }
}

// ---- git in the bare remote ----

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && k !== 'GIT_TERMINAL_PROMPT') delete env[k];
  return env;
}

/** Runs git; never throws. */
function runGit(args, { cwd, input, env } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', env: { ...gitEnv(), ...(env ?? {}) }, maxBuffer: 512 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const BOT = { GIT_COMMITTER_NAME: 'bench-github', GIT_COMMITTER_EMAIL: 'bench-github@bench.invalid', GIT_AUTHOR_NAME: 'bench-github', GIT_AUTHOR_EMAIL: 'bench-github@bench.invalid' };

class Context {
  constructor({ env, cwd, stdin, sleep: sleepFn, startRuns }) {
    this.env = env;
    this.cwd = cwd;
    this.stdinReader = stdin;
    this.sleep = sleepFn ?? sleep;
    this.startRuns = startRuns !== false;
    this.stdout = '';
    this.stderr = '';
    this.stateDir = '';
    this._remote = null;
  }

  out(s) {
    this.stdout += s;
  }

  err(s) {
    this.stderr += s;
  }

  stdin() {
    return this.stdinReader ? this.stdinReader() : '';
  }

  /** The bare remote's path. */
  get remote() {
    if (this._remote) return this._remote;
    let where = this.env.BENCH_REMOTE || '';
    if (!where) {
      try {
        where = loadCiConfig(this.stateDir).remote || '';
      } catch {
        // no ci.json: fall through to the working directory
      }
    }
    if (!where) {
      const r = runGit(['remote', 'get-url', 'origin'], { cwd: this.cwd });
      if (r.code === 0) where = r.out.trim();
    }
    if (!where || !existsSync(resolve(this.cwd, where))) {
      throw new Fail('bench gh: cannot find the bare remote: set BENCH_REMOTE, or run in a clone whose origin is a local bare repository');
    }
    this._remote = resolve(this.cwd, where);
    return this._remote;
  }

  /** git in the bare remote. */
  git(args, o) {
    return runGit(['--git-dir', this.remote, ...args], o);
  }

  gitOk(args, o) {
    const r = this.git(args, o);
    if (r.code !== 0) throw new Fail(`bench gh: git ${args[0]} failed: ${(r.err || r.out).trim()}`);
    return r.out.trim();
  }

  /** The commit a ref points to, or '' when there is none. */
  rev(ref) {
    const r = this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.code === 0 ? r.out.trim() : '';
  }

  defaultBranch() {
    const r = this.git(['symbolic-ref', '--short', 'HEAD']);
    return r.code === 0 && r.out.trim() ? r.out.trim() : 'main';
  }
}

// ---- PR store ----

const prsDir = (ctx) => join(ctx.stateDir, 'prs');

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

function prNumbers(ctx) {
  if (!existsSync(prsDir(ctx))) return [];
  return readdirSync(prsDir(ctx)).filter((n) => /^[1-9]\d*\.json$/.test(n)).map((n) => Number(n.slice(0, -5)));
}

function readPr(ctx, n) {
  try {
    return JSON.parse(readFileSync(join(prsDir(ctx), `${n}.json`), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

const savePr = (ctx, pr) => writeJsonAtomic(join(prsDir(ctx), `${pr.number}.json`), pr);

/** Takes the next free number without overwriting (link() fails with EEXIST when another process took it). */
function insertPr(ctx, pr) {
  mkdirSync(prsDir(ctx), { recursive: true });
  const tmp = join(prsDir(ctx), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  for (;;) {
    pr.number = Math.max(0, ...prNumbers(ctx)) + 1;
    writeFileSync(tmp, JSON.stringify(pr, null, 2) + '\n');
    try {
      linkSync(tmp, join(prsDir(ctx), `${pr.number}.json`));
      return pr;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

/**
 * Brings an open PR up to its branch: the head sha it shows, and refs/pull/<n>/head in the bare remote.
 */
function syncPr(ctx, pr) {
  if (pr.state === 'OPEN') {
    const tip = ctx.rev(`refs/heads/${pr.headRefName}`);
    if (tip && tip !== pr.headRefOid) {
      pr.headRefOid = tip;
      savePr(ctx, pr);
    }
  }
  if (pr.headRefOid && ctx.rev(`refs/pull/${pr.number}/head`) !== pr.headRefOid) {
    ctx.gitOk(['update-ref', `refs/pull/${pr.number}/head`, pr.headRefOid]);
  }
  return pr;
}

function loadPr(ctx, n) {
  const pr = readPr(ctx, n);
  if (!pr) throw new Fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`);
  return syncPr(ctx, pr);
}

/** The PR a command names: a number, #number, URL or head branch; no argument means the current branch. */
function findPr(ctx, arg) {
  let spec = arg;
  if (spec === undefined) {
    const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd });
    if (r.code !== 0 || !r.out.trim() || r.out.trim() === 'HEAD') {
      throw new Fail('bench gh: no pull request given and the working directory is not on a branch');
    }
    spec = r.out.trim();
  }
  let m;
  if ((m = /^#?(\d+)$/.exec(spec)) || (m = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(spec))) return loadPr(ctx, Number(m[1]));
  const all = prNumbers(ctx).map((n) => readPr(ctx, n)).filter((p) => p && p.headRefName === spec);
  all.sort((a, b) => (a.state === 'OPEN' ? 0 : 1) - (b.state === 'OPEN' ? 0 : 1) || b.number - a.number);
  if (all.length === 0) throw new Fail(`no pull requests found for branch "${spec}"`);
  return syncPr(ctx, all[0]);
}

// ---- derived PR facts, read from the bare remote ----

const baseTip = (ctx, pr) => (pr.state === 'MERGED' ? pr.baseRefOid : ctx.rev(`refs/heads/${pr.baseRefName}`));

/** `git merge-tree --write-tree`: the merged tree, or null when the two sides conflict. */
function mergeTree(ctx, a, b, mergeBase) {
  const args = ['merge-tree', '--write-tree', '--no-messages'];
  if (mergeBase) args.push(`--merge-base=${mergeBase}`);
  const r = ctx.git([...args, a, b]);
  if (r.code === 0) return r.out.split('\n')[0].trim();
  if (r.code === 1) return null;
  throw new Fail(`bench gh: git merge-tree failed: ${(r.err || r.out).trim()}`);
}

function mergeableOf(ctx, pr) {
  if (pr.state !== 'OPEN') return 'UNKNOWN';
  const base = baseTip(ctx, pr);
  if (!base || !pr.headRefOid) return 'UNKNOWN';
  return mergeTree(ctx, base, pr.headRefOid) === null ? 'CONFLICTING' : 'MERGEABLE';
}

function filesOf(ctx, pr) {
  const base = baseTip(ctx, pr);
  if (!base || !pr.headRefOid) return [];
  const out = ctx.gitOk(['diff', '--numstat', '--no-renames', '--no-ext-diff', '-z', `${base}...${pr.headRefOid}`]);
  const files = [];
  for (const rec of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec.replace(/^\n/, ''));
    if (m) files.push({ path: m[3], additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return files;
}

function commitsOf(ctx, pr) {
  const base = baseTip(ctx, pr);
  if (!base || !pr.headRefOid) return [];
  const raw = ctx.gitOk(['log', '--reverse', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%b%x1e', `${base}..${pr.headRefOid}`]);
  return raw.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim() !== '').map((r) => {
    const [oid, name, email, authored, committed, headline, body] = r.split('\x1f');
    return {
      oid, messageHeadline: headline, messageBody: (body ?? '').trim(), authoredDate: iso(authored), committedDate: iso(committed),
      authors: [{ email, id: '', login: '', name }],
    };
  });
}

/** The value of one --json field of a PR, computed when asked for. */
function prField(ctx, pr, field) {
  switch (field) {
    case 'number': return pr.number;
    case 'title': return pr.title;
    case 'state': return pr.state;
    case 'body': return pr.body;
    case 'headRefName': return pr.headRefName;
    case 'baseRefName': return pr.baseRefName;
    case 'headRefOid': return pr.headRefOid;
    case 'mergedAt': return pr.mergedAt ?? null;
    case 'mergeCommit': return pr.mergeCommit ?? null;
    case 'mergeable': return mergeableOf(ctx, pr);
    case 'mergeStateStatus': {
      if (pr.state !== 'OPEN') return 'UNKNOWN';
      if (mergeableOf(ctx, pr) === 'CONFLICTING') return 'DIRTY';
      return pr.isDraft ? 'DRAFT' : 'CLEAN';
    }
    case 'files': return filesOf(ctx, pr);
    case 'commits': return commitsOf(ctx, pr);
    case 'comments':
      return (pr.comments ?? []).map((c) => ({
        id: c.id, author: { login: c.author }, authorAssociation: 'NONE', body: c.body, createdAt: c.createdAt, url: `${prUrl(pr.number)}#issuecomment-${c.id}`,
      }));
    default: throw new Fail(`bench gh: unsupported --json field "${field}"`);
  }
}

const prRow = (ctx, pr, fields) => Object.fromEntries(fields.map((f) => [f, prField(ctx, pr, f)]));
const plainState = (pr) => (pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state);

// ---- bodies ----

function bodyFrom(ctx, flags) {
  if (flags.body !== undefined && flags['body-file'] !== undefined) throw new Fail('specify only one of `--body` or `--body-file`');
  if (flags['body-file'] !== undefined) {
    if (flags['body-file'] === '-') return ctx.stdin();
    try {
      return readFileSync(resolve(ctx.cwd, String(flags['body-file'])), 'utf8');
    } catch (e) {
      throw new Fail(`open ${flags['body-file']}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`);
    }
  }
  return flags.body === undefined ? undefined : String(flags.body);
}

// ---- pr subcommands ----

function prCreate(ctx, flags) {
  const body = bodyFrom(ctx, flags);
  if (flags.title === undefined || body === undefined) {
    throw new Fail('must provide `--title` and `--body` (or `--body-file`) when not running interactively');
  }
  let head = flags.head;
  if (head === undefined) {
    const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd });
    head = r.code === 0 ? r.out.trim() : '';
    if (!head || head === 'HEAD') throw new Fail('aborted: you must first push the current branch to a remote, or use the --head flag');
  }
  const base = flags.base ?? ctx.defaultBranch();
  if (head === base) throw new Fail(`head branch "${head}" is the same as base branch "${base}", cannot create a pull request`);
  const headTip = ctx.rev(`refs/heads/${head}`);
  if (!headTip) throw new Fail(`head branch "${head}" is not pushed to the remote: push it first, or use the --head flag`);
  const baseOid = ctx.rev(`refs/heads/${base}`);
  if (!baseOid) throw new Fail(`base branch "${base}" was not found on the remote`);
  const open = prNumbers(ctx).map((n) => readPr(ctx, n)).find((p) => p && p.state === 'OPEN' && p.headRefName === head && p.baseRefName === base);
  if (open) throw new Fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${prUrl(open.number)}`);
  if (ctx.gitOk(['rev-list', '--count', `${baseOid}..${headTip}`]) === '0') {
    throw new Fail(`pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)`);
  }
  const now = iso();
  const pr = insertPr(ctx, {
    number: 0, title: String(flags.title), body, state: 'OPEN', isDraft: flags.draft === true, headRefName: head, baseRefName: base,
    headRefOid: headTip, baseRefOid: null, mergeCommit: null, mergedAt: null, createdAt: now, comments: [],
  });
  syncPr(ctx, pr);
  ctx.out(`${prUrl(pr.number)}\n`);
}

function prView(ctx, flags, pos) {
  const pr = findPr(ctx, pos[0]);
  if (flags.json) return emitJson(ctx, flags, prRow(ctx, pr, flags.json));
  if (flags.comments) {
    for (const c of pr.comments ?? []) {
      ctx.out(`author:\t${c.author}\nassociation:\tnone\nedited:\tfalse\nstatus:\tnone\n--\n${c.body.endsWith('\n') ? c.body : `${c.body}\n`}--\n`);
    }
    return undefined;
  }
  const files = filesOf(ctx, pr);
  const body = pr.body ?? '';
  ctx.out(
    [
      `title:\t${pr.title}`, `state:\t${plainState(pr)}`, `author:\t${USER}`, 'labels:\t', 'assignees:\t', 'reviewers:\t', 'projects:\t',
      'milestone:\t', `number:\t${pr.number}`, `url:\t${prUrl(pr.number)}`, `additions:\t${files.reduce((s, f) => s + f.additions, 0)}`,
      `deletions:\t${files.reduce((s, f) => s + f.deletions, 0)}`, 'auto-merge:\tdisabled', '--', '',
    ].join('\n') + (body === '' || body.endsWith('\n') ? body : `${body}\n`),
  );
  return undefined;
}

function prList(ctx, flags) {
  const state = String(flags.state ?? 'open').toLowerCase();
  if (!['open', 'closed', 'merged', 'all'].includes(state)) throw new Fail(`invalid value for --state: ${JSON.stringify(flags.state)} (open, closed, merged or all)`);
  const limit = flags.limit === undefined ? 30 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Fail(`invalid limit: ${flags.limit}`);
  const rows = prNumbers(ctx).sort((a, b) => b - a).map((n) => readPr(ctx, n)).filter((p) => p)
    .filter((p) => state === 'all' || p.state.toLowerCase() === state)
    .filter((p) => flags.head === undefined || p.headRefName === flags.head)
    .filter((p) => flags.base === undefined || p.baseRefName === flags.base)
    .slice(0, limit)
    .map((p) => syncPr(ctx, p));
  if (flags.json) return emitJson(ctx, flags, rows.map((p) => prRow(ctx, p, flags.json)));
  if (rows.length === 0) {
    ctx.err(state === 'all' ? `no pull requests match your search in ${REPO}\n` : `no ${state} pull requests in ${REPO}\n`);
    return undefined;
  }
  for (const p of rows) ctx.out(`${p.number}\t${p.title}\t${p.headRefName}\t${plainState(p)}\t${p.createdAt}\n`);
  return undefined;
}

function prEdit(ctx, flags, pos) {
  const pr = findPr(ctx, pos[0]);
  const body = bodyFrom(ctx, flags);
  if (flags.base !== undefined && !ctx.rev(`refs/heads/${flags.base}`)) throw new Fail(`base branch "${flags.base}" was not found on the remote`);
  if (flags.title !== undefined) pr.title = String(flags.title);
  if (body !== undefined) pr.body = body;
  if (flags.base !== undefined) pr.baseRefName = String(flags.base);
  savePr(ctx, pr);
  ctx.out(`${prUrl(pr.number)}\n`);
}

function prReady(ctx, flags, pos) {
  const pr = findPr(ctx, pos[0]);
  if (pr.state !== 'OPEN') throw new Fail(`Pull request ${REPO}#${pr.number} is ${pr.state === 'MERGED' ? 'merged' : 'closed'}. Only draft pull requests can be marked as ready for review`);
  if (!pr.isDraft) {
    ctx.err(`Pull request ${REPO}#${pr.number} is already "ready for review"\n`);
    return;
  }
  pr.isDraft = false;
  savePr(ctx, pr);
  ctx.err(`Pull request ${REPO}#${pr.number} is marked as "ready for review"\n`);
}

function prDiff(ctx, flags, pos) {
  const pr = findPr(ctx, pos[0]);
  const base = baseTip(ctx, pr);
  if (!base || !pr.headRefOid) throw new Fail(`bench gh: the commits of pull request #${pr.number} are not in the remote`);
  ctx.out(ctx.gitOk(['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', `${base}...${pr.headRefOid}`]).replace(/^$/, '') + '\n');
}

function prComment(ctx, flags, pos) {
  const pr = findPr(ctx, pos[0]);
  const body = bodyFrom(ctx, flags);
  if (body === undefined) throw new Fail('flag `--body` or `--body-file` required when not running interactively');
  const fresh = readPr(ctx, pr.number);
  const id = Math.max(0, ...(fresh.comments ?? []).map((c) => c.id)) + 1;
  fresh.comments = [...(fresh.comments ?? []), { id, author: USER, body, createdAt: iso() }];
  savePr(ctx, fresh);
  ctx.out(`${prUrl(pr.number)}#issuecomment-${id}\n`);
}

// ---- checks and runs, from the records of bench/ci.js ----

/** gh's bucket and state for a run record. */
function runState(run) {
  if (run.status !== 'completed') return { bucket: 'pending', state: run.status === 'in_progress' ? 'IN_PROGRESS' : 'QUEUED' };
  switch (run.conclusion) {
    case 'success': return { bucket: 'pass', state: 'SUCCESS' };
    case 'cancelled': return { bucket: 'cancel', state: 'CANCELLED' };
    case 'skipped': return { bucket: 'skipping', state: 'SKIPPED' };
    default: return { bucket: 'fail', state: 'FAILURE' };
  }
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m${s % 60}s`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

/** One check per run name on the PR's head sha, the latest run winning (listRuns is newest first). */
function checksOf(ctx, pr) {
  const seen = new Set();
  const checks = [];
  for (const run of listRuns(ctx.stateDir)) {
    if (run.sha !== pr.headRefOid || seen.has(run.name)) continue;
    seen.add(run.name);
    const { bucket, state } = runState(run);
    checks.push({ name: run.name, state, bucket, link: `${runUrl(run.id)}/job/${run.id}`, workflow: run.workflow, durationMs: run.status === 'completed' ? run.durationMs : null });
  }
  return checks;
}

function prChecks(ctx, flags, pos) {
  let pr = findPr(ctx, pos[0]);
  let checks = checksOf(ctx, pr);
  if (checks.length === 0) throw new Fail(`no checks reported on the '${pr.headRefName}' branch`);
  if (flags.watch) {
    const pollMs = Number.parseInt(ctx.env.BENCH_POLL_MS ?? '', 10) || 1000;
    for (;;) {
      const failed = checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel');
      if (!checks.some((c) => c.bucket === 'pending') || (flags['fail-fast'] && failed)) break;
      ctx.sleep(pollMs);
      pr = findPr(ctx, String(pr.number));
      checks = checksOf(ctx, pr);
    }
  }
  if (flags.json) {
    emitJson(ctx, flags, checks.map((c) => Object.fromEntries(flags.json.map((f) => [f, c[f]]))));
  } else {
    for (const c of checks) ctx.out(`${c.name}\t${c.bucket}\t${c.durationMs === null ? '' : duration(c.durationMs)}\t${c.link}\n`);
  }
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 1;
  return checks.some((c) => c.bucket === 'pending') ? 8 : 0;
}

// ---- pr merge ----

function commitTree(ctx, tree, parents, message, env) {
  const args = ['commit-tree', tree];
  for (const p of parents) args.push('-p', p);
  const [subject, ...rest] = message.split('\n\n');
  args.push('-m', subject);
  if (rest.length > 0) args.push('-m', rest.join('\n\n'));
  return ctx.gitOk(args, { env: { ...BOT, ...(env ?? {}) } });
}

/** Replays the PR's commits one by one onto `onto` (a rebase merge); null when one of them conflicts. */
function rebaseOnto(ctx, onto, base, head) {
  const list = ctx.gitOk(['rev-list', '--reverse', '--topo-order', '--no-merges', `${base}..${head}`]).split('\n').filter(Boolean);
  let tip = onto;
  for (const c of list) {
    const parent = ctx.gitOk(['rev-parse', `${c}^`]);
    const tree = mergeTree(ctx, tip, c, parent);
    if (tree === null) return null;
    if (tree === ctx.gitOk(['rev-parse', `${tip}^{tree}`])) continue;
    const [name, email, date, message] = ctx.gitOk(['log', '-1', '--format=%an%x1f%ae%x1f%aI%x1f%B', c]).split('\x1f');
    tip = commitTree(ctx, tree, [tip], message.trim(), { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date });
  }
  return tip;
}

function prMerge(ctx, flags, pos) {
  const strategies = ['merge', 'squash', 'rebase'].filter((s) => flags[s]);
  if (strategies.length === 0) throw new Fail('--merge, --rebase, or --squash required when not running interactively');
  if (strategies.length > 1) throw new Fail('only one of --merge, --rebase, or --squash can be enabled');
  const strategy = strategies[0];
  const pr = findPr(ctx, pos[0]);
  const ref = `${REPO}#${pr.number}`;
  if (pr.state === 'MERGED') throw new Fail(`Pull request ${ref} was already merged`);
  if (pr.state !== 'OPEN') throw new Fail(`Pull request ${ref} is closed`);
  if (pr.isDraft) throw new Fail(`Pull request ${ref} is still a draft`);
  loadCiConfig(ctx.stateDir); // the push run is recorded after the merge, so a missing ci.json stops the merge before it
  if (flags['match-head-commit'] !== undefined && flags['match-head-commit'] !== pr.headRefOid) {
    throw new Fail('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)');
  }
  const notMergeable = () => new Fail(`Pull request ${ref} is not mergeable: the merge commit cannot be cleanly created.`);
  const branchRef = `refs/heads/${pr.baseRefName}`;
  let base = '';
  let merged = '';
  for (let attempt = 0; attempt < 4 && !merged; attempt++) {
    base = ctx.rev(branchRef);
    if (!base) throw new Fail(`base branch "${pr.baseRefName}" was not found on the remote`);
    const head = pr.headRefOid;
    let created;
    if (strategy === 'rebase') {
      created = rebaseOnto(ctx, base, base, head);
      if (created === null) throw notMergeable();
    } else {
      const tree = mergeTree(ctx, base, head);
      if (tree === null) throw notMergeable();
      if (strategy === 'merge') {
        created = commitTree(ctx, tree, [base, head], `Merge pull request #${pr.number} from bench/${pr.headRefName}\n\n${pr.title}`);
      } else {
        const lines = ctx.gitOk(['log', '--reverse', '--format=* %s', `${base}..${head}`]);
        created = commitTree(ctx, tree, [base], `${pr.title} (#${pr.number})${lines ? `\n\n${lines}` : ''}`);
      }
    }
    const moved = ctx.git(['update-ref', branchRef, created, base]);
    if (moved.code === 0) merged = created;
  }
  if (!merged) throw new Fail(`Pull request ${ref} was not merged: the base branch kept changing`);
  if (flags['delete-branch'] && pr.headRefName !== pr.baseRefName) ctx.git(['update-ref', '-d', `refs/heads/${pr.headRefName}`]);
  pr.state = 'MERGED';
  pr.mergedAt = iso();
  pr.mergeCommit = { oid: merged };
  pr.baseRefOid = base;
  savePr(ctx, pr);
  try {
    enqueueRun(ctx.stateDir, { sha: merged, branch: pr.baseRefName, event: 'push', remote: ctx.remote, start: ctx.startRuns });
  } catch (e) {
    throw new Fail(`Pull request ${ref} was merged, but the push run was not recorded: ${e.message}`);
  }
}

// ---- run subcommands ----

const runRow = (run, fields) => {
  const all = { databaseId: run.id, status: run.status, conclusion: run.conclusion ?? '', name: run.name };
  return Object.fromEntries(fields.map((f) => [f, all[f]]));
};

function requireRun(ctx, arg) {
  if (arg === undefined) throw new Fail('run or job ID required when not running interactively');
  if (!/^[1-9]\d*$/.test(arg)) throw new Fail(`bench gh: bad run id ${JSON.stringify(arg)}`);
  const run = readRun(ctx.stateDir, Number(arg));
  if (!run) throw new Fail(`HTTP 404: Not Found (https://api.github.com/repos/${REPO}/actions/runs/${arg})`);
  return run;
}

function runList(ctx, flags) {
  const limit = flags.limit === undefined ? 20 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Fail(`invalid limit: ${flags.limit}`);
  const wf = flags.workflow === undefined ? undefined : String(flags.workflow).replace(/\.ya?ml$/, '');
  const runs = listRuns(ctx.stateDir)
    .filter((r) => flags.branch === undefined || r.branch === flags.branch)
    .filter((r) => wf === undefined || r.workflow === wf || r.name === wf)
    .filter((r) => flags.commit === undefined || r.sha === flags.commit)
    .slice(0, limit);
  if (flags.json) return emitJson(ctx, flags, runs.map((r) => runRow(r, flags.json)));
  if (runs.length === 0) {
    ctx.err('No runs found\n');
    return;
  }
  for (const r of runs) {
    const title = ctx.git(['log', '-1', '--format=%s', r.sha]);
    ctx.out(`${r.status}\t${r.conclusion ?? ''}\t${title.code === 0 ? title.out.trim() : r.sha.slice(0, 7)}\t${r.workflow}\t${r.branch}\t${r.event}\t${r.id}\t${duration(r.durationMs)}\t${iso(r.startedAt)}\n`);
  }
}

const mark = (run) => ({ pass: '+', fail: 'X', pending: '*', cancel: '-', skipping: '-' })[runState(run).bucket];

function runSummary(run) {
  return [
    `${mark(run)} ${run.branch}  ${run.workflow} · ${run.id}`,
    `Triggered via ${run.event} at ${iso(run.startedAt)}`,
    '',
    'JOBS',
    `${mark(run)} ${run.name}${run.status === 'completed' ? ` in ${duration(run.durationMs)}` : ''} (ID ${run.id})`,
    '',
    'For more information about a job, try: gh run view --job=<job-id>',
    `View this run on GitHub: ${runUrl(run.id)}`,
    '',
  ].join('\n');
}

function runView(ctx, flags, pos) {
  const run = requireRun(ctx, pos[0]);
  if (flags.json) return emitJson(ctx, flags, runRow(run, flags.json));
  if (flags['log-failed']) {
    if (run.status !== 'completed') throw new Fail(`run ${run.id} is still in progress; logs will be available when it is complete`);
    if (run.conclusion !== 'success' && run.logTail) ctx.out(run.logTail.endsWith('\n') ? run.logTail : `${run.logTail}\n`);
    return undefined;
  }
  ctx.out(runSummary(run));
  return undefined;
}

function runWatch(ctx, flags, pos) {
  let run = requireRun(ctx, pos[0]);
  const pollMs = Number.parseInt(ctx.env.BENCH_POLL_MS ?? '', 10) || 1000;
  while (run.status !== 'completed') {
    ctx.sleep(pollMs);
    run = requireRun(ctx, pos[0]);
  }
  ctx.out(runSummary(run));
  return flags['exit-status'] && run.conclusion !== 'success' ? 1 : 0;
}

// ---- entry ----

/**
 * Runs one gh command.
 * `sleep` replaces the wait of --watch; `startRuns: false` records the push run of a merge without starting its runner (tests).
 * @param {string[]} argv the arguments after `gh`
 * @param {{ env?: Record<string, string|undefined>, cwd?: string, stdin?: () => string, sleep?: (ms: number) => void, startRuns?: boolean }} [opts]
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function runGh(argv, opts = {}) {
  const ctx = new Context({ env: opts.env ?? process.env, cwd: opts.cwd ?? process.cwd(), stdin: opts.stdin, sleep: opts.sleep, startRuns: opts.startRuns });
  let code = 0;
  try {
    const state = ctx.env.BENCH_STATE;
    if (!state) throw new Fail('bench gh: BENCH_STATE is not set; the fake gh refuses to run without a state directory');
    if (!existsSync(state) || !statSync(state).isDirectory()) throw new Fail(`bench gh: BENCH_STATE ${state} is not a directory`);
    ctx.stateDir = resolve(state);
    const { name, flags, pos } = parseArgs(argv);
    switch (name) {
      case 'pr create': prCreate(ctx, flags); break;
      case 'pr view': prView(ctx, flags, pos); break;
      case 'pr list': prList(ctx, flags); break;
      case 'pr edit': prEdit(ctx, flags, pos); break;
      case 'pr ready': prReady(ctx, flags, pos); break;
      case 'pr diff': prDiff(ctx, flags, pos); break;
      case 'pr checks': code = prChecks(ctx, flags, pos); break;
      case 'pr merge': prMerge(ctx, flags, pos); break;
      case 'pr comment': prComment(ctx, flags, pos); break;
      case 'run list': runList(ctx, flags); break;
      case 'run view': runView(ctx, flags, pos); break;
      case 'run watch': code = runWatch(ctx, flags, pos); break;
      default: throw new Fail(`bench gh: unsupported subcommand "${name}"`);
    }
  } catch (e) {
    code = e instanceof Fail ? e.code : 1;
    ctx.err(`${e instanceof Fail ? e.message : `bench gh: ${e && e.stack ? e.stack : e}`}\n`);
  }
  return { code, stdout: ctx.stdout, stderr: ctx.stderr };
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Real paths on both sides: a symlinked directory (macOS /tmp and /var) makes the logical argv[1] differ from import.meta.url.
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const r = runGh(process.argv.slice(2), { stdin: readStdin });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
