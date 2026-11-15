# Warden wave 2 spec review (15 Nov 2026)

Run before the schema was approved, against the session's draft (warden PR #23), by `scriptPath` (loop 2.2.1).
12 agents, about 962k subagent tokens, 41 minutes. Review JSON beside this file.

**Outcome:** 8 accepted, 15 asked, 7 spikes (6 answered, 1 open), 16 gates, second round suggested.

**What it caught that the drafts missed:**
- R1: 2.T made `getProcessView` async but owned none of its six callers, so the tail would break typecheck or edit
  files it does not own. The same ownership trap as wave 1's tail; worth a spec-lint rule (a signature change in an
  owned file with callers in unowned files).
- R6: the draft schema was open to Supabase's public Data API (no row level security; views with owner rights;
  `schema_migrations` too). A real security hole, caught before any database existed.
- R3: no task loaded the state deadline, so the clock would have stayed "Pending source" after Edan's step 4.
- R12: redirects were checked after the request, so an unlisted host could be contacted.
- R13, R15: a midway failure left unclassified permits; `pg` and PGlite return dates differently.

**How the session applied it:** accepted edits applied with the adversary's caveats (R3 folded into 2.5 instead of a
new 2.7, which kept the chain at 2 deep); R2, R4, R5, R6, R9, R14, R16, R17, R19, R22 applied with the session's
defaults, because they were technical and reversible or strengthened an invariant; R7, R8, R10, R11 and R18 left to
Edan with defaults written into the spec's "Open for Edan".

**Loop notes:**
- The adversary was the most useful stage: 5 of its blocks or disagreements found a real problem in the proposed
  edit itself (a deadlocking task 2.8, a fail-open guard, an edit with no owned test file).
- "needs human review" is driven by category (secret, account, privacy, quota) rather than by consequence; several
  asked items had a clear safe default. The spec-review prompt could ask for a recommended default on every ask.
- Cost: heavy again (about 962k tokens for 7 tasks; 823k for 2 tasks in wave 1d). Worth it here, because R1 and R6
  would each have cost a failed wave or a security fix after launch.
