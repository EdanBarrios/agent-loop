#!/usr/bin/env python3
"""Write a per-wave scorecard for the agent loop (Appendix C) from a Workflow output file.

Usage: python3 -I scripts/loop-scorecard.py <wave> <date> <workflow-output.json>... > docs/<project>/<date>-wave-<wave>-loop.md

Several output files (a wave relaunched after escalations) are merged in order: agents accumulate, a task's
later record replaces its earlier one, and escalations from every run are listed.

The output file is the JSON the Workflow tool writes when a wave-loop run completes. It holds the
script's return value (gate, tasks, escalations) and one entry per agent with model, tokens and
duration. The scorecard records, per role, the signals used to decide whether a role's model or
effort should move up or down a notch:

- worker:  first-pass MERGE rate; fix items by cause (defect, spec_miss, loop)
- critic:  misses (main red after a MERGE, i.e. a revert), STOP verdicts, escalations
- merger:  failed or reverted merges
- all:     tokens and minutes per role
"""

import json
import sys
from collections import defaultdict


def walk(o, out):
    if isinstance(o, dict):
        if o.get("type") == "workflow_agent":
            out.append(o)
        for v in o.values():
            walk(v, out)
    elif isinstance(o, list):
        for v in o:
            walk(v, out)


def role_of(label):
    return label.split(":")[0]


def load(path):
    with open(path) as f:
        doc = json.load(f)
    result = doc.get("result", doc)
    if isinstance(result, str):
        result = json.loads(result)
    agents = []
    walk(doc, agents)
    return result, agents


def main(wave, date, paths):
    result = {"gate": "?", "tasks": {}, "escalations": []}
    agents = []
    for path in paths:
        r, a = load(path)
        agents.extend(a)
        result["gate"] = r.get("gate", "?")
        for tid, t in r.get("tasks", {}).items():
            prev = result["tasks"].get(tid)
            if prev and prev.get("rounds"):
                t = dict(t, rounds=prev["rounds"] + t.get("rounds", []))
            result["tasks"][tid] = t
        result["escalations"].extend(r.get("escalations", []))
    runs = len(paths)

    by_role = defaultdict(lambda: {"runs": 0, "tokens": 0, "minutes": 0.0})
    for a in agents:
        r = by_role[role_of(a.get("label", "?"))]
        r["runs"] += 1
        r["tokens"] += a.get("tokens") or 0
        r["minutes"] += (a.get("durationMs") or 0) / 60000
        r.setdefault("models", set()).add(a.get("model") or "?")
    total_tokens = sum(r["tokens"] for r in by_role.values())

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
    out.append(f"Date: {date}. Gate: **{result.get('gate', '?')}** after {runs} run(s). Source: Workflow run output; models per role as recorded there.")
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
            out.append(f"| {tid} | {rd} | {cause} | {what} |")
    else:
        out.append("None.")
    out.append("")
    out.append("## Roles")
    out.append("")
    out.append("| Role | Model | Runs | Tokens | Share | Minutes |")
    out.append("| --- | --- | --- | --- | --- | --- |")
    for role in ("worker", "critic", "merger"):
        r = by_role.get(role)
        if not r:
            continue
        share = (r["tokens"] / total_tokens * 100) if total_tokens else 0
        out.append(f"| {role} | {', '.join(sorted(r.get('models', [])))} | {r['runs']} | {r['tokens']:,} | {share:.0f}% | {r['minutes']:.0f} |")
    out.append("")
    out.append("## Signals")
    out.append("")
    n = len(tasks)
    out.append(f"- Worker first-pass MERGE: {first_pass}/{n}")
    out.append(f"- Fix items: " + ", ".join(f"{k} {v}" for k, v in sorted(cause_counts.items())) if cause_counts else "- Fix items: none")
    out.append(f"- Critic misses (revert after MERGE): {reverts}")
    out.append(f"- Merge failures: {merge_failures}")
    out.append(f"- Escalations: {len(escalations)}" + ("" if not escalations else " (" + "; ".join(f"{e.get('task')}: {e.get('what')}" for e in escalations) + ")"))
    out.append("")
    out.append("## Decision rule")
    out.append("")
    out.append("Two waves in a row trigger a change. Worker: first-pass MERGE under half with defect-cause items, bump up; only spec_miss items, fix the prompt. Critic: zero misses for two waves with only cosmetic findings, bump down. Merger: any failure traced to the model, bump up. Loop-cause items are fixed in the workflow script, not by a model change.")
    print("\n".join(out))


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
