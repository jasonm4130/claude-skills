#!/usr/bin/env python3
"""Parse a cross-family gate reply and keep the review log honest.

  gate.py parse <reply.md> [--log review/log.md] [--reviewer codex]
  gate.py check-log <review/log.md>

A reply must contain exactly one line 'VERDICT: PASS' or 'VERDICT: REJECT' and
numbered findings ('1. path/file.md:12 - what is wrong', then an 'evidence:'
line). With --log, every finding is appended with 'Disposition: TODO'. The lead
replaces each TODO with one of:

  Disposition: ACCEPTED [- what changed]
  Disposition: REJECTED - <reason, required>
  Disposition: PLANT                     (a planted control the reviewer caught)

check-log fails while any finding lacks one; run.py phase calls it, so a phase
cannot advance past an undispositioned finding.

Exit codes: parse 0 PASS, 1 REJECT, 3 unparseable; check-log 0 ok, 1 open
findings; 2 usage error.
"""

import argparse
import datetime
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swarmlib  # noqa: E402

UNPARSEABLE = 3
DISP_RE = re.compile(r"^Disposition:\s*(.*)$")
FINDING_HEAD_RE = re.compile(r"^### (F\d+)\b")


def parse_reply(text):
    """Return (verdict, findings, error). verdict None means unparseable."""
    verdicts = [m.group(1) for m in (swarmlib.VERDICT_RE.match(l) for l in text.splitlines()) if m]
    if len(verdicts) != 1:
        return None, [], "expected exactly one 'VERDICT: PASS|REJECT' line, found %d" % len(verdicts)
    findings = swarmlib.parse_findings(text)
    if verdicts[0] == "REJECT" and not findings:
        return None, [], "REJECT with no numbered findings"
    return verdicts[0], findings, None


def format_log(verdict, findings, reply_path, reviewer):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    out = ["", "## Gate %s · %s · %s · %s" % (stamp, reviewer, verdict, reply_path), ""]
    for f in findings:
        loc = "%s:%s" % (f["file"], f["line"]) if f["file"] else "no location"
        out.append("### F%d · %s" % (f["n"], loc))
        out.append(f["text"])
        out.append("evidence: %s" % (f["evidence"] or "(none given)"))
        out.append("Disposition: TODO")
        out.append("")
    return "\n".join(out)


def open_findings(log_text):
    """Return a list of 'F# (section line N): problem' for undispositioned findings."""
    problems = []
    cur = None
    seen = False
    for i, line in enumerate(log_text.splitlines(), 1):
        m = FINDING_HEAD_RE.match(line)
        if m or line.startswith("## "):
            if cur is not None and not seen:
                problems.append("%s (line %d): no Disposition line" % cur)
            cur = (m.group(1), i) if m else None
            seen = False
            continue
        d = DISP_RE.match(line.strip())
        if d and cur is not None:
            seen = True
            val = d.group(1).strip()
            up = val.upper()
            if up.startswith("ACCEPTED") or up == "PLANT":
                continue
            if up == "TODO" or not up:
                problems.append("%s (line %d): still TODO" % cur)
                continue
            if up.startswith("REJECTED"):
                reason = val[len("REJECTED"):].strip(" -:—–")
                if not reason:
                    problems.append("%s (line %d): REJECTED needs a reason" % cur)
                continue
            problems.append("%s (line %d): disposition '%s' is not ACCEPTED, REJECTED - reason, or PLANT" % (cur[0], cur[1], val))
    if cur is not None and not seen:
        problems.append("%s (line %d): no Disposition line" % cur)
    return problems


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("parse")
    p.add_argument("reply")
    p.add_argument("--log", default=None)
    p.add_argument("--reviewer", default="cross-family")
    c = sub.add_parser("check-log")
    c.add_argument("log")
    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help()
        return 2
    path = args.reply if args.cmd == "parse" else args.log
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print("gate: %s" % e, file=sys.stderr)
        return 2

    if args.cmd == "check-log":
        problems = open_findings(text)
        for pr in problems:
            print("OPEN " + pr)
        print("review log: %d open findings" % len(problems))
        return 1 if problems else 0

    verdict, findings, err = parse_reply(text)
    if verdict is None:
        print("UNPARSEABLE: %s" % err)
        return UNPARSEABLE
    for f in findings:
        print("F%d %s" % (f["n"], f["text"][:160]))
    if args.log and findings:
        os.makedirs(os.path.dirname(os.path.abspath(args.log)), exist_ok=True)
        with open(args.log, "a", encoding="utf-8") as f:
            f.write(format_log(verdict, findings, args.reply, args.reviewer))
    print("VERDICT %s: %d findings%s" % (verdict, len(findings),
                                          ("; logged to %s, disposition each before the next phase" % args.log) if args.log and findings else ""))
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
