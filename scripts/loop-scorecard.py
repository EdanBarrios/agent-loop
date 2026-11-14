#!/usr/bin/env python3
"""Write a per-wave scorecard for the agent loop (Appendix C) from a Workflow output file.

Usage: python3 -I scripts/loop-scorecard.py <wave> <date> <workflow-output.json>... [--out <path>] > <path>

Pass the path the scorecard is redirected to as --out, e.g. docs/<project>/<date>-wave-<wave>-loop.md. The script
only reads it: the scorecards found beside it (earlier file names, *-wave-*-loop.md) give the median that the
token flag is measured against. Without --out the token flag is skipped.

Timings mode (reads only, prints to stdout; a separate mode that takes no wave or date):

    python3 -I scripts/loop-scorecard.py --timings <workflow-output.json>...

prints minutes per phase per task and for the wave. Build, review and fix rounds come from the agent records
(`startedAt`, `durationMs`; an agent ends at `startedAt + durationMs`); local check, slot wait, CI wait, merge and
main check come from `result.timings[taskId]` (`localCheckMs`, `slotWaitMs`, `ciWaitMs`, `mergeMs`,
`mainCheckMs`). A phase with no source prints n/a. Idle time is the wall time (first agent start to last agent
end) minus the time with at least one agent running; it is n/a unless every agent record has `startedAt`.

Several output files (a wave relaunched after escalations) are merged in order: agents accumulate, a task's
later record replaces its earlier one, and escalations from every run are listed.

The output file is the JSON the Workflow tool writes when a wave-loop run completes. It holds the
script's return value (gate, tasks, escalations) and one entry per agent with model, tokens and
duration. The scorecard records, per role, the signals used to decide whether a role's model or
effort should move up or down a notch:

- worker:  first-pass MERGE rate; fix items by cause (defect, spec_miss, loop)
- critic:  misses (main red after a MERGE, i.e. a revert), STOP verdicts, escalations
- merger:  failed or reverted merges
- all:     tokens and minutes per role, the model each role requested and the model that served it
           (a difference prints a MODEL MISMATCH line; an unrecorded served model prints "unknown")

`loopVersion` (wave-loop 2.2.0 and later) prints on the Date line; a run without it raises a LOOP VERSION flag,
because an older wave-loop ran and the sections it does not record read as empty, not as zero.

Also read from the result when present: `decisions` (the decision ledger: accepted, asked, reversed, reversal
rate) and `reality` (the reality gate's gaps). Both are optional, so v1 outputs still render.

Agent records: `model` is the model the agent ran on (served). `servedModel` overrides it and `requestedModel`
sets what was requested for that agent; otherwise the request is `result.models[role].model`. A request given
as an alias ("sonnet") matches any served id of that family ("claude-sonnet-5-5").
"""

import glob
import json
import os
import re
import statistics
import sys
from collections import defaultdict

STANDARD_ROLES = ("worker", "critic", "merger")
TOKEN_FLAG_FACTOR = 2
TOKEN_HISTORY = 3
ENVELOPE_MIN_DECISIONS = 20
ENVELOPE_MAX_REVERSAL = 0.10


def walk(o, out):
    if isinstance(o, dict):
        if o.get("type") == "workflow_agent":
            out.append(o)
        for v in o.values():
            walk(v, out)
    elif isinstance(o, list):
        for v in o:
            walk(v, out)


# wave-loop runs its command relays (labels ci:, preflight:, main:, delta:, facts:) on the merger's model (RELAY_MODEL).
RELAY_ROLES = {"ci": "merger", "preflight": "merger", "main": "merger", "delta": "merger", "facts": "merger"}


def role_of(label):
    """Role from the agent label prefix (`worker:1.2`, `critic:1.2 r1`, `merger:1.2`)."""
    return (label or "?").split(":")[0].strip().lower() or "?"


def dedupe(agents):
    """The same agent record can appear more than once in a nested output; keep the first by agentId."""
    seen = set()
    out = []
    for a in agents:
        key = a.get("agentId")
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        out.append(a)
    return out


def model_matches(requested, served):
    """Equal ids match; an alias ("sonnet") matches any served id of that family ("claude-sonnet-5-5")."""
    if requested == served:
        return True
    for alias, full in ((requested, served), (served, requested)):
        if not alias.startswith("claude-") and (full.startswith("claude-" + alias + "-") or full.startswith(alias + "-")):
            return True
    return False


def previous_tokens(out_path):
    """Token totals of the scorecards beside out_path that sort before it, newest last, at most TOKEN_HISTORY."""
    here = os.path.abspath(out_path)
    name = os.path.basename(here)
    files = sorted(
        f for f in glob.glob(os.path.join(os.path.dirname(here), "*-wave-*-loop.md"))
        if os.path.basename(f) < name
    )
    totals = []
    for f in files:
        try:
            with open(f, encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            continue
        total = scorecard_tokens(text)
        if total:
            totals.append(total)
    return totals[-TOKEN_HISTORY:]


def scorecard_tokens(text):
    """Total tokens of a written scorecard: the Total tokens line, else the Roles table's Tokens column (v1)."""
    m = re.search(r"Total tokens: ([\d,]+)", text)
    if m:
        return int(m.group(1).replace(",", ""))
    col = None
    total = 0
    in_roles = False
    for line in text.splitlines():
        if line.startswith("## "):
            in_roles = line.strip() == "## Roles"
            col = None
            continue
        if not in_roles or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if "Tokens" in cells:
            col = cells.index("Tokens")
        elif col is not None and col < len(cells) and re.fullmatch(r"[\d,]+", cells[col]):
            total += int(cells[col].replace(",", ""))
    return total


def cell(text):
    return str(text).replace("|", "/").replace("\n", " ")


def load(path):
    with open(path) as f:
        doc = json.load(f)
    result = doc.get("result", doc)
    if isinstance(result, str):
        result = json.loads(result)
    agents = []
    walk(doc, agents)
    return result, dedupe(agents)


def merge_results(paths):
    """Merge several output files of one wave: agents accumulate, a task's later record replaces its earlier
    one (rounds accumulate), escalations and reality gaps from every run are kept, decisions are keyed by id."""
    result = {"gate": "?", "models": {}, "tasks": {}, "escalations": [], "decisions": [], "reality": None, "timings": {}, "loopVersions": []}
    agents = []
    decisions = {}
    anon = 0
    for path in paths:
        r, a = load(path)
        agents.extend(a)
        result["gate"] = r.get("gate", "?")
        result["loopVersions"].append(r.get("loopVersion"))
        if r.get("models"):
            result["models"] = r["models"]
        for tid, t in r.get("tasks", {}).items():
            prev = result["tasks"].get(tid)
            if prev and prev.get("rounds"):
                t = dict(t, rounds=prev["rounds"] + t.get("rounds", []))
            result["tasks"][tid] = t
        result["escalations"].extend(r.get("escalations", []))
        for tid, tm in (r.get("timings") or {}).items():
            if isinstance(tm, dict):
                result["timings"][tid] = dict(result["timings"].get(tid, {}), **tm)
        for d in r.get("decisions") or []:
            key = d.get("id")
            if key is None:
                anon += 1
                key = f"?{anon}"
            decisions[key] = d
        reality = r.get("reality")
        if reality is not None:
            result["reality"] = merge_reality(result["reality"], reality)
    result["decisions"] = list(decisions.values())
    return result, agents


def merge_reality(prev, new):
    """A reality result is `{ ok, gaps, error? }` or a bare list of gaps. Later runs replace gaps with the same id."""
    if isinstance(new, list):
        new = {"ok": True, "gaps": new}
    gaps = {g.get("id", f"?{i}"): g for i, g in enumerate((prev or {}).get("gaps", []))}
    for i, g in enumerate(new.get("gaps") or []):
        gaps[g.get("id", f"?{len(gaps) + i}")] = g
    return {"ok": new.get("ok", True) is not False, "error": new.get("error"), "gaps": list(gaps.values())}


def role_rows(agents, models):
    """Per role: runs, tokens, minutes, requested ids, served ids, and the mismatches (role, requested, served)."""
    by_role = {}
    mismatches = []
    for a in agents:
        role = role_of(a.get("label"))
        r = by_role.setdefault(role, {"runs": 0, "tokens": 0, "minutes": 0.0, "requested": set(), "served": set()})
        r["runs"] += 1
        r["tokens"] += a.get("tokens") or 0
        r["minutes"] += (a.get("durationMs") or 0) / 60000
        requested = a.get("requestedModel") or (models.get(role) or models.get(RELAY_ROLES.get(role, "")) or {}).get("model")
        served = a.get("servedModel") or a.get("model")
        if requested:
            r["requested"].add(requested)
        r["served"].add(served or "unknown")
        if requested and served and not model_matches(requested, served):
            triple = (role, requested, served)
            if triple not in mismatches:
                mismatches.append(triple)
    return by_role, mismatches


def ordered_roles(by_role):
    return [r for r in STANDARD_ROLES if r in by_role] + sorted(r for r in by_role if r not in STANDARD_ROLES)


def ledger(decisions):
    accepted = sum(1 for d in decisions if (d.get("decision") or d.get("outcome")) in ("accept", "accepted"))
    asked = sum(1 for d in decisions if (d.get("decision") or d.get("outcome")) in ("ask", "asked"))
    reversed_ = sum(1 for d in decisions if d.get("reversedBy"))
    rate = reversed_ / len(decisions) if decisions else 0.0
    return accepted, asked, reversed_, rate


def main(wave, date, paths, out_path=None):
    result, agents = merge_results(paths)
    runs = len(paths)

    by_role, mismatches = role_rows(agents, result["models"])
    total_tokens = sum(r["tokens"] for r in by_role.values())
    total_minutes = sum(r["minutes"] for r in by_role.values())

    flags = [f"MODEL MISMATCH {role} requested {req} served {srv}" for role, req, srv in mismatches]
    versions = result["loopVersions"]
    for i, v in enumerate(versions, 1):
        if not v:
            flags.append(f"LOOP VERSION unknown in run {i}: the result has no loopVersion, so a wave-loop older than 2.2.0 ran (the session resolved another copy of the loop). Its timings, decision ledger and reality gate are not recorded; this wave is not a baseline for the current loop.")
    known = sorted({v for v in versions if v})
    if len(known) > 1:
        flags.append(f"LOOP VERSION differs between runs: {', '.join(known)}")
    loop_line = ", ".join(v or "unknown" for v in versions) or "unknown"
    token_line = None
    if out_path:
        history = previous_tokens(out_path)
        if history:
            median = statistics.median(history)
            ratio = total_tokens / median if median else 0.0
            token_line = f"- Tokens vs previous scorecards: {ratio:.1f}x the median {int(median):,} of the last {len(history)}"
            if median and total_tokens > TOKEN_FLAG_FACTOR * median:
                flags.append(f"TOKEN FLAG wave {wave} used {total_tokens:,} tokens, {ratio:.1f}x the median {int(median):,} of the last {len(history)} scorecards beside the output path")
        else:
            token_line = "- Tokens vs previous scorecards: no previous scorecards beside the output path"
    else:
        token_line = "- Tokens vs previous scorecards: skipped (no --out given)"

    tasks = result.get("tasks", {})
    escalations = result.get("escalations", [])
    first_pass = 0
    cause_counts = defaultdict(int)
    fix_rows = []
    reverts = 0
    merge_failures = 0
    for tid, t in tasks.items():
        rounds = t.get("rounds", [])
        if rounds and rounds[0].get("verdict") == "MERGE":
            first_pass += 1
        if t.get("reopened"):
            reverts += 1
        m = t.get("merge") or {}
        if m.get("outcome") == "failed":
            merge_failures += 1
        for rd in rounds:
            for fi in rd.get("fixItems", []):
                cause = fi.get("cause", "unclassified")
                cause_counts[cause] += 1
                fix_rows.append((tid, rd.get("round"), cause, fi.get("what", "").split(". ")[0][:140]))

    out = []
    out.append(f"# Wave {wave} loop scorecard")
    out.append("")
    out.append(f"Date: {date}. Gate: **{result.get('gate', '?')}** after {runs} run(s). Loop: {loop_line}. Source: Workflow run output; requested models from the result, served models from the agent records.")
    out.append("")
    out.append("## Flags")
    out.append("")
    if flags:
        for f in flags:
            out.append(f)
            out.append("")
    else:
        out.append("None.")
        out.append("")
    out.append("## Tasks")
    out.append("")
    out.append("| Task | PR | Rounds | Verdicts | Merge |")
    out.append("| --- | --- | --- | --- | --- |")
    for tid, t in tasks.items():
        pr = t.get("pr") or {}
        verdicts = ", ".join(str(r.get("verdict")) for r in t.get("rounds", []))
        m = t.get("merge") or {}
        sha = (m.get("mergeSha") or "")[:7]
        out.append(f"| {tid} {t.get('title', '')} | #{pr.get('number', '?')} | {len(t.get('rounds', []))} | {verdicts} | {m.get('outcome', 'none')} {sha} |")
    out.append("")
    out.append("## Fix items by cause")
    out.append("")
    if fix_rows:
        out.append("| Task | Round | Cause | Item |")
        out.append("| --- | --- | --- | --- |")
        for tid, rd, cause, what in fix_rows:
            out.append(f"| {tid} | {rd} | {cause} | {cell(what)} |")
    else:
        out.append("None.")
    out.append("")
    out.append("## Roles")
    out.append("")
    out.append("| Role | Requested | Served | Runs | Tokens | Share | Minutes |")
    out.append("| --- | --- | --- | --- | --- | --- | --- |")
    for role in ordered_roles(by_role):
        r = by_role[role]
        share = (r["tokens"] / total_tokens * 100) if total_tokens else 0
        requested = ", ".join(sorted(r["requested"])) or "unknown"
        served = ", ".join(sorted(r["served"]))
        out.append(f"| {role} | {requested} | {served} | {r['runs']} | {r['tokens']:,} | {share:.0f}% | {r['minutes']:.1f} |")
    out.append("")
    out.append("## Decision ledger")
    out.append("")
    decisions = result["decisions"]
    if decisions:
        accepted, asked, reversed_, rate = ledger(decisions)
        out.append(f"- Accepted: {accepted}")
        out.append(f"- Asked: {asked}")
        out.append(f"- Reversed: {reversed_}")
        out.append(f"- Reversal rate: {rate * 100:.0f}% ({reversed_} of {len(decisions)} decisions)")
        if len(decisions) < ENVELOPE_MIN_DECISIONS:
            verdict = f"not eligible to widen ({len(decisions)} decisions, fewer than {ENVELOPE_MIN_DECISIONS} needed)"
        elif rate < ENVELOPE_MAX_REVERSAL:
            verdict = "eligible to widen one notch, one dimension (a human step)"
        else:
            verdict = f"not eligible to widen (reversal rate {rate * 100:.0f}% is not under {ENVELOPE_MAX_REVERSAL * 100:.0f}%)"
        out.append(f"- Envelope: {verdict}")
    else:
        out.append("Ledger: no decisions recorded.")
    out.append("")
    out.append("## Reality gate")
    out.append("")
    reality = result["reality"]
    if reality is None:
        out.append("No reality check recorded.")
    else:
        if not reality["ok"]:
            out.append(f"The reality check did not run cleanly ({cell(reality.get('error') or 'no reason given')}); the gate treats that as a block.")
            out.append("")
        gaps = reality["gaps"]
        if gaps:
            blocking = sum(1 for g in gaps if g.get("severity") == "block")
            out.append(f"Wave {wave}: {blocking} blocking, {len(gaps) - blocking} other.")
            out.append("")
            out.append("| Gap | Severity | What |")
            out.append("| --- | --- | --- |")
            for g in gaps:
                out.append(f"| {cell(g.get('id', '?'))} | {cell(g.get('severity', '?'))} | {cell(g.get('what', ''))} |")
        elif reality["ok"]:
            out.append(f"Wave {wave}: no gaps.")
    out.append("")
    out.append("## Signals")
    out.append("")
    n = len(tasks)
    out.append(f"- Worker first-pass MERGE: {first_pass}/{n}")
    out.append(f"- Fix items: " + ", ".join(f"{k} {v}" for k, v in sorted(cause_counts.items())) if cause_counts else "- Fix items: none")
    out.append(f"- Critic misses (revert after MERGE): {reverts}")
    out.append(f"- Merge failures: {merge_failures}")
    out.append(f"- Escalations: {len(escalations)}" + ("" if not escalations else " (" + "; ".join(f"{e.get('task')}: {e.get('what')}" for e in escalations) + ")"))
    out.append(f"- Total tokens: {total_tokens:,}")
    out.append(f"- Total agent minutes: {total_minutes:.1f}")
    out.append(token_line)
    out.append("")
    out.append("## Decision rule")
    out.append("")
    out.append("Two waves in a row trigger a change. Worker: first-pass MERGE under half with defect-cause items, bump up; only spec_miss items, fix the prompt. Critic: zero misses for two waves with only cosmetic findings, bump down. Merger: any failure traced to the model, bump up. Loop-cause items are fixed in the workflow script, not by a model change. A model-mismatch flag means the run is not a clean baseline for the role: fix the cause before reading its numbers.")
    print("\n".join(out))


TIMING_COLUMNS = (
    ("Build", "build"),
    ("Local check", "localCheckMs"),
    ("Slot wait", "slotWaitMs"),
    ("Review", "review"),
    ("CI wait", "ciWaitMs"),
    ("Merge", "mergeMs"),
    ("Main check", "mainCheckMs"),
    ("Fix rounds", "fix"),
)
AGENT_PHASES = ("build", "review", "fix")


def task_of(label):
    """Task id from an agent label (`worker:1.2 fix1` -> `1.2`); None for labels without one (`reality:check`)."""
    role, sep, rest = (label or "").partition(":")
    if not sep or role.strip().lower() not in STANDARD_ROLES:
        return None
    return rest.strip().split(" ")[0] or None


def agent_phase(label):
    """Phase of an agent record: worker -> build, worker fix/resume/reopen -> fix, critic -> review, merger -> merge."""
    role = role_of(label)
    suffix = (label or "").partition(":")[2].strip().partition(" ")[2].strip().lower()
    if role == "worker":
        return "fix" if re.match(r"(fix|resume|reopen)", suffix) else "build"
    return {"critic": "review", "merger": "merge"}.get(role)


def fmt_min(ms):
    return "n/a" if ms is None else f"{ms / 60000:.1f}"


def busy_ms(intervals):
    """Length of the union of (start, end) intervals."""
    total = 0
    current_end = None
    for start, end in sorted(intervals):
        if current_end is None or start > current_end:
            total += end - start
            current_end = end
        elif end > current_end:
            total += end - current_end
            current_end = end
    return total


def timings_report(paths):
    result, agents = merge_results(paths)
    given = result["timings"]

    # Per task: milliseconds by phase, or None when no source exists.
    ids = []
    for tid in list(result["tasks"]) + [task_of(a.get("label")) for a in agents] + list(given):
        if tid and tid not in ids:
            ids.append(tid)
    has_agents = set()
    phases = {tid: {} for tid in ids}
    for a in agents:
        tid = task_of(a.get("label"))
        phase = agent_phase(a.get("label"))
        if not tid or not phase:
            continue
        has_agents.add(tid)
        phases[tid][phase] = phases[tid].get(phase, 0) + (a.get("durationMs") or 0)
    for tid in ids:
        # The merge script's elapsed time is the source for merge; a merger agent is the fallback (merger: 'agent').
        if "mergeMs" in given.get(tid, {}):
            phases[tid]["mergeMs"] = given[tid]["mergeMs"]
        elif "merge" in phases[tid]:
            phases[tid]["mergeMs"] = phases[tid]["merge"]
        for key in ("localCheckMs", "slotWaitMs", "ciWaitMs", "mainCheckMs"):
            if isinstance(given.get(tid, {}).get(key), (int, float)):
                phases[tid][key] = given[tid][key]
        for key in AGENT_PHASES:
            if tid in has_agents:
                phases[tid].setdefault(key, 0)

    out = ["# Timings", ""]
    out.append(
        "Minutes per phase. Build, review and fix rounds come from the agent records (build and fix rounds include the "
        "worker's local check and slot wait); local check, slot wait, CI wait, merge and main check come from "
        "result.timings. n/a means no source."
    )
    out.append("")
    out.append("| Task | " + " | ".join(c[0] for c in TIMING_COLUMNS) + " |")
    out.append("| --- |" + " --- |" * len(TIMING_COLUMNS))
    for tid in ids:
        out.append(f"| {cell(tid)} | " + " | ".join(fmt_min(phases[tid].get(c[1])) for c in TIMING_COLUMNS) + " |")
    wave = []
    for _, key in TIMING_COLUMNS:
        values = [phases[tid][key] for tid in ids if key in phases[tid]]
        wave.append(fmt_min(sum(values) if values else None))
    out.append("| wave | " + " | ".join(wave) + " |")
    out.append("")

    wall = idle = None
    if agents and all(isinstance(a.get("startedAt"), (int, float)) for a in agents):
        spans = [(a["startedAt"], a["startedAt"] + (a.get("durationMs") or 0)) for a in agents]
        wall = max(e for _, e in spans) - min(s for s, _ in spans)
        idle = wall - busy_ms(spans)
    ci = [phases[tid]["ciWaitMs"] for tid in ids if "ciWaitMs" in phases[tid]]
    share = f"{sum(ci) / wall * 100:.1f}%" if ci and wall else "n/a"
    out.append(f"- Wall time: {fmt_min(wall)}" + ("" if wall is None else " min"))
    out.append(f"- Idle time (no agent running): {fmt_min(idle)}" + ("" if idle is None else " min"))
    out.append(f"- CI wait share of wall time: {share}")
    print("\n".join(out))


def parse_args(argv):
    out_path = None
    rest = []
    it = iter(argv)
    for a in it:
        if a == "--timings":
            continue
        if a == "--out":
            out_path = next(it, None)
            if not out_path:
                sys.exit("--out needs a path")
        elif a.startswith("--out="):
            out_path = a[len("--out="):]
        else:
            rest.append(a)
    return rest, out_path


if __name__ == "__main__":
    args, out_path = parse_args(sys.argv[1:])
    if "--timings" in sys.argv[1:]:
        if not args:
            sys.exit(__doc__)
        timings_report(args)
        sys.exit(0)
    if len(args) < 3:
        sys.exit(__doc__)
    main(args[0], args[1], args[2:], out_path)
