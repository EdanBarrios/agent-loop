// Test-impact map: which existing test files import the files a task owns, directly or through one module?
// Pure functions with injected I/O (read); scripts/impact.js wires `git ls-files` and the file system.
// Imports are found by regex, not by a parser, so a commented-out import still counts: the map errs toward listing
// one test too many, never one too few. It imports node:path, so it is for CLIs and tests, not for bundling into a
// workflow file (scripts/bundle-workflows.js copies only import-free libs).
// Reads or writes: reads (only the files it is given).
import { matchesGlob, posix } from 'node:path'
import { DEFAULT_TEST_GLOBS, isTestFile } from './testedits.js'

/**
 * @typedef {Object} AliasEntry
 * @property {string} prefix    the part of the pattern before its trailing "*" (the whole pattern when exact)
 * @property {boolean} star     true for a "prefix/*" pattern, false for an exact pattern
 * @property {string[]} targets repo-relative directory prefixes (star) or paths (exact), already joined with baseUrl
 */

/**
 * @typedef {Object} Aliases
 * @property {AliasEntry[]} entries  longest prefix first
 */

/**
 * @typedef {Object} ImpactTest
 * @property {string} path
 * @property {string|null} via    the one intermediate module, or null when the test imports an owned path directly
 * @property {string|null} owner  the task id whose Owns line lists the test file, or null
 */

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs']
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']

const IMPORT_PATTERNS = [
  // import ... from '<p>' (also import type, multi-line) and export ... from '<p>'
  /\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  // import '<p>'
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  // import('<p>')
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  // require('<p>')
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  // vi.mock('<p>') and friends
  /\b(?:vi|jest)\.(?:mock|doMock)\s*\(\s*['"]([^'"\n]+)['"]/g,
]

/**
 * Every module specifier a source text imports, in no particular order, without duplicates.
 * @param {string} source
 * @returns {string[]}
 */
export function parseImports(source) {
  const found = new Set()
  const text = String(source)
  for (const pattern of IMPORT_PATTERNS) {
    for (const m of text.matchAll(pattern)) found.add(m[1])
  }
  return [...found]
}

/** A repo-relative POSIX path: no "./" prefix, no trailing slash, "" for the repo root. */
function clean(path) {
  const p = posix.normalize(String(path).replace(/\\/g, '/'))
  return p === '.' || p === './' ? '' : p.replace(/^\.\//, '').replace(/\/+$/, '')
}

/** JSON with comments and trailing commas (a tsconfig) turned into plain JSON text. */
function stripJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      out += ' '
    } else out += c
  }
  let result = ''
  inString = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (inString) {
      result += c
      if (c === '\\') result += out[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      result += c
    } else if (c === ',' && /^\s*[}\]]/.test(out.slice(i + 1))) {
      // a trailing comma: drop it
    } else result += c
  }
  return result
}

/**
 * The path aliases of a tsconfig: `compilerOptions.paths` entries that are a "prefix/*" pattern mapped to a
 * directory, or an exact pattern mapped to a path, relative to `baseUrl` (itself relative to the tsconfig) or to the
 * tsconfig. Anything unreadable gives no aliases.
 * @param {string|null|undefined} text         the tsconfig.json text
 * @param {string} [tsconfigDir]               the repo-relative directory of the tsconfig ("" for the root)
 * @returns {Aliases}
 */
export function parseAliases(text, tsconfigDir = '') {
  /** @type {AliasEntry[]} */
  const entries = []
  let json = null
  try {
    json = text ? JSON.parse(stripJsonc(String(text))) : null
  } catch {
    json = null
  }
  const options = json && typeof json === 'object' ? json.compilerOptions : null
  const paths = options && typeof options === 'object' ? options.paths : null
  if (!paths || typeof paths !== 'object') return { entries }
  const baseDir = clean(posix.join(tsconfigDir || '.', typeof options.baseUrl === 'string' ? options.baseUrl : '.'))
  for (const [pattern, mapped] of Object.entries(paths)) {
    if (!Array.isArray(mapped)) continue
    const star = pattern.endsWith('*') && pattern.indexOf('*') === pattern.length - 1
    if (!star && pattern.includes('*')) continue
    const targets = []
    for (const target of mapped) {
      if (typeof target !== 'string') continue
      if (star) {
        if (target.endsWith('*') && target.indexOf('*') === target.length - 1) targets.push(posix.join(baseDir || '.', target.slice(0, -1) || '.') + '/')
      } else if (!target.includes('*')) targets.push(clean(posix.join(baseDir || '.', target)))
    }
    if (targets.length > 0) entries.push({ prefix: star ? pattern.slice(0, -1) : pattern, star, targets })
  }
  entries.sort((a, b) => b.prefix.length - a.prefix.length)
  return { entries }
}

/** The file a repo-relative base path names: itself, a .ts-family twin of a .js specifier, base + extension, or base/index. */
function resolveBase(base, files) {
  const candidates = [base]
  const js = /\.(?:js|mjs|cjs)$/.exec(base)
  if (js) for (const ext of TS_EXTENSIONS) candidates.push(base.slice(0, -js[0].length) + ext)
  for (const ext of EXTENSIONS) candidates.push(base + ext)
  for (const ext of EXTENSIONS) candidates.push(`${base}/index${ext}`)
  return candidates.find((c) => files.has(c)) ?? null
}

/**
 * The tracked file a specifier of `from` names, or null. Relative specifiers resolve against the importing file; a
 * specifier that starts with a tsconfig alias resolves like a relative path; other (bare) specifiers are ignored.
 * @param {string} specifier
 * @param {string} from       repo-relative path of the importing file
 * @param {Set<string>} files repo-relative paths of every tracked file
 * @param {Aliases} aliases
 * @returns {string|null}
 */
export function resolveSpecifier(specifier, from, files, aliases) {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
    return resolveBase(clean(posix.join(posix.dirname(from), specifier)), files)
  }
  for (const entry of aliases.entries) {
    if (entry.star ? !specifier.startsWith(entry.prefix) : specifier !== entry.prefix) continue
    const rest = entry.star ? specifier.slice(entry.prefix.length) : ''
    for (const target of entry.targets) {
      const found = resolveBase(clean(entry.star ? target + rest : target), files)
      if (found !== null) return found
    }
  }
  return null
}

/**
 * The Owns paths per task id of a spec: the backticked paths of each `- **<id> Title.**` bullet's Owns clause (from
 * "Owns" to the first sentence end outside backticks).
 * @param {string} specText
 * @returns {Array<{id: string, patterns: string[]}>}
 */
export function parseOwners(specText) {
  /** @type {Array<{id: string, text: string}>} */
  const tasks = []
  for (const line of String(specText).split('\n')) {
    const head = /^\s*-\s+\*\*(\d+[a-z]?\.[0-9A-Za-z]+)\s/.exec(line)
    if (head) tasks.push({ id: head[1], text: line })
    else if (/^#/.test(line)) tasks.push({ id: '', text: '' })
    else if (tasks.length > 0) tasks[tasks.length - 1].text += ` ${line.trim()}`
  }
  const owners = []
  for (const task of tasks) {
    if (task.id === '') continue
    const at = task.text.search(/\bOwns\b/)
    let clause = ''
    if (at !== -1) {
      const rest = task.text.slice(at)
      let inTicks = false
      let end = rest.length
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '`') inTicks = !inTicks
        else if (!inTicks && rest[i] === '.' && (i + 1 === rest.length || /\s/.test(rest[i + 1]))) {
          end = i
          break
        }
      }
      clause = rest.slice(0, end)
    }
    const patterns = [...clause.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((p) => /[/.]/.test(p)).map(clean)
    owners.push({ id: task.id, patterns })
  }
  return owners
}

/** Whether an Owns pattern (exact path, directory prefix or glob) lists a repo-relative path. */
function patternMatches(pattern, path) {
  if (pattern === path || path.startsWith(`${pattern}/`)) return true
  if (!/[*?[{]/.test(pattern)) return false
  try {
    return matchesGlob(path, pattern)
  } catch {
    return false
  }
}

/**
 * Every test file that imports an owned path directly, or through one intermediate non-test module.
 * @param {Object} input
 * @param {string[]} input.files               every tracked file (repo-relative POSIX paths)
 * @param {string[]} input.owns                owned paths; a directory matches every file under it
 * @param {string[]} [input.globs]             test globs (default: the project default)
 * @param {string|null} [input.tsconfig]       text of <repo>/tsconfig.json, if any
 * @param {string|null} [input.spec]           text of the spec, for `owner`
 * @param {{read: (path: string) => Promise<string|null|undefined>|string|null|undefined}} io  file reader; a file it cannot read counts as empty
 * @returns {Promise<{tests: ImpactTest[]}>}
 */
export async function impactMap(input, io) {
  const files = new Set(input.files.map(clean))
  const globs = input.globs ?? DEFAULT_TEST_GLOBS
  const aliases = parseAliases(input.tsconfig, '')
  const owners = input.spec ? parseOwners(input.spec) : []
  const owned = input.owns.map(clean).filter((p) => p !== '')
  const isOwned = (path) => owned.some((o) => path === o || path.startsWith(`${o}/`))

  /** @type {Map<string, string[]>} */
  const cache = new Map()
  async function importsOf(path) {
    const hit = cache.get(path)
    if (hit) return hit
    let source = ''
    try {
      source = (await io.read(path)) ?? ''
    } catch {
      source = ''
    }
    const targets = new Set()
    for (const spec of parseImports(source)) {
      const target = resolveSpecifier(spec, path, files, aliases)
      if (target !== null && target !== path) targets.add(target)
    }
    const list = [...targets].sort()
    cache.set(path, list)
    return list
  }

  /** @type {ImpactTest[]} */
  const tests = []
  for (const path of [...files].sort()) {
    if (!SOURCE_FILE.test(path) || !isTestFile(path, globs)) continue
    const targets = await importsOf(path)
    let via = null
    let hit = targets.some(isOwned)
    if (!hit) {
      for (const mid of targets) {
        if (!SOURCE_FILE.test(mid) || isTestFile(mid, globs)) continue
        if ((await importsOf(mid)).some(isOwned)) {
          via = mid
          hit = true
          break
        }
      }
    }
    if (!hit) continue
    const owner = owners.find((o) => o.patterns.some((p) => patternMatches(p, path)))
    tests.push({ path, via, owner: owner ? owner.id : null })
  }
  return { tests }
}
