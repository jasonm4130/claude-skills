#!/usr/bin/env python3
"""Cluster Bash 'Exit code N' failures by output signature (no raw text printed).
Excludes zsh (eval) errors and 1Password signing, which extract.py counts separately."""
import json, glob, collections, re, os
c = collections.Counter(); sess = collections.defaultdict(set); seen = set()
def cl(t):
    b = t.split('\n', 1)[1] if '\n' in t else ''; bl = b.lower()
    if '(eval):' in t or 'zsh:' in bl[:200]: return None
    if '1password' in bl or 'failed to write commit object' in bl: return None
    if not b.strip(): return 'silent nonzero (no-match probe style)'
    if 'traceback (most recent call last)' in bl or 'node:internal' in bl: return 'python/node exception in agent-written script'
    if re.search(r'^sed: \d|illegal option|invalid command code|unterminated', bl, re.M): return 'BSD-vs-GNU syntax'
    if 'no such file or directory' in bl or 'cannot access' in bl: return 'path missing'
    if re.search(r'connection refused|could not resolve|timed out|connection reset|no route', bl): return 'network/host unreachable'
    if 'permission denied' in bl: return 'permission denied'
    if re.search(r'unknown json field|unknown flag|unknown option|unrecognized|invalid (option|argument)|usage:', bl): return 'wrong flag/usage'
    if re.search(r'\berror\b|failed|fatal|\bfail\b', bl): return 'tool-reported error (build/test/git/gh/api)'
    if re.search(r'^(---|===|##|#!)', b.strip()) or len(b) > 400: return 'long output, failure unclear (likely trailing probe nonzero after useful output)'
    return 'other short output'
for f in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'), recursive=True):
    for l in open(f):
        try: d = json.loads(l)
        except Exception: continue
        if d.get('type') != 'user' or not isinstance(d.get('message', {}).get('content'), list): continue
        for b in d['message']['content']:
            if b.get('type') != 'tool_result' or not b.get('is_error') or b['tool_use_id'] in seen: continue
            t = b.get('content'); t = t if isinstance(t, str) else '\n'.join(x.get('text', '') for x in t if isinstance(x, dict))
            if not re.match(r'Exit code \d+', t): continue
            seen.add(b['tool_use_id']); k = cl(t)
            if k: c[k] += 1; sess[k].add(d.get('sessionId'))
print(sum(c.values()), 'bash exit rows classified')
for k, v in c.most_common(): print(v, k, len(sess[k]), 'sessions')
