"""Shared parsing for the research-swarm scripts. Python 3.9+, stdlib only.

Board entry contract (one entry per heading, append-only file):

    ### [TAKE] Q07 · inv-a · 14:05
    ### [FACT] Q07 · short title · inv-a · 14:12
    source: [S3] https://example.org/page
    quote: "verbatim text from that one source"
    note: what it changes for which decision

TYPE is TAKE, FACT, MEASURE, FAIL, CLAIM or OPEN. The first field after the
type is the question id (Q followed by digits) and is required on TAKE, FACT,
MEASURE and FAIL. The last two fields are the agent id and HH:MM.
"""

import html
import re
import unicodedata

TYPES = ("TAKE", "FACT", "MEASURE", "FAIL", "CLAIM", "OPEN")
NEEDS_QID = ("TAKE", "FACT", "MEASURE", "FAIL")
NEEDS_CITE = ("FACT", "MEASURE", "CLAIM")
DELIVERS = ("FACT", "MEASURE", "FAIL")

HEAD_RE = re.compile(r"^### \[([A-Z]+)\]\s*(.*)$")
QID_RE = re.compile(r"^Q\d+$")
TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
CITE_RE = re.compile(r"\[(S\d+)\]")


class Entry(object):
    def __init__(self, line_no, etype, fields, body):
        self.line = line_no  # 1-based line of the heading
        self.type = etype
        self.fields = fields
        self.body = body  # text of the entry including heading
        self.qid = fields[0] if fields and QID_RE.match(fields[0]) else None
        self.time = None
        self.agent = None
        if len(fields) >= 2 and TIME_RE.match(fields[-1]):
            self.time = fields[-1]
            self.agent = fields[-2]
        self.cites = CITE_RE.findall(body)

    def problems(self):
        out = []
        if self.type not in TYPES:
            out.append("unknown type [%s]" % self.type)
        if self.time is None:
            out.append("heading must end with '· <agent-id> · HH:MM'")
        if self.type in NEEDS_QID and self.qid is None:
            out.append("[%s] needs a question id (Q##) as its first field" % self.type)
        return out

    def minutes(self):
        return to_minutes(self.time) if self.time else None


def to_minutes(hhmm):
    m = TIME_RE.match(hhmm.strip())
    if not m:
        raise ValueError("not HH:MM: %r" % hhmm)
    return int(m.group(1)) * 60 + int(m.group(2))


def parse_board(text):
    """Split a board into entries. Lines before the first heading are ignored."""
    entries = []
    cur = None
    buf = []
    for i, line in enumerate(text.splitlines(), 1):
        m = HEAD_RE.match(line)
        if m:
            if cur is not None:
                entries.append(Entry(cur[0], cur[1], cur[2], "\n".join(buf)))
            fields = [f.strip() for f in m.group(2).split("·")]
            fields = [f for f in fields if f]
            cur = (i, m.group(1), fields)
            buf = [line]
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        entries.append(Entry(cur[0], cur[1], cur[2], "\n".join(buf)))
    return entries


# ---------------------------------------------------------------- normalise

_QUOTES = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
    "«": '"', "»": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
    "―": "-", "−": "-",
    " ": " ", " ": " ", " ": " ", "​": "",
    "…": "...",
}
_MD_ESCAPE_RE = re.compile(r"\\([!-/:-@\[-`{-~])")  # backslash before any ASCII punctuation
_TAG_RE = re.compile(r"<[^>]*>")
_DROP_RE = re.compile(r"[\"'`*_]")
_WS_RE = re.compile(r"\s+")
_SPACE_PUNCT_RE = re.compile(r" ([,.;:!?)\]])")
_PUNCT_SPACE_RE = re.compile(r"([(\[]) ")


def strip_html(text):
    text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?is)<!--.*?-->", " ", text)
    # Inline tags inside a word (<b>w</b>ord) must not split it, block tags must.
    text = re.sub(r"(?i)</?(b|i|em|strong|span|a|code|sup|sub|abbr|mark|small|u|s)\b[^>]*>", "", text)
    return _TAG_RE.sub(" ", text)


def normalise(text):
    """Comparable form: entities, unicode quotes/dashes/spaces, markdown escapes
    and emphasis removed, case-folded, whitespace collapsed, and spaces around
    punctuation made consistent (so tag-split 'word ,' matches 'word,')."""
    for _ in range(2):  # double-escaped entities (&amp;quot;) are common
        text = html.unescape(text)
    text = unicodedata.normalize("NFKC", text)
    text = "".join(_QUOTES.get(c, c) for c in text)
    text = _MD_ESCAPE_RE.sub(r"\1", text)
    text = _DROP_RE.sub("", text)
    text = _WS_RE.sub(" ", text).strip().lower()
    text = _SPACE_PUNCT_RE.sub(r"\1", text)
    text = _PUNCT_SPACE_RE.sub(r"\1", text)
    return text


def excerpt_in(excerpt, haystack_norm):
    """True if the excerpt occurs in already-normalised text. An excerpt may
    elide with '...' (or the unicode ellipsis); every piece must then occur in
    order."""
    pieces = [p.strip() for p in normalise(excerpt).split("...")]
    pieces = [p for p in pieces if p]
    if not pieces:
        return False
    pos = 0
    for p in pieces:
        i = haystack_norm.find(p, pos)
        if i < 0:
            return False
        pos = i + len(p)
    return True


# ---------------------------------------------------------------- gate replies

VERDICT_RE = re.compile(r"^\s*VERDICT:\s*(PASS|REJECT)\s*$")
FINDING_RE = re.compile(r"^\s*(\d+)[.)]\s+(.*\S)\s*$")
LOC_RE = re.compile(r"([\w./~-]+\.\w+):(\d+)(?:-(\d+))?")


def parse_findings(text):
    """Numbered findings: '1. path/file.md:12 - what is wrong', optionally
    followed by indented or 'evidence:' continuation lines. Returns a list of
    dicts with n, text, file, line, evidence."""
    out = []
    cur = None
    for raw in text.splitlines():
        if VERDICT_RE.match(raw):
            continue
        m = FINDING_RE.match(raw)
        if m:
            cur = {"n": int(m.group(1)), "text": m.group(2), "file": None,
                   "line": None, "evidence": ""}
            loc = LOC_RE.search(m.group(2))
            if loc:
                cur["file"] = loc.group(1)
                cur["line"] = int(loc.group(2))
            out.append(cur)
            continue
        if cur is None:
            continue
        s = raw.strip()
        if not s:
            continue
        if raw[:1] in (" ", "\t") or s.lower().startswith("evidence:"):
            ev = s[9:].strip() if s.lower().startswith("evidence:") else s
            cur["evidence"] = (cur["evidence"] + " " + ev).strip()
            if cur["line"] is None:
                loc = LOC_RE.search(s)
                if loc:
                    cur["file"] = loc.group(1)
                    cur["line"] = int(loc.group(2))
        elif s.startswith("#"):
            cur = None
    return out
