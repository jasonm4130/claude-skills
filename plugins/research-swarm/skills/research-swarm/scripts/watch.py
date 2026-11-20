#!/usr/bin/env python3
"""Board watchdog: who has gone quiet, and which TAKEs were never delivered.

  watch.py <board.md> <run/swarm.json | roster.txt> [--idle 10] [--undelivered 20] [--now HH:MM]

Roster: the "roster" list in run/swarm.json (run.py roster adds to it), or a
text file with one '<agent-id> [HH:MM start]' per line ('#' comments ignored). An agent is idle when its last board entry (or its start
time, if it has none) is more than --idle minutes old. A TAKE is undelivered
when the first TAKE of a question has no FACT, MEASURE or FAIL for that
question from the same agent after --undelivered minutes. Only the first TAKE
of a question counts (first TAKE wins).

Board times are HH:MM without a date; a time later than --now is read as the
previous day, so a run may cross midnight but must stay under 24 hours.

Exit codes: 0 nothing flagged, 1 something flagged, 2 usage error.
"""

import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swarmconfig  # noqa: E402
import swarmlib  # noqa: E402


def age(now_min, then_min):
    return (now_min - then_min) % (24 * 60)


def read_roster(text):
    roster = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        start = parts[1] if len(parts) > 1 and swarmlib.TIME_RE.match(parts[1]) else None
        roster.append((parts[0], start))
    return roster


def scan(board_text, roster, now, idle, undelivered):
    """Return (idle_list, undelivered_list) of human-readable lines."""
    now_min = swarmlib.to_minutes(now)
    entries = [e for e in swarmlib.parse_board(board_text) if e.time]
    last = {}
    for e in entries:
        m = e.minutes()
        if e.agent not in last or age(now_min, m) < age(now_min, last[e.agent]):
            last[e.agent] = m
    idle_out = []
    for agent, start in roster:
        if agent in last:
            a = age(now_min, last[agent])
            if a > idle:
                idle_out.append("IDLE %s: last entry %d min ago" % (agent, a))
        elif start is not None:
            a = age(now_min, swarmlib.to_minutes(start))
            if a > idle:
                idle_out.append("IDLE %s: no entry, started %d min ago" % (agent, a))
        else:
            idle_out.append("IDLE %s: no entry and no start time in roster" % agent)

    first_take = {}
    for e in entries:
        if e.type == "TAKE" and e.qid and e.qid not in first_take:
            first_take[e.qid] = e
    undel_out = []
    for qid, take in sorted(first_take.items(), key=lambda kv: kv[1].line):
        delivered = any(
            e.type in swarmlib.DELIVERS and e.qid == qid and e.agent == take.agent and e.line > take.line
            for e in entries
        )
        a = age(now_min, take.minutes())
        if not delivered and a > undelivered:
            undel_out.append("UNDELIVERED %s: taken by %s %d min ago, no FACT/MEASURE/FAIL" % (qid, take.agent, a))
    return idle_out, undel_out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("board")
    ap.add_argument("roster")
    ap.add_argument("--idle", type=int, default=10, help="minutes without an entry (default 10)")
    ap.add_argument("--undelivered", type=int, default=20, help="minutes a TAKE may stay open (default 20)")
    ap.add_argument("--now", default=None, help="HH:MM (default: local time now)")
    args = ap.parse_args(argv)
    now = args.now or datetime.datetime.now().strftime("%H:%M")
    try:
        swarmlib.to_minutes(now)
        with open(args.board, encoding="utf-8") as f:
            board = f.read()
        with open(args.roster, encoding="utf-8") as f:
            text = f.read()
        roster = swarmconfig.roster_from(json.loads(text)) if args.roster.endswith(".json") else read_roster(text)
    except (OSError, ValueError, KeyError) as e:
        print("watch: %s" % e, file=sys.stderr)
        return 2
    idle_out, undel_out = scan(board, roster, now, args.idle, args.undelivered)
    for line in idle_out + undel_out:
        print(line)
    print("watch %s: %d agents, %d idle, %d undelivered TAKEs" % (now, len(roster), len(idle_out), len(undel_out)))
    return 1 if idle_out or undel_out else 0


if __name__ == "__main__":
    sys.exit(main())
