#!/usr/bin/env python3
"""Planted controls: seed subtle errors before a review, then score the catch.

  plant.py plant <in.md> --out <out.md> [--private run-private/planted.json]
                [--n 3] [--seed 1] [--ledger run/ledger/sources.json]
                [--kinds number,excerpt]
  plant.py score <findings.md> [--private run-private/planted.json] [--tolerance 1]

Kinds:
  number   a number in prose moves by a plausible amount (10-25%, or 1-2 for
           small integers); ids, dates, times, versions, URLs and [S#]/[K#]/Q#
           tags are never touched.
  excerpt  a quoted excerpt tied to a ledger id is swapped for the neighbouring
           sentence of the same cached page: a real quote from the real source
           that no longer supports the line. Needs --ledger.

Each plant changes one line in place and keeps the line count, so reviewer
line numbers still map onto the original. The answer key goes to --private,
which belongs in run-private/ (never shown to agents). score matches findings
(gate.py format) to plants by line number or by the planted/original value,
lists which findings were plant hits (disposition them PLANT in the review
log), and appends the result to the key file.

Exit codes: 0 ok, 1 nothing could be planted, 2 usage error.
"""

import argparse
import datetime
import json
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swarmlib  # noqa: E402

PROTECT_RE = re.compile(
    r"https?://\S+"                      # URLs
    r"|`[^`]*`"                          # inline code
    r"|\[[^\]]*\]"                       # [S12] [K3] [FACT] link labels
    r"|\b\d{4}-\d{2}-\d{2}(?:T[\d:]+Z?)?"  # dates
    r"|\b\d{1,2}:\d{2}\b"                # times
    r"|\bv?\d+(?:\.\d+){2,}\b"           # versions
    r"|\b[A-Za-z]+\d+\b"                 # Q07, S12, gpt5 style ids
    r"|#\d+"                             # issue numbers
    r"|\b\d+(?:\.\d+)?[A-Za-z]{2,}\b"    # 32GB, 5min: units glued on are often names
    r"|:\d+(?:-\d+)?\b"                  # file:line refs
)
NUM_RE = re.compile(r"(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![\w])")
BOARD_QUOTE_RE = re.compile(r'^(quote:\s*")(.+)("\s*)$')
INLINE_QUOTE_RE = re.compile(r'"([^"]{20,})"')


def _protected(line):
    spans = [m.span() for m in PROTECT_RE.finditer(line)]
    return lambda a, b: any(a < e and b > s for s, e in spans)


def _is_year(tok):
    return re.match(r"^(19|20)\d\d$", tok) is not None


def number_candidates(lines):
    out = []
    for i, line in enumerate(lines):
        if line.startswith("### [") or line.lstrip().startswith(("source:", "```")):
            continue
        prot = _protected(line)
        for m in NUM_RE.finditer(line):
            tok = m.group(1)
            if prot(*m.span()) or _is_year(tok):
                continue
            out.append((i, m.span(1), tok))
    return out


def alter_number(tok, rng, pct=False):
    raw = tok.replace(",", "")
    decimals = len(raw.split(".")[1]) if "." in raw else 0
    v = float(raw)
    if decimals == 0 and v <= 12:
        delta = rng.choice([1, 2])
        new = v + delta if v < 2 or rng.random() < 0.5 else v - delta
        if new < 0:
            new = v + delta
    else:
        f = rng.choice([0.75, 0.8, 0.85, 1.15, 1.2, 1.25])
        new = v * f
        if pct and new > 100:
            new = v * (2 - f)
    if decimals:
        s = "%.*f" % (decimals, new)
    else:
        s = str(int(round(new)))
        if s == str(int(v)):
            s = str(int(v) + 1)
        if "," in tok:
            s = "{:,}".format(int(s))
    return s


def _sentences(text):
    flat = re.sub(r"\s+", " ", text).strip()
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", flat) if s.strip()]


def neighbour_sentence(page, quote, rng):
    sents = _sentences(page)
    key = swarmlib.normalise(quote)[:60]
    for i, s in enumerate(sents):
        if key and key in swarmlib.normalise(s):
            options = [j for j in (i - 1, i + 1) if 0 <= j < len(sents)
                       and len(sents[j].split()) >= 6 and key not in swarmlib.normalise(sents[j])]
            if options:
                return sents[rng.choice(options)].replace('"', "'")
            return None
    return None


def excerpt_candidates(lines, ledger_path):
    if not ledger_path:
        return []
    import ledger as ledger_mod
    led = ledger_mod.Ledger(ledger_path)
    known = led.by_id()
    out = []
    entry_cites = []
    text = "\n".join(lines)
    for e in swarmlib.parse_board(text):
        entry_cites.append((e.line, e.line + e.body.count("\n"), e.cites))
    for i, line in enumerate(lines):
        m = BOARD_QUOTE_RE.match(line)
        if m:
            cites = [c for (a, b, cs) in entry_cites if a <= i + 1 <= b for c in cs]
            span, quote = m.span(2), m.group(2)
        else:
            m = INLINE_QUOTE_RE.search(line)
            cites = swarmlib.CITE_RE.findall(line)
            if not m or not cites:
                continue
            span, quote = m.span(1), m.group(1)
        for c in cites:
            if c in known and known[c]["status"] == "VERIFIED":
                page = led.page_text(c)
                if page:
                    out.append((i, span, quote, c, page))
                    break
    return out


def plant(text, n, rng, kinds, ledger_path=None):
    lines = text.split("\n")
    pool = []
    if "number" in kinds:
        pool += [("number",) + c for c in number_candidates(lines)]
    if "excerpt" in kinds:
        pool += [("excerpt",) + c for c in excerpt_candidates(lines, ledger_path)]
    rng.shuffle(pool)
    used, plants = set(), []
    # Alternate kinds while both remain, so a key is not all numbers.
    by_kind = {k: [c for c in pool if c[0] == k] for k in kinds}
    order = []
    while any(by_kind.values()):
        for k in kinds:
            if by_kind.get(k):
                order.append(by_kind[k].pop(0))
    for c in order:
        if len(plants) >= n:
            break
        kind, i, (a, b) = c[0], c[1], c[2]
        if any(abs(i - u) <= 2 for u in used):
            continue  # keep plants apart so line-based scoring stays unambiguous
        orig_line = lines[i]
        if kind == "number":
            tok = c[3]
            pct = orig_line[b:b + 1] == "%"
            new = alter_number(tok, rng, pct)
            source = None
        else:
            new = neighbour_sentence(c[5], c[3], rng)
            source = c[4]
            if not new:
                continue
            tok = c[3]
        lines[i] = orig_line[:a] + new + orig_line[b:]
        used.add(i)
        plants.append({
            "id": "P%d" % (len(plants) + 1), "kind": kind, "line": i + 1,
            "original": tok, "planted": new, "source": source,
            "original_line": orig_line, "planted_line": lines[i],
        })
    return "\n".join(lines), plants


def _names(f, p):
    """True if finding f names plant p's planted or original value."""
    blob = swarmlib.normalise(f["text"] + " " + f.get("evidence", ""))
    pv, ov = swarmlib.normalise(p["planted"]), swarmlib.normalise(p["original"])
    if p["kind"] == "number":
        return re.search(r"(?<![\w.])%s(?![\w])" % re.escape(pv), blob) is not None
    return (len(ov) >= 20 and ov[:40] in blob) or (len(pv) >= 20 and pv[:40] in blob)


def score(findings, plants, tolerance=1):
    """A finding catches the plants whose value it names; failing that, the one
    nearest plant within `tolerance` lines. One finding never credits two plants
    by line alone."""
    caught = {p["id"]: [] for p in plants}
    hits = set()
    for f in findings:
        named = [p for p in plants if _names(f, p)]
        if not named and f.get("line") is not None:
            near = [p for p in plants if abs(f["line"] - p["line"]) <= tolerance]
            near.sort(key=lambda p: (abs(f["line"] - p["line"]), p["line"]))
            named = near[:1]
        for p in named:
            caught[p["id"]].append(f["n"])
            hits.add(f["n"])
    results = [{"id": p["id"], "kind": p["kind"], "line": p["line"], "caught_by": caught[p["id"]]}
               for p in plants]
    return results, sorted(hits)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("plant")
    p.add_argument("input")
    p.add_argument("--out", required=True)
    p.add_argument("--private", default=os.path.join("run-private", "planted.json"))
    p.add_argument("--n", type=int, default=3)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--ledger", default=None)
    p.add_argument("--kinds", default="number,excerpt")
    s = sub.add_parser("score")
    s.add_argument("findings")
    s.add_argument("--private", default=os.path.join("run-private", "planted.json"))
    s.add_argument("--tolerance", type=int, default=1)
    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help()
        return 2

    if args.cmd == "plant":
        kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
        if any(k not in ("number", "excerpt") for k in kinds):
            print("plant: unknown kind in %s" % args.kinds, file=sys.stderr)
            return 2
        if "run-private" not in os.path.abspath(args.private).split(os.sep):
            print("warning: answer key %s is not under run-private/" % args.private, file=sys.stderr)
        with open(args.input, encoding="utf-8") as f:
            text = f.read()
        rng = random.Random(args.seed)
        out, plants = plant(text, args.n, rng, kinds, args.ledger)
        if not plants:
            print("plant: no candidate lines found", file=sys.stderr)
            return 1
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out)
        key = {"input": args.input, "output": args.out, "seed": args.seed,
               "created": datetime.datetime.now(datetime.timezone.utc).isoformat(), "plants": plants, "scores": []}
        d = os.path.dirname(os.path.abspath(args.private))
        os.makedirs(d, exist_ok=True)
        with open(args.private, "w", encoding="utf-8") as f:
            json.dump(key, f, indent=2, ensure_ascii=False)
        print("planted %d (%s) into %s; key in %s" % (
            len(plants), ", ".join("%s:%s" % (p["kind"], p["line"]) for p in plants), args.out, args.private))
        return 0

    with open(args.private, encoding="utf-8") as f:
        key = json.load(f)
    with open(args.findings, encoding="utf-8") as f:
        findings = swarmlib.parse_findings(f.read())
    results, hits = score(findings, key["plants"], args.tolerance)
    for r in results:
        print("%s %-7s line %-4d %s" % (r["id"], r["kind"], r["line"],
                                        ("CAUGHT by F" + ",F".join(map(str, r["caught_by"]))) if r["caught_by"] else "MISSED"))
    caught = sum(1 for r in results if r["caught_by"])
    total = len(results)
    print("plant hits (disposition PLANT): %s" % (", ".join("F%d" % h for h in hits) or "none"))
    print("caught %d/%d (%d%%)" % (caught, total, round(100.0 * caught / total) if total else 0))
    key.setdefault("scores", []).append({
        "findings": args.findings, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "caught": caught, "total": total, "results": results})
    with open(args.private, "w", encoding="utf-8") as f:
        json.dump(key, f, indent=2, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
