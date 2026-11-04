// Delta: did a pull request change anything a reviewer must see since the head a critic approved?
// Pure logic with injected I/O (run); scripts/ci-only.js wires real gh and git.
// Reads or writes: reads (gh pr view, git fetch, git rev-list, git show, git diff, git merge-tree).
//
// A change since the reviewed head is CI-only when every commit on the branch's first-parent line after it is either
//  - a sync merge from the default branch with no conflict resolution: its other parent is on origin/<base> and the
//    merge commit's tree is exactly what `git merge-tree --write-tree` makes of its two parents, or
//  - a formatting-only commit (a formatter or a lint autofix): every file it touches is modified, not added, deleted or
//    renamed, and its text is the same before and after once whitespace, quote style, semicolons and trailing commas
//    are ignored (formattingOnly below).
// No new commit at all (a fix round that changed nothing) is CI-only too. Anything else, and anything that cannot be
// read, is not: the critic reviews it.

/**
 * @typedef {Object} RunResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} [stderr]
 */

/**
 * The text a formatter could not have changed: whitespace removed, single quotes read as double quotes, and semicolons
 * and trailing commas (a comma directly before a closing bracket) dropped.
 * @param {string} text
 */
export function normaliseFormatting(text) {
  return String(text)
    .replace(/\s+/g, '')
    .replace(/'/g, '"')
    .replace(/;/g, '')
    .replace(/,(?=[)\]}])/g, '')
}

/**
 * True when `after` differs from `before` only in what a formatter or lint autofix changes.
 * @param {string} before @param {string} after
 */
export function formattingOnly(before, after) {
  return normaliseFormatting(before) === normaliseFormatting(after)
}

const SHA = /^[0-9a-f]{40,64}$/

/**
 * @param {{ pr: number|string, since: string, repo?: string }} opts  since: the PR head the critic reviewed
 * @param {{ run: (command: string) => Promise<RunResult>|RunResult }} deps  one shell command in the repo; never throws
 * @returns {Promise<{ ciOnly: boolean, since: string, head: string|null, reason: string, commits: number, files: string[] }>}
 */
export async function ciOnlyChange(opts, deps) {
  const n = String(opts.pr)
  const since = String(opts.since || '')
  const out = { ciOnly: false, since, head: /** @type {string|null} */ (null), reason: '', commits: 0, files: /** @type {string[]} */ ([]) }
  const no = (reason) => ({ ...out, ciOnly: false, reason })
  const run = async (command) => {
    const r = await deps.run(command)
    return { code: r.code, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
  }

  if (!/^[0-9a-f]{7,64}$/.test(since)) return no(`the reviewed head "${since}" is not a commit sha`)
  const v = await run(`gh pr view ${n} --json headRefOid,baseRefName`)
  let pr = null
  try {
    pr = v.code === 0 ? JSON.parse(v.stdout) : null
  } catch {
    pr = null
  }
  if (!pr || !SHA.test(String(pr.headRefOid || '')) || !pr.baseRefName) return no(`could not read PR #${n}`)
  const head = String(pr.headRefOid)
  const base = String(pr.baseRefName)
  out.head = head
  if (head === since || head.startsWith(since)) return { ...out, ciOnly: true, reason: 'no new commits since the reviewed head' }

  const f = await run('git fetch origin')
  if (f.code !== 0) return no('git fetch origin failed')
  const anc = await run(`git merge-base --is-ancestor ${since} ${head}`)
  if (anc.code !== 0) return no(`the reviewed head ${since} is not an ancestor of the PR head ${head}`)
  const list = await run(`git rev-list --first-parent --parents ${since}..${head}`)
  if (list.code !== 0) return no('git rev-list failed')
  const commits = list.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/).filter(Boolean))
    .filter((p) => p.length > 0)
  out.commits = commits.length
  if (!commits.length) return { ...out, ciOnly: true, reason: 'no new commits since the reviewed head' }

  let merges = 0
  let formatted = 0
  const files = new Set()
  for (const [sha, ...parents] of commits) {
    if (parents.length >= 2) {
      if (parents.length > 2) return no(`${sha} is an octopus merge`)
      const onBase = await run(`git merge-base --is-ancestor ${parents[1]} origin/${base}`)
      if (onBase.code !== 0) return no(`merge ${sha} brings in ${parents[1]}, which is not on origin/${base}`)
      const tree = await run(`git rev-parse ${sha}^{tree}`)
      const auto = await run(`git merge-tree --write-tree ${parents[0]} ${parents[1]}`)
      const autoTree = auto.code === 0 ? auto.stdout.trim().split('\n')[0].trim() : ''
      if (tree.code !== 0 || !autoTree || tree.stdout.trim() !== autoTree) return no(`merge ${sha} resolved a conflict or changed the merge result`)
      merges++
      continue
    }
    if (parents.length !== 1) return no(`${sha} has no parent in the range`)
    const parent = parents[0]
    const diff = await run(`git diff --name-status --no-renames ${parent} ${sha}`)
    if (diff.code !== 0) return no(`git diff failed on ${sha}`)
    const rows = diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    for (const row of rows) {
      const [status, path] = row.split('\t')
      if (status !== 'M' || !path) return no(`${sha} ${status === 'A' ? 'adds' : status === 'D' ? 'deletes' : 'changes the type of'} ${path || row}`)
      const a = await run(`git show ${parent}:${shq(path)}`)
      const b = await run(`git show ${sha}:${shq(path)}`)
      if (a.code !== 0 || b.code !== 0) return no(`could not read ${path} at ${sha}`)
      if (!formattingOnly(a.stdout, b.stdout)) return no(`${sha} changes ${path} beyond formatting`)
      files.add(path)
    }
    formatted++
  }
  const parts = []
  if (formatted) parts.push(`${formatted} formatting-only commit${formatted === 1 ? '' : 's'} (${files.size} file${files.size === 1 ? '' : 's'})`)
  if (merges) parts.push(`${merges} clean sync merge${merges === 1 ? '' : 's'}`)
  return { ...out, ciOnly: true, files: [...files], reason: parts.join(' and ') }
}

/** Quote a path for the shell when it needs it. @param {string} p */
function shq(p) {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}
