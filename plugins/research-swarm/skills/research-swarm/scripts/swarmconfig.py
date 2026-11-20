"""Run config (run/swarm.json): size presets, overrides, derived agent counts
and the usage budget. Python 3.9+, stdlib only.

Presets grow breadth (more angles, one researcher each), not duplicate agents
per angle. Duplicates are only for blind cross-checks.
"""

import json
import math
import os

# Points of a weekly usage allowance per Opus agent-hour. One measured setup
# put an Opus subagent at roughly $12 per active hour and one point of a weekly
# allowance at $17-24 of notional spend, so about 0.5-0.7; +-50%. Override it
# with your own before/after usage readings.
DEFAULT_POINTS_PER_AGENT_HOUR = 0.6

PRESETS = {
    "small": {"researchers_max": 3, "rounds": 1, "designers": 2, "reviewers": ["codex"]},
    "medium": {"researchers_max": 6, "rounds": 2, "designers": 3, "reviewers": ["codex"]},
    "large": {"researchers_max": 12, "rounds": 3, "designers": 3, "reviewers": ["codex", "grok"]},
}

BASE = {
    "size": "medium",
    "angles": [],              # approved angles; researchers default to len(angles)
    "researchers": None,       # explicit override; still bounded by researchers_max
    "claims_per_verifier": 10,
    "time_box_min": 25,
    "budget": {
        "start_pct": None,     # usage reading at the start of the run
        "stop_points": 20,     # stop once usage has risen this many points
        "ceiling_pct": 85,     # or passed this
        "points_per_agent_hour": DEFAULT_POINTS_PER_AGENT_HOUR,
    },
    "roster": [],              # [{"id": "inv-a", "start": "HH:MM"}]
}

KNOWN = set(BASE) | set(PRESETS["medium"])


class ConfigError(ValueError):
    pass


def make(size="medium", overrides=None):
    if size not in PRESETS:
        raise ConfigError("size must be one of %s" % ", ".join(sorted(PRESETS)))
    cfg = json.loads(json.dumps(BASE))
    cfg.update(json.loads(json.dumps(PRESETS[size])))
    cfg["size"] = size
    for key, value in (overrides or {}).items():
        set_key(cfg, key, value)
    return cfg


def parse_value(raw):
    """--set values are JSON when they parse (3, true, ["codex","grok"]), else strings."""
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def parse_sets(items):
    out = {}
    for item in items or []:
        if "=" not in item:
            raise ConfigError("--set needs key=value, got %r" % item)
        k, v = item.split("=", 1)
        out[k.strip()] = parse_value(v.strip())
    return out


def set_key(cfg, key, value):
    """Set a top-level key or a dotted budget key (budget.stop_points)."""
    parts = key.split(".")
    if parts[0] not in KNOWN:
        raise ConfigError("unknown config key %r (known: %s)" % (key, ", ".join(sorted(KNOWN))))
    if len(parts) == 2 and parts[0] == "budget":
        if parts[1] not in BASE["budget"]:
            raise ConfigError("unknown budget key %r" % parts[1])
        cfg["budget"][parts[1]] = value
    elif len(parts) == 1:
        cfg[key] = value
    else:
        raise ConfigError("bad key %r" % key)
    validate(cfg)


def validate(cfg):
    for k in ("researchers_max", "rounds", "designers", "claims_per_verifier", "time_box_min"):
        if not isinstance(cfg.get(k), int) or cfg[k] < 1:
            raise ConfigError("%s must be a positive integer" % k)
    if cfg.get("researchers") is not None and (not isinstance(cfg["researchers"], int) or cfg["researchers"] < 1):
        raise ConfigError("researchers must be a positive integer or null")
    if not isinstance(cfg.get("reviewers"), list) or not cfg["reviewers"]:
        raise ConfigError("reviewers must be a non-empty list, e.g. [\"codex\"]")
    if not isinstance(cfg.get("angles"), list):
        raise ConfigError("angles must be a list")


def researchers(cfg):
    """Researchers for the next round: the explicit override, else one per
    approved angle, never more than researchers_max and never fewer than 1."""
    want = cfg.get("researchers") or len(cfg.get("angles") or []) or cfg["researchers_max"]
    return max(1, min(want, cfg["researchers_max"]))


def verifiers(cfg, claims):
    return max(1, int(math.ceil(float(claims) / cfg["claims_per_verifier"])))


def reviewers(cfg, user_asked_grok=False):
    rs = list(cfg["reviewers"])
    if user_asked_grok and "grok" not in rs:
        rs.append("grok")
    return rs


def budget(start_pct, now_pct=None, stop_points=20, ceiling_pct=85,
           points_per_agent_hour=DEFAULT_POINTS_PER_AGENT_HOUR, hours=None, agents=None):
    """Return a dict: limit_pct, remaining, max_agents (for `hours`) and
    hours_left (for `agents`). remaining <= 0 means stop now."""
    if start_pct is None:
        raise ConfigError("need a starting usage reading (start_pct)")
    if points_per_agent_hour <= 0:
        raise ConfigError("points_per_agent_hour must be positive")
    now = start_pct if now_pct is None else now_pct
    limit = min(start_pct + stop_points, ceiling_pct)
    remaining = round(limit - now, 2)
    out = {"limit_pct": limit, "remaining": remaining, "stop": remaining <= 0,
           "max_agents": None, "hours_left": None}
    if hours:
        out["max_agents"] = max(0, int(math.floor(remaining / (points_per_agent_hour * hours))))
    if agents:
        out["hours_left"] = max(0.0, round(remaining / (points_per_agent_hour * agents), 2))
    return out


def load(path):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    validate(cfg)
    return cfg


def save(path, cfg):
    validate(cfg)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def roster_from(cfg):
    return [(r["id"], r.get("start")) for r in cfg.get("roster", [])]
