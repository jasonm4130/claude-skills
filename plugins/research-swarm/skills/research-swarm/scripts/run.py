#!/usr/bin/env python3
"""Run directory: a local git repo with no remote, tagged at every phase gate.

  run.py init <dir> [--size small|medium|large] [--set key=value ...]
                                     create the run dir, run/swarm.json and the
                                     first commit
  run.py phase <name> [--dir <dir>]  commit everything, tag phase/<name>
  run.py status [--dir <dir>]        list phase tags
  run.py config [--set key=value ...] [--dir <dir>]
                                     show or change run/swarm.json
  run.py size [--claims N] [--grok] [--dir <dir>]
                                     agent counts the config implies
  run.py roster <agent-id> [--start HH:MM] [--dir <dir>]
                                     add an agent to the roster watch.py reads
  run.py budget [--start PCT] [--now PCT] [--hours H] [--agents N]
                [--stop-points P] [--ceiling PCT] [--rate R] [--dir <dir>]
                                     max concurrent agents, and when to stop

Sizes (researchers are one per approved angle, bounded by the max):
  small   max 3 researchers, 1 round,  2 designers, Codex gate
  medium  max 6 researchers, 2 rounds, 3 designers, Codex gate
  large   max 12 researchers, 3 rounds, 3 designers, Codex + Grok gates
Verifiers: ceil(load-bearing claims / 10), at least 1.
Keys for --set: researchers_max, researchers, rounds, designers, reviewers,
angles, claims_per_verifier, time_box_min, budget.start_pct,
budget.stop_points, budget.ceiling_pct, budget.points_per_agent_hour.
Values parse as JSON when they can: --set 'reviewers=["codex","grok"]'.

Layout created by init:

  <dir>/run/          shared with agents: BRIEF.md, board.md, swarm.json,
                      state.md, ledger/, kb/, designs/, review/
  <dir>/run-private/  lead only (mode 0700): rubric.md, planted.json, judge
                      notes. Agents are told never to read it.

Both live in the same repo so each phase tag snapshots the sealed material
with the work it judged. The repo must never get a remote: init refuses inside
another git work tree, and every phase refuses if a remote exists.

phase also refuses while run/review/log.md has a finding with no disposition
(see gate.py check-log). Commits and tags use a fixed local identity with
signing off, so a signing agent cannot stall a long run.

Exit codes: 0 ok, 1 refused, 2 usage error.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gate  # noqa: E402
import swarmconfig  # noqa: E402

TEMPLATES = os.path.join(os.path.dirname(HERE), "templates")
GIT_ID = ["-c", "user.name=research-swarm", "-c", "user.email=research-swarm@localhost",
          "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"]
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

SEED = {
    "run/board.md": "# Board (append-only; protocol in BRIEF.md)\n",
    "run/state.md": "# Run state (lead only)\n",
    "run/review/log.md": "# Review log (gate.py parse --log appends; lead dispositions each finding)\n",
    "run/ledger/.keep": "",
    "run/kb/.keep": "",
    "run/designs/.keep": "",
    "run/out/.keep": "",
}
COPY = {
    "BRIEF.md": "run/BRIEF.md",
    "DESIGN-BRIEF.md": "run/DESIGN-BRIEF.md",
    "GATE-PROMPT.md": "run/review/GATE-PROMPT.md",
    "RUBRIC.md": "run-private/rubric.md",
}


class Refused(Exception):
    pass


def git(cwd, *args, check=True):
    r = subprocess.run(["git", "-C", cwd] + list(args), stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, universal_newlines=True)
    if check and r.returncode != 0:
        raise Refused("git %s failed: %s" % (" ".join(args), r.stderr.strip()))
    return r


def inside_work_tree(path):
    probe = path
    while not os.path.isdir(probe):
        probe = os.path.dirname(probe)
    r = git(probe, "rev-parse", "--is-inside-work-tree", check=False)
    return r.returncode == 0 and r.stdout.strip() == "true"


def remotes(root):
    return [l for l in git(root, "remote").stdout.split() if l]


def init(target, size="medium", overrides=None):
    try:
        cfg = swarmconfig.make(size, overrides)
    except swarmconfig.ConfigError as e:
        raise Refused(str(e))
    target = os.path.abspath(target)
    if os.path.exists(target) and os.listdir(target):
        raise Refused("%s exists and is not empty" % target)
    if inside_work_tree(os.path.dirname(target)):
        raise Refused("%s is inside another git work tree; a run dir must be its own repo with no remote" % target)
    os.makedirs(target, exist_ok=True)
    for rel, body in SEED.items():
        p = os.path.join(target, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(body)
    swarmconfig.save(os.path.join(target, "run", "swarm.json"), cfg)
    os.makedirs(os.path.join(target, "run-private"), exist_ok=True)
    for src, rel in COPY.items():
        s = os.path.join(TEMPLATES, src)
        if os.path.exists(s):
            shutil.copyfile(s, os.path.join(target, rel))
    os.chmod(os.path.join(target, "run-private"), 0o700)
    git(target, "init", "-q")
    return phase(target, "init")


def find_root(start):
    d = os.path.abspath(start)
    while True:
        if os.path.isdir(os.path.join(d, "run")) and os.path.isdir(os.path.join(d, "run-private")) \
                and os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise Refused("no run dir (run/ + run-private/ + .git) at or above %s" % start)
        d = parent


def phase(root, name):
    if not NAME_RE.match(name):
        raise Refused("phase name must match %s" % NAME_RE.pattern)
    rs = remotes(root)
    if rs:
        raise Refused("this run repo has a remote (%s); remove it, a run dir is never pushed" % ", ".join(rs))
    tag = "phase/" + name
    if git(root, "rev-parse", "-q", "--verify", "refs/tags/" + tag, check=False).returncode == 0:
        raise Refused("tag %s already exists; pick a new phase name" % tag)
    log = os.path.join(root, "run", "review", "log.md")
    if os.path.exists(log):
        with open(log, encoding="utf-8") as f:
            open_ = gate.open_findings(f.read())
        if open_:
            raise Refused("review log has %d undispositioned findings:\n  %s" % (len(open_), "\n  ".join(open_)))
    os.chmod(os.path.join(root, "run-private"), 0o700)
    state = os.path.join(root, "run", "state.md")
    if os.path.exists(state):
        with open(state, "a", encoding="utf-8") as f:
            f.write("- %s phase %s tagged\n" % (datetime.datetime.now().strftime("%H:%M"), name))
    git(root, "add", "-A", ".")
    git(root, *(GIT_ID + ["commit", "-q", "--allow-empty", "--no-verify", "-m", "phase: " + name]))
    git(root, *(GIT_ID + ["tag", "-a", tag, "-m", "phase " + name]))
    sha = git(root, "rev-parse", "--short", "HEAD").stdout.strip()
    return "%s at %s" % (tag, sha)


def config_path(root):
    return os.path.join(root, "run", "swarm.json")


def describe_size(cfg, claims=None, grok=False):
    parts = ["size %s" % cfg["size"],
             "researchers %d (max %d, %d angles)" % (swarmconfig.researchers(cfg), cfg["researchers_max"], len(cfg["angles"])),
             "rounds %d" % cfg["rounds"], "designers %d" % cfg["designers"]]
    if claims is not None:
        parts.append("verifiers %d for %d claims" % (swarmconfig.verifiers(cfg, claims), claims))
    parts.append("reviewers %s" % "+".join(swarmconfig.reviewers(cfg, grok)))
    return "; ".join(parts)


def describe_budget(b, hours, agents):
    lines = ["stop at %s%% usage; %s points left" % (b["limit_pct"], b["remaining"])]
    if b["stop"]:
        lines.append("STOP: the budget is spent; finish the current phase with what you have")
    if b["max_agents"] is not None:
        lines.append("max concurrent agents for %sh: %d" % (hours, b["max_agents"]))
    if b["hours_left"] is not None:
        lines.append("with %d agents running: stop in %.1fh" % (agents, b["hours_left"]))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    i = sub.add_parser("init")
    i.add_argument("dir")
    i.add_argument("--size", default="medium", choices=sorted(swarmconfig.PRESETS))
    i.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    c = sub.add_parser("config")
    c.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    c.add_argument("--dir", default=".")
    z = sub.add_parser("size")
    z.add_argument("--claims", type=int, default=None)
    z.add_argument("--grok", action="store_true", help="the user asked for a Grok gate too")
    z.add_argument("--dir", default=".")
    r = sub.add_parser("roster")
    r.add_argument("agent")
    r.add_argument("--start", default=None, help="HH:MM (default now)")
    r.add_argument("--dir", default=".")
    b = sub.add_parser("budget")
    for flag, typ in (("--start", float), ("--now", float), ("--hours", float), ("--agents", int),
                      ("--stop-points", float), ("--ceiling", float), ("--rate", float)):
        b.add_argument(flag, type=typ, default=None)
    b.add_argument("--dir", default=None, help="read defaults from this run's swarm.json")
    p = sub.add_parser("phase")
    p.add_argument("name")
    p.add_argument("--dir", default=".")
    s = sub.add_parser("status")
    s.add_argument("--dir", default=".")
    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help()
        return 2
    try:
        if args.cmd == "init":
            msg = init(args.dir, args.size, swarmconfig.parse_sets(args.set))
            cfg = swarmconfig.load(config_path(os.path.abspath(args.dir)))
            print("initialised %s: %s\n%s" % (os.path.abspath(args.dir), msg, describe_size(cfg)))
        elif args.cmd in ("config", "size", "roster"):
            path = config_path(find_root(args.dir))
            cfg = swarmconfig.load(path)
            if args.cmd == "config":
                for k, v in swarmconfig.parse_sets(args.set).items():
                    swarmconfig.set_key(cfg, k, v)
                if args.set:
                    swarmconfig.save(path, cfg)
                print(json.dumps(cfg, indent=2))
            elif args.cmd == "size":
                print(describe_size(cfg, args.claims, args.grok))
            else:
                start = args.start or datetime.datetime.now().strftime("%H:%M")
                if any(x["id"] == args.agent for x in cfg["roster"]):
                    raise Refused("%s is already on the roster" % args.agent)
                cfg["roster"].append({"id": args.agent, "start": start})
                swarmconfig.save(path, cfg)
                print("roster: %d agents (%s added at %s)" % (len(cfg["roster"]), args.agent, start))
        elif args.cmd == "budget":
            bud = dict(swarmconfig.BASE["budget"])
            if args.dir:
                bud.update(swarmconfig.load(config_path(find_root(args.dir)))["budget"])
            for key, val in (("start_pct", args.start), ("stop_points", args.stop_points),
                             ("ceiling_pct", args.ceiling), ("points_per_agent_hour", args.rate)):
                if val is not None:
                    bud[key] = val
            res = swarmconfig.budget(bud["start_pct"], args.now, bud["stop_points"], bud["ceiling_pct"],
                                     bud["points_per_agent_hour"], args.hours, args.agents)
            print(describe_budget(res, args.hours, args.agents))
            return 1 if res["stop"] else 0
        elif args.cmd == "phase":
            print("tagged " + phase(find_root(args.dir), args.name))
        else:
            root = find_root(args.dir)
            tags = git(root, "tag", "--list", "phase/*", "--sort=creatordate").stdout.split()
            print("%s: %s" % (root, " ".join(tags) or "no phases"))
    except Refused as e:
        print("refused: %s" % e, file=sys.stderr)
        return 1
    except (swarmconfig.ConfigError, OSError, ValueError) as e:
        print("run: %s" % e, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
