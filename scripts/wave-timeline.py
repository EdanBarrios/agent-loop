#!/usr/bin/env python3
"""Draw one wave-loop run as an SVG timeline: one row per task, one bar per agent.

    python3 -I scripts/wave-timeline.py <run output.json> [--title TEXT] [--titles] > timeline.svg

The input is the Workflow run output the scorecard reads: an object with `result` (the wave-loop result, as an
object or a JSON string) and `workflowProgress` (the agent records, each with `label`, `startedAt` and
`durationMs`). Labels name the role and the task: `worker:3.8`, `worker:3.8 fix1`, `critic:3.8 r1`,
`ci:3.8 r1 c2`, `merger:3.8`. Workers, critics and merges are drawn as full bars; CI waits, which run beside the
critic, as a thin band under them. Tasks with no agent (a dependency was parked) get an empty row. A stretch of
10 minutes or more with no agent running is shaded, and labelled a usage-limit pause when the agents after it are
marked "(after usage limit)".

`--titles` adds each task's title from the result after its id. The SVG follows the viewer's light or dark theme.
"""

import json
import sys
from html import escape

ROLES = {"worker": "Worker", "critic": "Critic", "merger": "Merge", "ci": "CI wait"}
ROW_H, BAR_H, CI_H = 20, 12, 4
LEFT, RIGHT, TOP = 210, 70, 64
PAD = 20

CSS = """
.bg{fill:#ffffff}
.t{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:#1f2328}
.id{font-size:12px;font-weight:600}.ttl{font-size:12px;fill:#59636e}.ax{font-size:11px;fill:#59636e}
.hd{font-size:14px;font-weight:600}.lg{font-size:12px}.st{font-size:11px;font-weight:600}
.grid{stroke:#d0d7de;stroke-width:1}.band{fill:#f6f8fa}.gap{fill:#8c959f;fill-opacity:.14}
.worker{fill:#0969da}.critic{fill:#8250df}.merger{fill:#1a7f37}.ci{fill:#8c959f}
.ok{fill:#1a7f37}.park{fill:#bc4c00}.none{fill:#59636e;font-style:italic}
@media (prefers-color-scheme:dark){
.bg{fill:#0d1117}.t{fill:#f0f6fc}.ttl,.ax{fill:#9198a1}.grid{stroke:#3d444d}.band{fill:#151b23}
.worker{fill:#4493f8}.critic{fill:#ab7df8}.merger{fill:#3fb950}.ci{fill:#656c76}
.ok{fill:#3fb950}.park{fill:#f0883e}.none{fill:#9198a1}}
"""


def load(path):
    with open(path) as f:
        doc = json.load(f)
    result = doc.get("result", {})
    if isinstance(result, str):
        result = json.loads(result)
    agents = [a for a in doc.get("workflowProgress", []) if a.get("label") and a.get("startedAt")]
    return result or {}, agents


def parse(label):
    role, _, rest = label.partition(":")
    task = rest.split(" ")[0] if rest else ""
    return role, task


def task_key(tid):
    parts = []
    for p in tid.split("."):
        parts.append((0, int(p), "") if p.isdigit() else (1, 0, p))
    return parts


def gaps(agents, minutes):
    """Stretches of at least 10 minutes (and 5% of the run) with no agent running, as (start, end, label)."""
    spans = sorted((a["startedAt"], a["startedAt"] + a.get("durationMs", 0), a["label"]) for a in agents)
    out, reach = [], spans[0][1]
    for s, e, label in spans[1:]:
        idle = (s - reach) / 60000
        if idle >= 10 and idle >= 0.05 * minutes:
            why = "paused: usage limit" if "usage limit" in label else "no agent running"
            out.append((reach, s, why))
        reach = max(reach, e)
    return out


def build(result, agents, titles=False, title=None):
    bars = {}
    for a in agents:
        role, task = parse(a["label"])
        if role in ROLES and task:
            bars.setdefault(task, []).append((role, a["startedAt"], a["startedAt"] + a.get("durationMs", 0)))
    if not agents:
        raise SystemExit("wave-timeline: no agent records with startedAt in the input")
    t0 = min(a["startedAt"] for a in agents)
    t1 = max(a["startedAt"] + a.get("durationMs", 0) for a in agents)
    minutes = max((t1 - t0) / 60000, 1)

    tasks = result.get("tasks", {})
    state = result.get("state", {})
    ids = set(bars) | set(tasks) | set(state)
    started = sorted((i for i in ids if i in bars), key=lambda i: (min(b[1] for b in bars[i]), task_key(i)))
    idle = sorted((i for i in ids if i not in bars), key=task_key)
    order = started + idle

    width = 990
    plot = width - LEFT - RIGHT
    step = next(s for s in (5, 10, 15, 30, 60, 120, 240) if minutes / s <= 9)
    height = TOP + ROW_H * len(order) + 46
    x = lambda ms: LEFT + (ms - t0) / 60000 / minutes * plot

    o = []
    head = title or f"Wave {result.get('wave', '?')}: {len(order)} tasks, {minutes:.0f} minutes"
    o.append(f'<text class="t hd" x="0" y="20">{escape(head)}</text>')
    lx = 0
    for cls, name in (("worker", "Worker"), ("critic", "Critic"), ("ci", "CI wait"), ("merger", "Merge")):
        h = CI_H if cls == "ci" else BAR_H
        o.append(f'<rect class="{cls}" x="{lx}" y="{40 - h / 2 - 4}" width="14" height="{h}" rx="2"/>')
        o.append(f'<text class="t lg" x="{lx + 20}" y="40">{name}</text>')
        lx += 30 + len(name) * 7.5
    for m in range(0, int(minutes) + 1, step):
        gx = LEFT + m / minutes * plot
        o.append(f'<line class="grid" x1="{gx:.1f}" y1="{TOP - 6}" x2="{gx:.1f}" y2="{height - 34}"/>')
        o.append(f'<text class="t ax" x="{gx:.1f}" y="{height - 18}" text-anchor="middle">{m} min</text>')

    for n, tid in enumerate(order):
        if n % 2 == 0:
            o.append(f'<rect class="band" x="0" y="{TOP + n * ROW_H}" width="{width}" height="{ROW_H}"/>')
    for s, e, why in gaps(agents, minutes):
        gx, gw = x(s), x(e) - x(s)
        o.append(f'<rect class="gap" x="{gx:.1f}" y="{TOP - 6}" width="{gw:.1f}" height="{ROW_H * len(order) + 6}"/>')
        o.append(f'<text class="t ax" x="{gx + gw / 2:.1f}" y="{TOP - 12}" text-anchor="middle">{why}</text>')

    for n, tid in enumerate(order):
        y = TOP + n * ROW_H
        label = escape(tid)
        o.append(f'<text class="t id" x="6" y="{y + 14}">{label}</text>')
        if titles:
            name = (tasks.get(tid) or {}).get("title", "")
            if len(name) > 26:
                name = name[:25].rstrip() + "…"
            o.append(f'<text class="t ttl" x="46" y="{y + 14}">{escape(name)}</text>')
        rows = bars.get(tid, [])
        for role, s, e in sorted(rows, key=lambda b: b[0] == "ci"):
            w = max(x(e) - x(s), 1.5)
            if role == "ci":
                o.append(f'<rect class="ci" x="{x(s):.1f}" y="{y + ROW_H - CI_H - 1}" width="{w:.1f}" height="{CI_H}"/>')
            else:
                o.append(f'<rect class="{role}" x="{x(s):.1f}" y="{y + 3}" width="{w:.1f}" height="{BAR_H}" rx="2"><title>{ROLES[role]} {label}</title></rect>')
        st = state.get(tid, "")
        end = x(max(b[2] for b in rows)) + 6 if rows else LEFT + 6
        if not rows:
            o.append(f'<text class="t ttl none" x="{end:.1f}" y="{y + 14}">not started{": " + escape(st) if st else ""}</text>')
        elif st == "merged":
            o.append(f'<text class="t st ok" x="{end:.1f}" y="{y + 14}">merged</text>')
        elif st:
            o.append(f'<text class="t st park" x="{end:.1f}" y="{y + 14}">{escape(st)}</text>')

    desc = escape(f"{head}. One row per task; bars show worker, critic, CI-wait and merge agents over time.")
    # A solid background, so the chart reads the same on any page or viewer (GitHub's file view shows a checkerboard).
    outer_w, outer_h = width + 2 * PAD, height + 2 * PAD
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {outer_w} {outer_h}" width="{outer_w}" height="{outer_h}" role="img" aria-label="{desc}">\n'
        f"<title>{escape(head)}</title>\n<style>{CSS}</style>\n"
        f'<rect class="bg" width="{outer_w}" height="{outer_h}" rx="8"/>\n<g transform="translate({PAD},{PAD})">\n'
        + "\n".join(o) + "\n</g>\n</svg>\n"
    )


def main(argv):
    args, title, titles = [], None, False
    i = 0
    while i < len(argv):
        if argv[i] == "--title":
            title = argv[i + 1]
            i += 2
            continue
        if argv[i] == "--titles":
            titles = True
        else:
            args.append(argv[i])
        i += 1
    if len(args) != 1:
        raise SystemExit(__doc__.strip().splitlines()[2].strip())
    result, agents = load(args[0])
    sys.stdout.write(build(result, agents, titles=titles, title=title))


if __name__ == "__main__":
    main(sys.argv[1:])
