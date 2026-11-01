// Workflow bundler. The Workflow runtime accepts only self-contained scripts (no import(), no static import),
// so logic lives in claude/lib/<lib>.js (tested as ESM) and is copied into each workflow file between
//
//   // @bundle-start <lib>
//   // @bundle-end <lib>
//
// marker lines, with the lib's `export` keywords removed. The regions are generated: never edit them by hand.
//
//   node scripts/bundle-workflows.js            rewrite every stale region under claude/workflows/
//   node scripts/bundle-workflows.js --check    write nothing; exit 1 and name the file and lib when a region is stale,
//                                               a marker pair is unbalanced, a lib is missing, or a lib cannot be bundled
//   --root <dir>                                project root (default: the repo this script lives in); for tests
//
// A bundled lib may contain no `import` and no `require`, with one exception: a relative
// `import { x } from './other.js'` is dropped when `other` is bundled EARLIER in the same workflow file
// (so list the dependency's region first). Default exports, re-exports and export lists are errors.
// Exit codes: 0 ok, 1 problems, 2 bad usage. Reads or writes: writes-files (claude/workflows/*.js only).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKFLOWS_DIR = join('claude', 'workflows');
const LIB_DIR = join('claude', 'lib');
const MARKER = /^[ \t]*\/\/ @bundle-(start|end)\b(.*)$/;
const LIB_NAME = /^[A-Za-z0-9_-]+$/;
const EARLIER_IMPORT = /^import\s+[\w*{}\s,]+?\s+from\s+['"]\.\/([\w-]+)\.js['"];?[ \t]*\n?/gm;
const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|var\s+|class\s+)([A-Za-z_$][\w$]*)/;

/** @param {string} line */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Turn a lib's source into the text that goes between the markers.
 * @param {string} src the lib source
 * @param {Set<string>} earlier libs bundled earlier in the same workflow file
 * @returns {{ code: string, problems: string[] }}
 */
export function bundleSource(src, earlier) {
  /** @type {string[]} */
  const problems = [];
  let text = src.replace(/\r\n/g, '\n').replace(EARLIER_IMPORT, (whole, name) => (earlier.has(name) ? '' : whole));
  const lines = text.split('\n');
  const out = lines.map((line, i) => {
    if (isCommentLine(line)) return line;
    const at = `line ${i + 1}`;
    if (/^[ \t]*import\b/.test(line)) {
      const from = /from\s+['"]\.\/([\w-]+)\.js['"]/.exec(line);
      problems.push(from ? `contains import of ./${from[1]}.js, which is not bundled earlier in this file (${at})` : `contains import (${at}); a bundled lib must be self-contained`);
    } else if (/\bimport\s*\(/.test(line) || /\bimport\.meta\b/.test(line)) {
      problems.push(`contains import (${at}); the runtime rejects import()`);
    }
    if (/\brequire\s*\(/.test(line)) problems.push(`contains require (${at}); a bundled lib must be self-contained`);
    const ex = /^([ \t]*)export\b\s*(.*)$/.exec(line);
    if (!ex) return line;
    const rest = ex[2];
    if (/^default\b/.test(rest)) {
      problems.push(`contains export default (${at}); use a named export`);
      return line;
    }
    if (rest.startsWith('{') || rest.startsWith('*')) {
      problems.push(`contains a re-export or export list: export ${rest.slice(0, 12)} (${at}); export declarations directly`);
      return line;
    }
    if (!/^(?:async\s+function|function|const|let|var|class)\b/.test(rest)) {
      problems.push(`contains an unsupported export (${at}): export ${rest.slice(0, 20)}`);
      return line;
    }
    return ex[1] + rest;
  });
  return { code: out.join('\n').replace(/\n+$/, ''), problems };
}

/** @param {string} code @returns {string[]} */
function declaredNames(code) {
  const names = [];
  for (const line of code.split('\n')) {
    const m = DECLARATION.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Parse a workflow file into plain segments and marker regions.
 * @param {string} text
 * @returns {{ items: ({ kind: 'text', lines: string[] } | { kind: 'region', lib: string, start: string, end: string, body: string[] })[], problems: string[] }}
 */
function parseRegions(text) {
  const lines = text.split('\n');
  /** @type {any[]} */
  const items = [];
  /** @type {string[]} */
  const problems = [];
  let plain = [];
  /** @type {null | { lib: string, start: string, body: string[], at: number }} */
  let open = null;
  const name = (rest) => rest.trim().split(/\s+/)[0] || '(no name)';
  lines.forEach((line, i) => {
    const m = MARKER.exec(line);
    if (!m) {
      (open ? open.body : plain).push(line);
      return;
    }
    const lib = name(m[2]);
    if (m[1] === 'start') {
      if (open) {
        problems.push(`lib ${lib}: unbalanced marker: @bundle-start ${lib} on line ${i + 1} inside the unclosed region of ${open.lib} (line ${open.at})`);
        open.body.push(line);
        return;
      }
      items.push({ kind: 'text', lines: plain });
      plain = [];
      open = { lib, start: line, body: [], at: i + 1 };
    } else if (!open) {
      problems.push(`lib ${lib}: unbalanced marker: @bundle-end ${lib} on line ${i + 1} has no @bundle-start`);
      plain.push(line);
    } else if (open.lib !== lib) {
      problems.push(`lib ${open.lib}: unbalanced marker: @bundle-start ${open.lib} (line ${open.at}) is closed by @bundle-end ${lib} (line ${i + 1})`);
      open.body.push(line);
    } else {
      items.push({ kind: 'region', lib, start: open.start, end: line, body: open.body });
      open = null;
    }
  });
  if (open) problems.push(`lib ${open.lib}: unbalanced marker: @bundle-start ${open.lib} on line ${open.at} has no @bundle-end`);
  items.push({ kind: 'text', lines: plain });
  return { items, problems };
}

/**
 * Bundle one workflow file's text.
 * @param {string} rel file path for messages
 * @param {string} text file text
 * @param {(lib: string) => string | null} readLib returns the lib source or null when missing
 * @returns {{ text: string, stale: string[], problems: string[] }} stale: libs whose region differs from its lib
 */
export function bundleFile(rel, text, readLib) {
  const parsed = parseRegions(text.replace(/\r\n/g, '\n'));
  const problems = parsed.problems.map((p) => `${rel}: ${p}`);
  if (problems.length) return { text, stale: [], problems };
  /** @type {string[]} */
  const stale = [];
  const earlier = new Set();
  /** @type {Map<string, string>} */
  const declared = new Map();
  /** @param {string} owner @param {string} code */
  const claim = (owner, code) => {
    for (const n of declaredNames(code)) {
      if (declared.has(n)) problems.push(`${rel}: lib ${owner}: top-level name ${n} is already declared by ${declared.get(n)}; rename it in the lib`);
      else declared.set(n, owner);
    }
  };
  const lines = [];
  for (const item of parsed.items) {
    if (item.kind === 'text') {
      claim('the workflow file', item.lines.join('\n'));
      lines.push(...item.lines);
      continue;
    }
    const { lib } = item;
    if (earlier.has(lib)) {
      problems.push(`${rel}: lib ${lib}: bundled twice in one file`);
      continue;
    }
    const src = LIB_NAME.test(lib) ? readLib(lib) : null;
    if (src === null) {
      problems.push(`${rel}: lib ${lib}: missing lib, no ${join(LIB_DIR, lib)}.js${LIB_NAME.test(lib) ? '' : ' (invalid lib name)'}`);
      continue;
    }
    const built = bundleSource(src, earlier);
    earlier.add(lib);
    for (const p of built.problems) problems.push(`${rel}: lib ${lib}: ${p}`);
    if (built.problems.length) continue;
    claim(lib, built.code);
    const body = [`// generated from ${LIB_DIR.split('\\').join('/')}/${lib}.js by scripts/bundle-workflows.js: do not edit`, ...built.code.split('\n')];
    if (body.join('\n') !== item.body.join('\n')) stale.push(lib);
    lines.push(item.start, ...body, item.end);
  }
  return { text: lines.join('\n'), stale, problems };
}

/** @param {string} dir @returns {string[]} */
function listJs(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...listJs(p));
    else if (/\.(?:js|mjs|cjs)$/.test(e.name)) found.push(p);
  }
  return found;
}

/**
 * @param {string[]} argv process.argv-shaped: [node, script, ...flags]
 * @param {{ out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s));
  const err = io.err || ((s) => process.stderr.write(s));
  let check = false;
  let root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--root' && args[i + 1]) root = args[++i];
    else {
      err('usage: node scripts/bundle-workflows.js [--check] [--root <dir>]\n');
      return 2;
    }
  }
  /** @type {Map<string, string | null>} */
  const libs = new Map();
  const readLib = (lib) => {
    if (!libs.has(lib)) {
      const p = join(root, LIB_DIR, `${lib}.js`);
      libs.set(lib, existsSync(p) ? readFileSync(p, 'utf8') : null);
    }
    return libs.get(lib) ?? null;
  };
  const problems = [];
  const writes = [];
  let regions = 0;
  for (const file of listJs(join(root, WORKFLOWS_DIR))) {
    const rel = relative(root, file).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    if (!text.includes('@bundle-')) continue;
    const r = bundleFile(rel, text, readLib);
    regions += (text.match(/^[ \t]*\/\/ @bundle-start\b/gm) || []).length;
    problems.push(...r.problems);
    if (check) for (const lib of r.stale) problems.push(`${rel}: lib ${lib}: stale region, differs from ${join(LIB_DIR, lib)}.js; run node scripts/bundle-workflows.js`);
    else if (!r.problems.length && r.text !== text.replace(/\r\n/g, '\n')) writes.push({ file, rel, text: r.text });
  }
  if (problems.length) {
    for (const p of problems) err(`bundle-workflows: ${p}\n`);
    err(`bundle-workflows: FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'})${check ? '' : ', nothing written'}\n`);
    return 1;
  }
  for (const w of writes) {
    writeFileSync(w.file, w.text);
    out(`bundled ${w.rel}\n`);
  }
  out(`bundle-workflows: OK (${regions} region${regions === 1 ? '' : 's'}${check ? ', checked' : `, ${writes.length} file${writes.length === 1 ? '' : 's'} written`})\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
