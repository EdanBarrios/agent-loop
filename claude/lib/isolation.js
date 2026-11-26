// Isolation check: say, from the settings files, whether Claude Code's Bash sandbox is on and whether the credential
// reads are denied. The loop never changes a permission or sandbox setting (v2.4 invariant 6); it only reads the
// settings and warns. The four files are read in the order managed, project local, project, user (the order the first
// file that sets a key is taken in). A missing file is not a warning; an unparseable one is, by path only: a parser
// message can quote the file, so none is ever returned.
// `sandbox.enabled` is the settings key from code.claude.com/docs/en/sandboxing.
// Reads or writes: reads (the caller's reader; this module touches no file itself).
import { MANAGED_SETTINGS_PATHS } from './permission.js'

/** The `permissions.deny` rules that keep an agent from reading credentials, in the order they are reported. */
export const DENY_READS = ['Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.config/gh/**)', 'Read(~/.netrc)', 'Read(**/.env*)']

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * One settings document to an object, or the fixed reason it cannot be used.
 * @param {unknown} json  the file's text, its parsed object, or null when the file is missing
 * @returns {{ settings: object|null, error: 'missing'|'unparseable'|null }}
 */
function readDoc(json) {
  if (json === null || json === undefined) return { settings: null, error: 'missing' }
  let value = json
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json)
    } catch {
      return { settings: null, error: 'unparseable' }
    }
  }
  return isObject(value) ? { settings: value, error: null } : { settings: null, error: 'unparseable' }
}

/**
 * The four settings paths in precedence order: managed (every place Claude Code reads it), project local, project, user.
 * @param {string} home  the user's home directory
 * @param {string} repo  the project's repository
 * @returns {string[]}
 */
export function settingsPaths(home, repo) {
  return [
    ...MANAGED_SETTINGS_PATHS,
    `${repo}/.claude/settings.local.json`,
    `${repo}/.claude/settings.json`,
    `${home}/.claude/settings.json`,
  ]
}

/**
 * Read each path through the caller's reader; a path that cannot be read gives `json: null`.
 * @param {string[]} paths
 * @param {(path: string) => string} readText  throws when the file cannot be read
 * @returns {Array<{ path: string, json: string|null }>}
 */
export function readSettingsDocs(paths, readText) {
  return paths.map((path) => {
    try {
      return { path, json: readText(path) }
    } catch {
      return { path, json: null }
    }
  })
}

/**
 * @param {Array<{ path: string, json: unknown }>} docs  in precedence order: managed, project local, project, user
 * @returns {{ sandbox: { enabled: boolean, source: string|null }, denyReads: { present: string[], missing: string[] }, warnings: string[] }}
 */
export function checkIsolation(docs) {
  const sandbox = { enabled: false, source: null }
  const denied = new Set()
  const unparseable = []
  for (const { path, json } of docs) {
    const { settings, error } = readDoc(json)
    if (error === 'unparseable') unparseable.push(path)
    if (settings === null) continue
    if (sandbox.source === null && isObject(settings.sandbox) && typeof settings.sandbox.enabled === 'boolean') {
      sandbox.enabled = settings.sandbox.enabled
      sandbox.source = path
    }
    const permissions = isObject(settings.permissions) ? settings.permissions : {}
    if (Array.isArray(permissions.deny)) {
      for (const rule of permissions.deny) if (typeof rule === 'string') denied.add(rule.trim())
    }
  }
  const present = DENY_READS.filter((rule) => denied.has(rule))
  const missing = DENY_READS.filter((rule) => !denied.has(rule))
  const warnings = [
    ...(sandbox.enabled ? [] : ['sandbox is not enabled']),
    ...missing.map((rule) => `deny rule missing: ${rule}`),
    ...unparseable.map((path) => `settings file unparseable: ${path}`),
  ]
  return { sandbox, denyReads: { present, missing }, warnings }
}
