#!/usr/bin/env python3
"""Critic labelling sheet: a human labels a sample of critic verdicts, and the labels give the critic's precision.

  python3 -I scripts/label-sheet.py <result.json>... [--sample <n>] [--seed <s>]
  python3 -I scripts/label-sheet.py --read <filled sheet>

The first form prints a Markdown sheet, one row per fix item of a FIX verdict and one row per MERGE verdict, for every
round whose critic ran (no row for a STOP verdict, a `lane: 'fast'` round or a `criticSkipped` round). Each row is keyed
by task, round and item (the fix item's `n`, or `merge`) and carries the verdict, the fix item text and the PR link. The
human writes y or n in `real? (y/n)` on a fix-item row (is the item a real defect?) and in `correct? (y/n)` on a MERGE
row (was merging right?). `--sample <n>` draws n verdicts, FIX and MERGE in their observed proportion, reproducibly by
`--seed` (default 0); a drawn FIX verdict brings all its rows. A result file is the Workflow output file or the bare
result object.

The second form reads a filled sheet and prints the share of FIX items labelled real and of MERGEs labelled correct,
each as `72% (55–84%, n=30)` with a 95% Wilson score interval, and the rows left unlabelled. Only y/yes and n/no count
as labels; anything else, including an empty cell, is unlabelled and is never guessed. Reads files only.
"""
import argparse
import json
import math
import random
import sys

REAL_COL = "real? (y/n)"
CORRECT_COL = "correct? (y/n)"
HEADER = ["task", "round", "item", "verdict", "what", "PR", REAL_COL, CORRECT_COL]
Z = 1.96
YES = ("y", "yes")
NO = ("n", "no")


def load_result(path):
    with open(path) as f:
        doc = json.load(f)
    result = doc.get("result", doc) if isinstance(doc, dict) else doc
    if isinstance(result, str):
        result = json.loads(result)
    if not isinstance(result, dict):
        raise ValueError("not a wave result")
    return result


def cell(text):
    """One table cell: a single line, with pipes escaped."""
    return " ".join(str(text if text is not None else "").split()).replace("|", "\\|")


def split_row(line):
    """Cells of a Markdown table line; a pipe escaped as \\| stays in its cell."""
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    cells, cur, i = [], [], 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body) and body[i + 1] == "|":
            cur.append("|")
            i += 2
            continue
        if ch == "|":
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    cells.append("".join(cur).strip())
    return cells


def collect(paths):
    """Verdict units of the given results: { verdict, rows: [row] } per FIX or MERGE round whose critic ran."""
    units = []
    seen = set()
    for index, path in enumerate(paths, 1):
        result = load_result(path)
        for tid, t in (result.get("tasks") or {}).items():
            url = (t.get("pr") or {}).get("url") or "-"
            for rd in t.get("rounds") or []:
                if rd.get("lane") == "fast" or rd.get("criticSkipped"):
                    continue
                verdict = rd.get("verdict")
                if verdict not in ("FIX", "MERGE"):
                    continue
                label = str(tid)
                if (label, rd.get("round")) in seen:
                    label = f"{tid}@{index}"
                seen.add((str(tid), rd.get("round")))
                base = {"task": label, "round": str(rd.get("round")), "verdict": verdict, "pr": url}
                if verdict == "MERGE":
                    rows = [dict(base, item="merge", what="-")]
                else:
                    rows = [dict(base, item=str(fi.get("n", i + 1)), what=fi.get("what", "")) for i, fi in enumerate(rd.get("fixItems") or [])]
                if rows:
                    units.append({"verdict": verdict, "rows": rows})
    return units


def draw(units, n, seed):
    """n verdicts, FIX and MERGE in their observed proportion, reproducible by seed; original order is kept."""
    if n >= len(units):
        return units
    fixes = [i for i, u in enumerate(units) if u["verdict"] == "FIX"]
    merges = [i for i, u in enumerate(units) if u["verdict"] == "MERGE"]
    want_fix = int(n * len(fixes) / len(units) + 0.5)
    want_fix = min(want_fix, len(fixes), n)
    want_merge = n - want_fix
    if want_merge > len(merges):
        want_merge = len(merges)
        want_fix = n - want_merge
    rng = random.Random(seed)
    picked = set(rng.sample(fixes, want_fix)) | set(rng.sample(merges, want_merge))
    return [u for i, u in enumerate(units) if i in picked]


def render(units):
    out = ["# Critic labelling sheet", ""]
    out.append(f"Write y or n in `{REAL_COL}` on a FIX row (is the fix item a real defect?) and in `{CORRECT_COL}` on a MERGE row (was merging right?). Leave a row empty when unsure; it is counted as unlabelled.")
    out.append("")
    out.append("| " + " | ".join(HEADER) + " |")
    out.append("|" + "|".join("---" for _ in HEADER) + "|")
    for u in units:
        for r in u["rows"]:
            fix = r["verdict"] == "FIX"
            vals = [r["task"], r["round"], r["item"], r["verdict"], r["what"], r["pr"], "" if fix else "n/a", "n/a" if fix else ""]
            out.append("| " + " | ".join(cell(v) for v in vals) + " |")
    return "\n".join(out) + "\n"


def wilson(k, n):
    """95% Wilson score interval of k of n, clamped to [0, 1]; a lower bound under 1e-9 is 0."""
    p = k / n
    denom = 1 + Z * Z / n
    center = (p + Z * Z / (2 * n)) / denom
    half = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / denom
    lo = max(0.0, center - half)
    hi = min(1.0, center + half)
    return (0.0 if lo < 1e-9 else lo), hi


def fmt(k, n):
    if n == 0:
        return "n/a (n=0)"
    lo, hi = wilson(k, n)
    return f"{k / n * 100:.0f}% ({lo * 100:.0f}–{hi * 100:.0f}%, n={n})"


def read_sheet(path):
    with open(path) as f:
        lines = [l for l in f.read().splitlines() if l.strip().startswith("|")]
    header = None
    counts = {"FIX": [0, 0, 0], "MERGE": [0, 0, 0]}  # yes, labelled, unlabelled
    for line in lines:
        c = split_row(line)
        if header is None:
            if "verdict" in c and (REAL_COL in c or CORRECT_COL in c):
                header = {name: i for i, name in enumerate(c)}
            continue
        if all(set(x) <= set("-: ") for x in c):
            continue
        verdict = c[header["verdict"]] if header["verdict"] < len(c) else ""
        if verdict not in counts:
            continue
        col = header.get(REAL_COL if verdict == "FIX" else CORRECT_COL)
        raw = c[col].strip().lower() if col is not None and col < len(c) else ""
        tally = counts[verdict]
        if raw in YES:
            tally[0] += 1
            tally[1] += 1
        elif raw in NO:
            tally[1] += 1
        else:
            tally[2] += 1
    if header is None:
        raise ValueError("no labelling table found in the sheet")
    fix, merge = counts["FIX"], counts["MERGE"]
    print(f"FIX items real: {fmt(fix[0], fix[1])}")
    print(f"MERGEs correct: {fmt(merge[0], merge[1])}")
    print(f"Unlabelled: {fix[2] + merge[2]} (FIX items {fix[2]}, MERGEs {merge[2]})")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Critic labelling sheet")
    ap.add_argument("results", nargs="*", help="result.json files of waves")
    ap.add_argument("--sample", type=int, help="draw this many verdicts")
    ap.add_argument("--seed", default="0", help="seed of the draw (default 0)")
    ap.add_argument("--read", metavar="SHEET", help="print precision from a filled sheet")
    args = ap.parse_args(argv)
    try:
        if args.read:
            if args.results or args.sample is not None:
                ap.error("--read takes only the filled sheet")
            read_sheet(args.read)
            return 0
        if not args.results:
            ap.error("give at least one result file, or --read <filled sheet>")
        if args.sample is not None and args.sample < 0:
            ap.error("--sample must not be negative")
        units = collect(args.results)
        if args.sample is not None:
            units = draw(units, args.sample, args.seed)
        sys.stdout.write(render(units))
        return 0
    except (OSError, ValueError) as e:
        print(f"label-sheet: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
