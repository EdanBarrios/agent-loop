// Spec review: reviewer -> spikes -> reviewer re-run -> adversarial reviewer -> decision envelope.
// Run with the Workflow tool: { name: 'spec-review', args: { project, specPath, wave, date, tasks? } }.
// args.project: the parsed .claude/loop.local.json. args.specPath: the spec path in the repo. args.wave: the wave to review.
// args.date: YYYY-MM-DD, used in the review file name (scripts have no clock; without it nothing is written).
// args.tasks (optional): [{ id, wave, text }] for a deterministic scan of task text for gate items, on top of the reviewer's.
// All decision logic is in claude/lib/review.js; this script only wires the runtime's agent() and log() to it.
// The review file goes to ~/dev/agent-loop/docs/<project>/<date>-wave-<n>-review.json. Nothing in the project is edited.

export const meta = {
  name: 'spec-review',
  description: 'Review a wave against the spec: reviewer, spikes, adversary, decision envelope; writes the review JSON',
  whenToUse: 'Before each wave; pass .claude/loop.local.json as args.project, the spec path, the wave id and today\'s date.',
  phases: [
    { title: 'Review', detail: 'Reviewer reads the wave against the spec; one extra pass if a recommendation is blocked', model: 'sonnet' },
    { title: 'Spikes', detail: 'One low-effort agent per external fact, answers checked by their recorded source', model: 'haiku' },
    { title: 'Adversary', detail: 'Strongest model, spec and recommendations only, prefers evidence over argument', model: 'fable' },
    { title: 'Write', detail: 'The review JSON goes to the loop repo docs' },
  ],
}

const P = args.project || {}
if (!P.name) throw new Error('args.project.name is missing. Read .claude/loop.local.json in the repo and pass it as args.project.')
if (!args.specPath && !P.spec) throw new Error('args.specPath is missing (and args.project.spec is not set).')
if (args.wave === undefined || args.wave === null || args.wave === '') throw new Error('args.wave is missing.')

const { runSpecReview, DEFAULT_MODELS, WRITER_SCHEMA } = await import('../lib/review.js')

// Scripts cannot touch the filesystem, so the review file is written by a small agent that is told the exact
// text and path and then re-reads the file to confirm it parses.
async function write(path, text) {
  const models = { ...DEFAULT_MODELS, ...(P.models || {}) }
  const res = await agent(
    `Write the file ${path} with exactly the text between the markers below and nothing else (no markers, no added newline). Expand a leading ~ to the home directory and create parent directories first (mkdir -p). Then confirm it parses with python3 -I -c "import json,sys; json.load(open(sys.argv[1]))" <the expanded path>. Do not edit any other file. Return { path, bytes } with the expanded path and the byte size.
<<<BEGIN>>>
${text}<<<END>>>`,
    { label: 'writer', phase: 'Write', schema: WRITER_SCHEMA, ...models.writer },
  )
  if (!res) throw new Error('writer agent returned nothing')
}

phase('Review')
return await runSpecReview({
  project: P,
  specPath: args.specPath || P.spec,
  wave: String(args.wave),
  date: args.date,
  tasks: args.tasks || [],
  agent,
  write,
  log,
})
