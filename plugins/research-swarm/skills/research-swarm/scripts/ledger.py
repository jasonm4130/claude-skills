#!/usr/bin/env python3
"""Source ledger: every cited excerpt is fetched and string-matched once, then
cited by id ([S12]) everywhere else. Python 3.9+, stdlib only.

  ledger.py add <url | path[:A-B] | file:///path[#LA-LB]> --excerpt "..."
  ledger.py list
  ledger.py check <board.md>     every FACT/MEASURE/CLAIM cites VERIFIED ids
  ledger.py gate <doc.md>        writer gate: no non-VERIFIED cite, no uncited
                                 numeric line carrying a key-claim tag [K#]

The ledger file defaults to ./ledger/sources.json (or $RS_LEDGER, or --ledger).
Fetched text is kept beside it in pages/<id>.txt for re-checks and plants.

Exit codes: 0 ok, 1 check failed, 2 usage error.
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swarmlib  # noqa: E402

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX
    fcntl = None

USER_AGENT = "research-swarm-ledger/0.1 (+source excerpt check)"
MAX_BYTES = 8 * 1024 * 1024
MIN_WEB_WORDS = 5
STATUSES = ("VERIFIED", "UNVERIFIED", "NOFETCH")
CLAIM_TAG_RE = re.compile(r"\[K\d+\]")
URL_RE = re.compile(r"https?://\S+")
RANGE_SUFFIX_RE = re.compile(r"^(.*?)(?::|#L)(\d+)(?:-L?(\d+))?$")


def default_ledger():
    return os.environ.get("RS_LEDGER") or os.path.join("ledger", "sources.json")


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- storage

class Ledger(object):
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.dir = os.path.dirname(self.path)
        self.pages = os.path.join(self.dir, "pages")

    def load(self):
        if not os.path.exists(self.path):
            return {"sources": []}
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    def save(self, data):
        os.makedirs(self.dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".sources.", dir=self.dir)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, self.path)

    def lock(self):
        os.makedirs(self.dir, exist_ok=True)
        fh = open(self.path + ".lock", "a")
        if fcntl is not None:
            fcntl.flock(fh, fcntl.LOCK_EX)
        return fh

    def by_id(self):
        return {s["id"]: s for s in self.load()["sources"]}

    def page_text(self, sid):
        p = os.path.join(self.pages, sid + ".txt")
        if not os.path.exists(p):
            return None
        with open(p, encoding="utf-8") as f:
            return f.read()


# ---------------------------------------------------------------- fetching

def parse_source(src):
    """Return (kind, location, line_range). kind is 'web' or 'file'."""
    if re.match(r"^https?://", src):
        return "web", src, None
    loc = src
    if loc.startswith("file://"):
        u = urllib.parse.urlparse(loc)
        loc = urllib.parse.unquote(u.path) + ("#" + u.fragment if u.fragment else "")
    rng = None
    m = RANGE_SUFFIX_RE.match(loc)
    if m and not os.path.exists(loc):
        loc = m.group(1)
        a = int(m.group(2))
        b = int(m.group(3)) if m.group(3) else a
        if b < a:
            a, b = b, a
        rng = (a, b)
    return "file", os.path.abspath(os.path.expanduser(loc)), rng


def http_fetch(url, timeout=20):
    """Return (bytes, content_type). Raises on failure. Tests replace this."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(MAX_BYTES), r.headers.get("Content-Type", "")


def fetch(kind, loc, rng):
    """Return (status_or_None, text, sha256, reason). status None means fetched;
    the caller decides VERIFIED/UNVERIFIED from the text."""
    if kind == "web":
        try:
            raw, ctype = http_fetch(loc)
        except Exception as e:  # noqa: BLE001 - any failure is NOFETCH
            return "NOFETCH", "", None, "%s: %s" % (type(e).__name__, str(e)[:160])
        sha = hashlib.sha256(raw).hexdigest()
        if raw[:5] == b"%PDF-" or "pdf" in (ctype or "").lower():
            return "UNVERIFIED", "", sha, "pdf not extracted; save a text extract and add it as a local file"
        text = raw.decode("utf-8", "replace")
        if "html" in (ctype or "").lower() or re.search(r"(?i)<html|<body|<p[ >]", text[:5000]):
            text = swarmlib.strip_html(text)
        return None, text, sha, ""
    if not os.path.isfile(loc):
        return "NOFETCH", "", None, "no such file"
    with open(loc, "rb") as f:
        raw = f.read()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8", "replace")
    if rng:
        lines = text.splitlines()
        if rng[0] > len(lines):
            return "NOFETCH", "", sha, "line range starts past end of file (%d lines)" % len(lines)
        text = "\n".join(lines[rng[0] - 1:rng[1]])
    return None, text, sha, ""


def add(ledger, source, excerpt, min_words=MIN_WEB_WORDS):
    kind, loc, rng = parse_source(source)
    with ledger.lock():
        data = ledger.load()
        for s in data["sources"]:
            if s["source"] == source and s["excerpt"] == excerpt:
                return s, False
        status, text, sha, reason = fetch(kind, loc, rng)
        if status is None:
            if not swarmlib.normalise(text):
                status, reason = "UNVERIFIED", "empty text after fetch"
            elif kind == "web" and len(swarmlib.normalise(excerpt).split()) < min_words:
                status, reason = "UNVERIFIED", "excerpt shorter than %d words" % min_words
            elif swarmlib.excerpt_in(excerpt, swarmlib.normalise(text)):
                status = "VERIFIED"
            else:
                status, reason = "UNVERIFIED", "excerpt not found in fetched text"
        nums = [int(s["id"][1:]) for s in data["sources"]]
        sid = "S%d" % (max(nums) + 1 if nums else 1)
        entry = {
            "id": sid,
            "source": source,
            "kind": kind,
            "url": loc if kind == "web" else "file://" + loc,
            "lines": list(rng) if rng else None,
            "fetched_at": now_iso(),
            "sha256": sha,
            "excerpt": excerpt,
            "status": status,
            "reason": reason,
        }
        if text:
            os.makedirs(ledger.pages, exist_ok=True)
            with open(os.path.join(ledger.pages, sid + ".txt"), "w", encoding="utf-8") as f:
                f.write(text)
        data["sources"].append(entry)
        ledger.save(data)
        return entry, True


# ---------------------------------------------------------------- checks

QUOTE_RE = re.compile(r'^quote:\s*"?(.*?)"?\s*$', re.M)


def check_board(ledger, text):
    """Return (problems, counts)."""
    src = ledger.by_id()
    problems = []
    counts = {"entries": 0, "by_type": {}, "cites": {k: 0 for k in STATUSES + ("MISSING",)}}
    for e in swarmlib.parse_board(text):
        counts["entries"] += 1
        counts["by_type"][e.type] = counts["by_type"].get(e.type, 0) + 1
        where = "line %d [%s]" % (e.line, e.type)
        for p in e.problems():
            problems.append("%s: %s" % (where, p))
        if e.type not in swarmlib.NEEDS_CITE:
            continue
        if not e.cites:
            problems.append("%s: no ledger id like [S12]" % where)
            continue
        for c in e.cites:
            s = src.get(c)
            if s is None:
                counts["cites"]["MISSING"] += 1
                problems.append("%s: cites %s, which is not in the ledger" % (where, c))
            else:
                counts["cites"][s["status"]] += 1
                if s["status"] != "VERIFIED":
                    problems.append("%s: cites %s, status %s (%s)" % (where, c, s["status"], s.get("reason", "")))
        q = QUOTE_RE.search(e.body)
        if q and q.group(1).strip() and e.cites:
            texts = [ledger.page_text(c) for c in e.cites if c in src]
            if not any(t and swarmlib.excerpt_in(q.group(1), swarmlib.normalise(t)) for t in texts):
                problems.append("%s: quote is not in the fetched text of %s" % (where, ", ".join(e.cites)))
    return problems, counts


def gate_doc(ledger, text):
    src = ledger.by_id()
    problems = []
    cited = 0
    for i, line in enumerate(text.splitlines(), 1):
        cites = swarmlib.CITE_RE.findall(line)
        for c in cites:
            cited += 1
            s = src.get(c)
            if s is None:
                problems.append("line %d: cites %s, which is not in the ledger" % (i, c))
            elif s["status"] != "VERIFIED":
                problems.append("line %d: cites %s, status %s" % (i, c, s["status"]))
        if CLAIM_TAG_RE.search(line) and not cites:
            bare = URL_RE.sub("", CLAIM_TAG_RE.sub("", line))
            if re.search(r"\d", bare):
                problems.append("line %d: numeric key-claim line with no [S#] citation: %s" % (i, line.strip()[:100]))
    return problems, cited


# ---------------------------------------------------------------- cli

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ledger", default=None, help="path to sources.json (default ./ledger/sources.json or $RS_LEDGER)")
    sub = ap.add_subparsers(dest="cmd")
    a = sub.add_parser("add")
    a.add_argument("source")
    a.add_argument("--excerpt", required=True)
    a.add_argument("--min-words", type=int, default=MIN_WEB_WORDS)
    sub.add_parser("list")
    c = sub.add_parser("check")
    c.add_argument("board")
    g = sub.add_parser("gate")
    g.add_argument("doc")
    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help()
        return 2
    ledger = Ledger(args.ledger or default_ledger())

    if args.cmd == "add":
        entry, new = add(ledger, args.source, args.excerpt, args.min_words)
        print("%s %s%s %s" % (entry["id"], entry["status"], "" if new else " (existing)",
                               ("- " + entry["reason"]) if entry.get("reason") else ""))
        return 0
    if args.cmd == "list":
        for s in ledger.load()["sources"]:
            print("%-5s %-10s %s" % (s["id"], s["status"], s["source"]))
        return 0
    path = args.board if args.cmd == "check" else args.doc
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print("cannot read %s: %s" % (path, e), file=sys.stderr)
        return 2
    if args.cmd == "check":
        problems, counts = check_board(ledger, text)
        for p in problems:
            print("FAIL " + p)
        bt = " ".join("%s=%d" % kv for kv in sorted(counts["by_type"].items()))
        ct = " ".join("%s=%d" % (k, v) for k, v in counts["cites"].items() if v)
        print("check: %d entries (%s); cites %s; %d problems" % (counts["entries"], bt, ct or "none", len(problems)))
        return 1 if problems else 0
    problems, cited = gate_doc(ledger, text)
    for p in problems:
        print("FAIL " + p)
    print("gate: %d citations; %d problems" % (cited, len(problems)))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
