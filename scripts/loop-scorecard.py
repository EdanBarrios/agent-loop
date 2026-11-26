#!/usr/bin/env python3
"""Write a per-wave scorecard for the agent loop (Appendix C) from a Workflow output file.

Usage: python3 -I scripts/loop-scorecard.py <wave> <date> <workflow-output.json>... [--out <path>] [--escaped <n> | --escaped-from <escaped.json>] > <path>

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

Pooled mode (reads only, prints to stdout; takes no wave or date):

    python3 -I scripts/loop-scorecard.py --pool <workflow-output.json>... [--escaped-from <escaped.json>]

prints one table across the given runs, each file one run (task ids may repeat between runs and are kept apart): the
rates with their intervals, fix items by cause, checklist failures and tokens per task, with no per-task section.

Several output files (a wave relaunched after escalations) are merged in order: agents accumulate, a task's
later record replaces its earlier one, and escalations from every run are listed.

The output file is the JSON the Workflow tool writes when a wave-loop run completes. It holds the
script's return value (gate, tasks, escalations) and one entry per agent with model, tokens and
duration. The scorecard records, per role, the signals used to decide whether a role's model or
effort should move up or down a notch:

- worker:  first-pass MERGE rate with its 95% Wilson interval; fix items by cause (defect, spec_miss, loop)
- critic:  the share of merged tasks with at least one miss (a revert after MERGE or an escaped fix), with its
           interval; the number of fix commits is printed beside it, not inside the interval; STOP verdicts, escalations
- merger:  failed or reverted merges
- all:     tokens and minutes per role, the model each role requested and the model that served it
           (a difference prints a MODEL MISMATCH line; an unrecorded served model prints "unknown")

--escaped <n>: the number of fix commits made after the wave that trace to a task the wave merged (defects the critic
let through that reached the default branch without a revert). Count them from the default branch's history when
writing the scorecard; they add to the critic's misses. Without it the scorecard says escaped defects were not counted.

From loop 2.3.0 the result also carries the critic's findings (each round record's `findings`, severity high, medium
or low) and `integration`, the integration review of the whole wave's diff. The scorecard lists every high and
medium finding of both.

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
import math
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
WILSON_Z = 1.959964
WORKER_UP_BELOW = 0.50
CRITIC_UP_ABOVE = 0.05
CRITIC_DOWN_BELOW = 0.10
EPS = 1e-9


def wilson(k, n):
    """95% Wilson score interval of k successes in n trials as (low, high), clamped to [0, 1]; None when n is 0."""
    if n <= 0:
        return None
    z2 = WILSON_Z * WILSON_Z
    p = k / n
    denom = 1 + z2 / n
    center = (p + z2 / (2 * n)) / denom
    half = WILSON_Z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom
    low, high = max(0.0, center - half), min(1.0, center + half)
    return (0.0 if low < EPS else low), (1.0 if high > 1 - EPS else high)


def pct(x):
    return f"{x * 100:.0f}"


def rate_text(k, n):
    """`20/30, 67% (49–81%, n=30)`; with no trials `0/0, n/a (n=0)`."""
    ci = wilson(k, n)
    if ci is None:
        return f"{k}/{n}, n/a (n=0)"
    return f"{k}/{n}, {pct(k / n)}% ({pct(ci[0])}–{pct(ci[1])}%, n={n})"


def walk(o, out):
    if isinstance(o, dict):
        if o.get("type") == "workflow_agent":
            out.append(o)
        for v in o.values():
            walk(v, out)
    elif isinstance(o, list):
        for v in o:
            walk(v, out)


# wave-loop runs its command relays (labels ci:, preflight:, main:, delta:, facts:) on RELAY_MODEL, reported as
# models.relay from loop 2.2.1; older results ran them on the merger's model.
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
    result = {"gate": "?", "models": {}, "tasks": {}, "escalations": [], "decisions": [], "reality": None, "timings": {}, "loopVersions": [], "integration": None, "states": {}}
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
        for tid, st in (r.get("state") or {}).items():
            result["states"][tid] = st
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
        integration = r.get("integration")
        if isinstance(integration, dict):
            result["integration"] = integration
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
        requested = a.get("requestedModel") or (models.get(role) or (models.get("relay") if role in RELAY_ROLES else None) or models.get(RELAY_ROLES.get(role, "")) or {}).get("model")
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


LISTED_SEVERITIES = ("high", "medium")


def critic_findings(tasks):
    """High and medium critic findings of every task and round, high first. A finding repeated in a later round of the
    same task is listed once, with the first round it appeared in."""
    rows = []
    seen = set()
    for tid, t in tasks.items():
        for rd in t.get("rounds", []):
            for f in rd.get("findings") or []:
                sev = f.get("severity")
                if sev not in LISTED_SEVERITIES:
                    continue
                key = (tid, sev, f.get("what", ""), f.get("where", ""))
                if key in seen:
                    continue
                seen.add(key)
                rows.append((tid, rd.get("round"), sev, f.get("what", ""), f.get("where", "")))
    return sorted(rows, key=lambda r: LISTED_SEVERITIES.index(r[2]))


def integration_lines(integration):
    """The Integration review section body: high and medium findings, high first, and a count of low ones."""
    out = []
    if not integration:
        return ["Not run (a loop older than 2.3.0, or project.integrationReview is false)."]
    if not integration.get("ran"):
        return [f"Not run: {cell(integration.get('skipped') or integration.get('error') or 'no reason given')}."]
    if integration.get("summary"):
        out.append(cell(integration["summary"]))
        out.append("")
    every = integration.get("findings") or []
    listed = sorted((f for f in every if f.get("severity") in LISTED_SEVERITIES), key=lambda f: LISTED_SEVERITIES.index(f["severity"]))
    if listed:
        out.append("| Severity | Area | What | Where |")
        out.append("| --- | --- | --- | --- |")
        for f in listed:
            out.append(f"| {f['severity']} | {cell(f.get('area', 'other'))} | {cell(f.get('what', ''))} | {cell(f.get('where', ''))} |")
    else:
        out.append("No high or medium findings.")
    low = len(every) - len(listed)
    if low:
        out.append("")
        out.append(f"Low findings not listed: {low}.")
    return out


def merged_ever(t):
    """A task that was merged at some point, including one the loop reverted afterwards."""
    return bool(t.get("merged") or t.get("reopened") or (t.get("merge") or {}).get("outcome") in ("merged", "reverted"))


def task_rows(result, agents, run=1):
    """One row per task of a result. `started` is false for a task that never started: state `paused`, parked for a
    parked dependency, or a tail not run (no rounds, no PR and no worker agent record)."""
    workers = {task_of(a.get("label")) for a in agents if role_of(a.get("label")) == "worker"}
    rows = []
    for tid, t in result.get("tasks", {}).items():
        rounds = t.get("rounds") or []
        paused = t.get("state") == "paused" or result.get("states", {}).get(tid) == "paused"
        started = not paused and bool(rounds or t.get("pr") or tid in workers)
        rows.append({
            "id": tid,
            "run": run,
            "task": t,
            "started": started,
            "first_pass": started and bool(rounds) and rounds[0].get("verdict") == "MERGE",
            "merged": merged_ever(t),
            "reverted": bool(t.get("reopened")),
            "escaped": 0,
            "fixes": [],
        })
    return rows


def load_escaped(path):
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as e:
        sys.exit(f"--escaped-from: cannot read {path}: {e}")
    tasks = doc.get("tasks") if isinstance(doc, dict) else None
    if not isinstance(tasks, dict):
        sys.exit(f"--escaped-from: {path} has no tasks object (the output of scripts/escaped.js)")
    return tasks


def attach_escaped(rows, escaped_tasks):
    """Fill each row's escaped count and fix commits from the escaped file. A task id that appears in several runs is
    attributed to the last run that merged it. Returns the ids of the file's tasks that are not in the runs."""
    ignored = []
    for tid, entry in escaped_tasks.items():
        candidates = [r for r in rows if r["id"] == tid]
        if not candidates:
            ignored.append(tid)
            continue
        merged = [r for r in candidates if r["merged"]]
        row = (merged or candidates)[-1]
        entry = entry if isinstance(entry, dict) else {}
        fixes = [f for f in entry.get("fixes") or [] if f.get("kind") == "fix"]
        count = entry.get("escaped")
        row["escaped"] = count if isinstance(count, int) and count >= 0 else len(fixes)
        row["fixes"] = fixes
    return ignored


def ignored_note(ignored):
    if not ignored:
        return None
    n = len(ignored)
    return f"{n} task{'s' if n != 1 else ''} of the escaped file {'are' if n != 1 else 'is'} not in the given runs and {'were' if n != 1 else 'was'} ignored ({', '.join(ignored)})"


def worker_rate(rows):
    started = [r for r in rows if r["started"]]
    return sum(1 for r in started if r["first_pass"]), len(started)


def critic_rate(rows, attributed):
    """Share of merged tasks with at least one miss: a revert after MERGE or, with per-task attribution, an escaped fix."""
    merged = [r for r in rows if r["merged"]]
    return sum(1 for r in merged if r["reverted"] or (attributed and r["escaped"] > 0)), len(merged)


def fix_commit_count(rows):
    return len({f.get("sha") for r in rows for f in r["fixes"]})


def critic_line(rows, escaped_n, from_file):
    k, n = critic_rate(rows, from_file)
    text = rate_text(k, n)
    if from_file:
        return f"{text}; fix commits: {fix_commit_count(rows)}; escaped defects: {sum(r['escaped'] for r in rows)}"
    if escaped_n is not None:
        return f"{text}; escaped defects: {escaped_n} (no per-task attribution, no interval)"
    return f"{text}; escaped defects not counted, pass --escaped or --escaped-from"


def checklist_rows(rows):
    """Per checklist number: items failed and rounds checked, over rounds whose critic returned a non-empty checklist."""
    failed = defaultdict(int)
    checked = defaultdict(int)
    for r in rows:
        for rd in r["task"].get("rounds") or []:
            seen = set()
            for c in rd.get("checklist") or []:
                if not isinstance(c, dict) or not isinstance(c.get("item"), int):
                    continue
                item = c["item"]
                if item not in seen:
                    seen.add(item)
                    checked[item] += 1
                if c.get("pass") is False:
                    failed[item] += 1
    return [(i, failed[i], checked[i]) for i in sorted(checked)]


def checklist_section(rows):
    table = checklist_rows(rows)
    if not table:
        return []
    out = ["## Checklist failures", "", "| Item | Failed | Rounds checked |", "| --- | --- | --- |"]
    out.extend(f"| {i} | {f} | {c} |" for i, f, c in table)
    out.append("")
    return out


def count_causes(rows):
    causes = defaultdict(int)
    for r in rows:
        for rd in r["task"].get("rounds") or []:
            for fi in rd.get("fixItems") or []:
                causes[fi.get("cause", "unclassified")] += 1
    return causes


def has_listed_finding(rows, integration_list):
    if any(f.get("severity") in LISTED_SEVERITIES for r in rows for rd in r["task"].get("rounds") or [] for f in rd.get("findings") or []):
        return True
    return any(f.get("severity") in LISTED_SEVERITIES for f in integration_list)


def decision_rule(rows, attributed, high_findings):
    """The decision rule text and its reading of these rows: a role moves only when its interval lies wholly on one side
    of the threshold."""
    out = [
        "Rates are read with their 95% Wilson intervals, and a role moves only when the pooled interval lies wholly on one side of the threshold (pool waves with --pool: one wave is rarely enough). "
        "Worker: an upper bound of first-pass MERGE under 50% moves the worker up when the fix items are defect-cause; only spec_miss items, fix the prompt. "
        "Critic: a miss is a revert after MERGE or an escaped defect (a fix commit after the wave that traces to a task the wave merged, counted with --escaped-from); "
        "a lower bound of the share of merged tasks with a miss above 5% moves the critic up (or add the missed kind to the checklist), "
        "and an upper bound under 10% with only low findings moves it down. "
        "Merger: any failure traced to the model, bump up. Loop-cause items are fixed in the workflow script, not by a model change. "
        "A model-mismatch flag means the run is not a clean baseline for the role: fix the cause before reading its numbers.",
        "",
    ]
    wk, wn = worker_rate(rows)
    wci = wilson(wk, wn)
    if wci is None:
        out.append("- Worker: no reading (no task started)")
    elif wci[1] < WORKER_UP_BELOW:
        out.append(f"- Worker: move up (upper bound {pct(wci[1])}% is under 50%)")
    else:
        out.append(f"- Worker: no move (upper bound {pct(wci[1])}% is not under 50%)")
    ck, cn = critic_rate(rows, attributed)
    cci = wilson(ck, cn)
    if cci is None:
        out.append("- Critic up: no reading (no task merged)")
        out.append("- Critic down: no reading (no task merged)")
    else:
        if cci[0] > CRITIC_UP_ABOVE:
            out.append(f"- Critic up: fires (lower bound {pct(cci[0])}% is above 5%)")
        else:
            out.append(f"- Critic up: does not fire (lower bound {pct(cci[0])}% is not above 5%)")
        if cci[1] >= CRITIC_DOWN_BELOW:
            out.append(f"- Critic down: does not fire (upper bound {pct(cci[1])}% is not under 10%)")
        elif high_findings:
            out.append(f"- Critic down: does not fire (upper bound {pct(cci[1])}% is under 10%, but a high or medium finding exists)")
        else:
            out.append(f"- Critic down: fires (upper bound {pct(cci[1])}% is under 10% with only low findings)")
    return out


def main(wave, date, paths, out_path=None, escaped=None, escaped_from=None):
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
    rows = task_rows(result, agents)
    ignored = attach_escaped(rows, load_escaped(escaped_from)) if escaped_from else []
    cause_counts = count_causes(rows)
    fix_rows = []
    reverts = sum(1 for r in rows if r["reverted"])
    merge_failures = 0
    for tid, t in tasks.items():
        m = t.get("merge") or {}
        if m.get("outcome") == "failed":
            merge_failures += 1
        for rd in t.get("rounds", []):
            for fi in rd.get("fixItems", []):
                fix_rows.append((tid, rd.get("round"), fi.get("cause", "unclassified"), fi.get("what", "").split(". ")[0][:140]))
    escaped_total = sum(r["escaped"] for r in rows) if escaped_from else escaped
    wk, wn = worker_rate(rows)

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
    if escaped_from:
        out.append("## Escaped fix commits")
        out.append("")
        listed = [(f, r["id"]) for r in rows for f in r["fixes"]]
        if listed:
            out.append("| Fix commit | Task | Title |")
            out.append("| --- | --- | --- |")
            for f, tid in listed:
                out.append(f"| {cell(str(f.get('sha', ''))[:7])} | {cell(tid)} | {cell(f.get('title', ''))} |")
        else:
            out.append("None.")
        out.append("")
    out.extend(checklist_section(rows))
    out.append("## Critic findings")
    out.append("")
    found = critic_findings(tasks)
    if found:
        out.append("| Task | Round | Severity | What | Where |")
        out.append("| --- | --- | --- | --- | --- |")
        for tid, rd, sev, what, where in found:
            out.append(f"| {cell(tid)} | {rd} | {sev} | {cell(what)} | {cell(where)} |")
    else:
        out.append("None at high or medium severity.")
    out.append("")
    out.append("## Integration review")
    out.append("")
    out.extend(integration_lines(result.get("integration")))
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
    out.append(f"- Worker first-pass MERGE: {rate_text(wk, wn)}")
    left_out = sum(1 for r in rows if not r["started"])
    if left_out:
        out.append(f"- Left out of the rates (never started): {left_out}")
    out.append(f"- Fix items: " + ", ".join(f"{k} {v}" for k, v in sorted(cause_counts.items())) if cause_counts else "- Fix items: none")
    if escaped_total is None:
        out.append(f"- Critic misses: {reverts} (reverts after MERGE {reverts}; escaped defects not counted, pass --escaped)")
    else:
        out.append(f"- Critic misses: {reverts + escaped_total} (reverts after MERGE {reverts}, escaped defects {escaped_total})")
    out.append(f"- Critic miss rate (merged tasks with at least one miss): {critic_line(rows, escaped, bool(escaped_from))}")
    if escaped_from and ignored_note(ignored):
        out.append(f"- Escaped file: {ignored_note(ignored)}")
    out.append(f"- Merge failures: {merge_failures}")
    out.append(f"- Escalations: {len(escalations)}" + ("" if not escalations else " (" + "; ".join(f"{e.get('task')}: {e.get('what')}" for e in escalations) + ")"))
    out.append(f"- Total tokens: {total_tokens:,}")
    out.append(f"- Total agent minutes: {total_minutes:.1f}")
    out.append(token_line)
    out.append("")
    out.append("## Decision rule")
    out.append("")
    out.extend(decision_rule(rows, bool(escaped_from), has_listed_finding(rows, (result.get("integration") or {}).get("findings") or [])))
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


def pool_report(paths, escaped_from=None):
    """One pooled table across runs. Each file is one run: its tasks are kept apart from those of the other files."""
    rows = []
    agents = []
    findings = []
    versions = []
    for i, path in enumerate(paths, 1):
        result, run_agents = merge_results([path])
        rows.extend(task_rows(result, run_agents, i))
        agents.extend(run_agents)
        versions.extend(result["loopVersions"])
        findings.extend((result.get("integration") or {}).get("findings") or [])
    ignored = attach_escaped(rows, load_escaped(escaped_from)) if escaped_from else []
    by_role, _ = role_rows(agents, {})
    total_tokens = sum(r["tokens"] for r in by_role.values())
    wk, wn = worker_rate(rows)
    reverts = sum(1 for r in rows if r["reverted"])
    causes = count_causes(rows)
    repeated = sorted({r["id"] for r in rows if sum(1 for x in rows if x["id"] == r["id"]) > 1})

    out = ["# Pooled scorecard", ""]
    loops = ", ".join(sorted({v or "unknown" for v in versions})) or "unknown"
    out.append(f"Pooled across {len(paths)} run(s). Loop: {loops}. Each file is one run; the rates leave out only tasks that never started.")
    out.append("")
    notes = []
    if repeated:
        notes.append(f"Task id(s) {', '.join(repeated)} appear in more than one run and are counted once per run; an escaped file attributes a task to the last run that merged it.")
    if escaped_from and ignored_note(ignored):
        notes.append(ignored_note(ignored) + ".")
    for note in notes:
        out.append(note)
        out.append("")
    out.append("## Pooled table")
    out.append("")
    out.append("| Measure | Value |")
    out.append("| --- | --- |")
    out.append(f"| Runs | {len(paths)} |")
    out.append(f"| Tasks started | {wn} |")
    out.append(f"| Left out (never started) | {sum(1 for r in rows if not r['started'])} |")
    out.append(f"| Worker first-pass MERGE | {rate_text(wk, wn)} |")
    ck, cn = critic_rate(rows, bool(escaped_from))
    out.append(f"| Critic miss rate | {rate_text(ck, cn)}{'' if escaped_from else '; escaped defects not counted, pass --escaped-from'} |")
    out.append(f"| Reverts after MERGE | {reverts} |")
    if escaped_from:
        out.append(f"| Fix commits | {fix_commit_count(rows)} |")
        out.append(f"| Escaped defects | {sum(r['escaped'] for r in rows)} |")
    else:
        out.append("| Fix commits | not counted |")
        out.append("| Escaped defects | not counted |")
    out.append(f"| Tokens | {total_tokens:,} |")
    out.append(f"| Tokens per task | {(round(total_tokens / wn) if wn else 0):,} |")
    out.append("")
    out.append("## Fix items by cause")
    out.append("")
    if causes:
        out.append("| Cause | Items |")
        out.append("| --- | --- |")
        for cause, count in sorted(causes.items()):
            out.append(f"| {cell(cause)} | {count} |")
    else:
        out.append("None.")
    out.append("")
    out.extend(checklist_section(rows))
    out.append("## Decision rule")
    out.append("")
    out.extend(decision_rule(rows, bool(escaped_from), has_listed_finding(rows, findings)))
    print("\n".join(out))


def parse_escaped(value):
    if value is None or not re.fullmatch(r"\d+", value):
        sys.exit("--escaped needs a whole number (fix commits after the wave that trace to a merged task)")
    return int(value)


def parse_args(argv):
    out_path = None
    escaped = None
    escaped_from = None
    rest = []
    it = iter(argv)
    for a in it:
        if a in ("--timings", "--pool"):
            continue
        if a == "--escaped":
            escaped = parse_escaped(next(it, None))
        elif a.startswith("--escaped="):
            escaped = parse_escaped(a[len("--escaped="):])
        elif a == "--escaped-from":
            escaped_from = next(it, None)
            if not escaped_from:
                sys.exit("--escaped-from needs a path")
        elif a.startswith("--escaped-from="):
            escaped_from = a[len("--escaped-from="):]
        elif a == "--out":
            out_path = next(it, None)
            if not out_path:
                sys.exit("--out needs a path")
        elif a.startswith("--out="):
            out_path = a[len("--out="):]
        else:
            rest.append(a)
    if escaped is not None and escaped_from is not None:
        sys.exit("--escaped and --escaped-from cannot be used together: --escaped gives one count, --escaped-from one per task")
    return rest, out_path, escaped, escaped_from


if __name__ == "__main__":
    args, out_path, escaped, escaped_from = parse_args(sys.argv[1:])
    if "--pool" in sys.argv[1:]:
        if not args or escaped is not None:
            sys.exit(__doc__)
        pool_report(args, escaped_from)
        sys.exit(0)
    if "--timings" in sys.argv[1:]:
        if not args:
            sys.exit(__doc__)
        timings_report(args)
        sys.exit(0)
    if len(args) < 3:
        sys.exit(__doc__)
    main(args[0], args[1], args[2:], out_path, escaped, escaped_from)
