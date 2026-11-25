// Permission check: predict, from the settings files, whether Claude Code will run a command unattended.
// Pure: the caller reads the files and passes them in. The loop never changes a permission setting and never routes
// around a refused command; it only reads the settings to say so before a wave starts (v2.4 invariant 6).
// Only the documented `permissions.allow`, `permissions.deny` and `permissions.ask` rule forms for Bash are evaluated:
// `Bash(<exact command>)`, `Bash(<prefix>:*)` and `Bash(<prefix> *)`, with `*` matching any sequence and a trailing
// ` *` or `:*` also matching the bare prefix. Evaluation order is deny, then ask, then allow. Prose `autoMode.allow`
// entries cannot be evaluated by code: they are counted, never treated as an allow.
// Nothing here reads a file or the clock. No parser message is ever returned: it can quote the file's content.
// Reads or writes: reads (nothing; the settings arrive as arguments).

/**
 * @typedef {Object} SettingsDoc
 * @property {string} path
 * @property {unknown} json  the file's text (parsed here), its parsed object, or null/undefined when the file is missing
 */

/**
 * @typedef {Object} PermissionResult
 * @property {boolean} allowed
 * @property {string|null} rule     the allow rule that names the command, as written (`Bash(...)`)
 * @property {string|null} source   the settings file that rule came from
 * @property {string|null} denied   the deny rule that matched, as written
 * @property {string|null} ask      the ask rule that matched, as written (a relay cannot answer a prompt)
 * @property {string[]} broad       matching allow rules that do not name the command's script; auto mode drops them
 * @property {number} autoModeRules count of prose `autoMode.allow` entries
 * @property {Array<{path: string, error: 'missing'|'unparseable'|null}>} checked  every file given, in order
 */

/** Where Claude Code reads managed settings. Their deny and ask rules count; their allow rules are not read. */
export const MANAGED_SETTINGS_PATHS = [
  '/Library/Application Support/ClaudeCode/managed-settings.json',
  '/etc/claude-code/managed-settings.json',
]

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * One settings document to an object, or the fixed reason it cannot be used.
 * @param {unknown} json
 * @returns {{ settings: object|null, error: 'missing'|'unparseable'|null }}
 */
function readDoc(json) {
  if (json === null || json === undefined) return { settings: null, error: 'missing' }
  let value = json
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json)
    } catch {
      // The parser's message can quote the file, so it is dropped here.
      return { settings: null, error: 'unparseable' }
    }
  }
  return isObject(value) ? { settings: value, error: null } : { settings: null, error: 'unparseable' }
}

/**
 * The content of a `Bash` rule: `null` for no Bash rule, '' for the bare `Bash` (any command), else the text in parens.
 * @param {unknown} rule
 * @returns {string|null}
 */
function bashContent(rule) {
  if (typeof rule !== 'string') return null
  const text = rule.trim()
  if (text === 'Bash') return '*'
  const m = /^Bash\(([\s\S]*)\)$/.exec(text)
  return m && m[1].trim() !== '' ? m[1].trim() : null
}

/**
 * Does the rule content match the command? `*` matches any sequence; a trailing ` *` or `:*` also matches the bare prefix.
 * @param {string} content
 * @param {string} command
 */
function matches(content, command) {
  let pattern = content
  let bare = false
  if (pattern.endsWith(':*')) {
    pattern = `${pattern.slice(0, -2)} *`
  }
  if (pattern.endsWith(' *')) {
    bare = true
    pattern = pattern.slice(0, -2)
  }
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*')
  return new RegExp(`^${body}${bare ? '(?: [\\s\\S]*)?' : ''}$`).test(command)
}

/**
 * The merge script's path in a command: the first word that ends in `merge-pr.js`, else null.
 * @param {string} command
 */
function scriptOf(command) {
  return command.split(/\s+/).find((word) => word.endsWith('merge-pr.js')) ?? null
}

/**
 * An allow rule counts only when the text before its first `*` names the script's path. A rule without `*` is its own prefix.
 * @param {string} content
 * @param {string|null} script
 */
function namesScript(content, script) {
  if (script === null) return false
  const star = content.indexOf('*')
  return (star === -1 ? content : content.slice(0, star)).includes(script)
}

/**
 * Check one command against the settings files.
 * @param {string} command  the command as the relay will type it
 * @param {SettingsDoc[]} settingsDocs  in the order they are listed in `checked`; the first matching allow rule wins
 * @returns {PermissionResult}
 */
export function checkPermission(command, settingsDocs) {
  const script = scriptOf(command)
  /** @type {PermissionResult} */
  const result = { allowed: false, rule: null, source: null, denied: null, ask: null, broad: [], autoModeRules: 0, checked: [] }
  let allowRule = null
  let allowSource = null
  for (const { path, json } of settingsDocs) {
    const { settings, error } = readDoc(json)
    result.checked.push({ path, error })
    if (settings === null) continue
    const managed = MANAGED_SETTINGS_PATHS.includes(path)
    const permissions = isObject(settings.permissions) ? settings.permissions : {}
    const list = (key) => (Array.isArray(permissions[key]) ? permissions[key] : [])
    for (const rule of list('deny')) {
      const content = bashContent(rule)
      if (content !== null && result.denied === null && matches(content, command)) result.denied = rule.trim()
    }
    for (const rule of list('ask')) {
      const content = bashContent(rule)
      if (content !== null && result.ask === null && matches(content, command)) result.ask = rule.trim()
    }
    if (isObject(settings.autoMode) && Array.isArray(settings.autoMode.allow)) {
      result.autoModeRules += settings.autoMode.allow.filter((entry) => typeof entry === 'string').length
    }
    if (managed) continue
    for (const rule of list('allow')) {
      const content = bashContent(rule)
      if (content === null || !matches(content, command)) continue
      if (namesScript(content, script)) {
        if (allowRule === null) {
          allowRule = rule.trim()
          allowSource = path
        }
      } else if (!result.broad.includes(rule.trim())) {
        result.broad.push(rule.trim())
      }
    }
  }
  if (result.denied === null && result.ask === null && allowRule !== null) {
    result.allowed = true
    result.rule = allowRule
    result.source = allowSource
  }
  return result
}
