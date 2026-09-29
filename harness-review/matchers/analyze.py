#!/usr/bin/env python3
"""Analyze events.jsonl from extract.py. Prints the failure taxonomy metrics.
Usage: analyze.py [events.jsonl] [--json out.json]
Metric of record for "did a fix work": per-category rate per 1000 tool calls, split by day,
plus distinct-session recurrence and identical-retry rate.
"""
import json, sys, os, collections, statistics
p = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else os.path.join(os.environ.get('TMPDIR', '/tmp'), 'harness-corpus', 'events.jsonl')
R = [json.loads(l) for l in open(p)]
# dedupe calls / errs by id
seen = set(); rows = []
for r in R:
    if r['k'] in ('call', 'err'):
        key = (r['k'], r['id'])
        if key in seen: continue
        seen.add(key)
    rows.append(r)
R = rows
calls = [r for r in R if r['k'] == 'call']
errs = [r for r in R if r['k'] == 'err']
days = sorted({r['day'] for r in calls})
cpd = collections.Counter(r['day'] for r in calls)
print('== coverage: tool calls per day in transcripts')
print(' '.join(f'{d[5:]}:{cpd[d]}' for d in days))
print('total calls', len(calls), 'main', sum(1 for r in calls if not r['side']), 'sidechain', sum(1 for r in calls if r['side']))
print('total err rows', len(errs), '(hard is_error:', sum(1 for r in errs if r['hard']), ')')

def fam(c): return c.split('.')[0]
print('\n== category counts (rows) | sessions | days | main/side | rate per 1000 calls')
byc = collections.defaultdict(list)
for r in errs:
    c = r['cat']
    if c.startswith('bash.exit_'): c = 'bash.exit_nonzero'
    byc[c].append(r)
for c, v in sorted(byc.items(), key=lambda kv: -len(kv[1])):
    ss = {r['sid'] for r in v}; dd = {r['day'] for r in v}
    m = sum(1 for r in v if not r['side'])
    print(f'{len(v):5d} {c:38s} sess={len(ss):4d} days={len(dd):2d} main={m:4d} side={len(v)-m:4d} /1k={1000*len(v)/len(calls):5.1f}')

print('\n== sub-labels for key categories')
for c in ('hook.block', 'shell.zsh_ism', 'perm.classifier_denied', 'agent.worktree_isolation', 'tool.structured_output_schema'):
    cc = collections.Counter(r['sub'] for r in byc.get(c, []))
    print(c, cc.most_common(10))

print('\n== bash nonzero exits by head token (top 25) | benign-probe heads flagged')
PROBE = {'grep', 'rg', 'diff', 'test', '[', '[[', 'jq', 'cmp', 'git', 'ls', 'stat', 'cat', 'head', 'tail', 'find', 'wc', 'python3', 'node', 'pnpm', 'uv', 'cargo', 'go', 'curl', 'gh'}
hc = collections.Counter(r['head'] for r in byc.get('bash.exit_nonzero', []))
print(hc.most_common(25))
print('exit-code split:', collections.Counter(r['cat'] for r in errs if r['cat'].startswith('bash.exit_')).most_common(8))

print('\n== trend: weekly-ish buckets by day (err rows per 1000 calls) for main categories')
top = [c for c, v in sorted(byc.items(), key=lambda kv: -len(kv[1]))[:12]]
print('day       calls ' + ' '.join(c[:14].rjust(14) for c in top))
for d in days:
    if cpd[d] < 200: continue
    cnt = collections.Counter((r['cat'] if not r['cat'].startswith('bash.exit_') else 'bash.exit_nonzero') for r in errs if r['day'] == d)
    print(f'{d} {cpd[d]:6d} ' + ' '.join(f'{cnt[c]:6d}({1000*cnt[c]/cpd[d]:4.0f})'.rjust(14) for c in top))

# retries: order by (sid, side) then ts
streams = collections.defaultdict(list)
for r in R:
    if r['k'] in ('call', 'err'): streams[(r['sid'], r['side'])].append(r)
for s in streams.values(): s.sort(key=lambda r: r['ts'])
print('\n== behavior after a failure (next 5 calls in same stream): identical retry / same-shape retry / other')
res = collections.defaultdict(lambda: collections.Counter())
runs = collections.defaultdict(list)
for key, s in streams.items():
    calls_s = [r for r in s if r['k'] == 'call']
    idx = {r['id']: i for i, r in enumerate(calls_s)}
    for r in s:
        if r['k'] != 'err' or not r['hard']: continue
        c = r['cat'] if not r['cat'].startswith('bash.exit_') else 'bash.exit_nonzero'
        i = idx.get(r['id'])
        if i is None: continue
        nxt = calls_s[i + 1:i + 6]
        if not nxt: res[c]['no_followup'] += 1; continue
        if any(n['exact'] == r['exact'] for n in nxt): res[c]['identical_retry'] += 1
        elif any(n['tool'] == r['tool'] and n['sig'] == r['sig'] for n in nxt): res[c]['same_shape_retry'] += 1
        else: res[c]['moved_on_or_adapted'] += 1
for c, v in sorted(res.items(), key=lambda kv: -sum(kv[1].values()))[:16]:
    t = sum(v.values())
    print(f'{c:34s} n={t:4d} identical={v["identical_retry"]:4d} ({100*v["identical_retry"]/t:3.0f}%) same_shape={v["same_shape_retry"]:4d} adapted={v["moved_on_or_adapted"]:4d} none={v["no_followup"]}')

print('\n== consecutive same-category failure runs >=3 in a stream (count of runs, longest)')
runc = collections.Counter(); longest = {}
for key, s in streams.items():
    prev = None; n = 0
    for r in s:
        if r['k'] != 'err' or not r['hard']: continue
        c = r['cat'] if not r['cat'].startswith('bash.exit_') else 'bash.exit_nonzero'
        if c == prev: n += 1
        else:
            if prev and n >= 3: runc[prev] += 1; longest[prev] = max(longest.get(prev, 0), n)
            prev, n = c, 1
    if prev and n >= 3: runc[prev] += 1; longest[prev] = max(longest.get(prev, 0), n)
print([(c, v, longest[c]) for c, v in runc.most_common(10)])

print('\n== hook.block: what tool follows (next call), per hook')
for hk in ('lsp-first', 'docs-sync-guard', 'harness-bash-blocked', 'workflow-model-guard', 'secrets-scan', 'no-route-around-ci'):
    nexts = collections.Counter(); n = 0
    for key, s in streams.items():
        calls_s = [r for r in s if r['k'] == 'call']
        idx = {r['id']: i for i, r in enumerate(calls_s)}
        for r in s:
            if r['k'] == 'err' and r['cat'] == 'hook.block' and r['sub'] == hk and r['id'] in idx:
                i = idx[r['id']]
                n += 1
                nxt = calls_s[i + 1:i + 4]
                nexts['LSP_within3' if any(x['tool'] == 'LSP' for x in nxt) else ('same_tool_again' if any(x['tool'] == r['tool'] for x in nxt) else 'other')] += 1
    print(hk, n, dict(nexts))

print('\n== human signals (top-level user messages only)')
um = [r for r in R if r['k'] == 'umsg']
flag = collections.Counter(f for r in um for f in r['flags'])
print('user messages', len(um), 'flagged as correction-like:', sum(1 for r in um if r['flags']), dict(flag))
ic = [r for r in R if r['k'] == 'intr']
print('interrupts', len(ic), 'of which during tool use:', sum(1 for r in ic if r.get('tool_use')))
print('user.rejected_tool errs', len(byc.get('user.rejected_tool', [])))
udays = sorted({r['day'] for r in um})
print('per day: msgs / correction-flagged / interrupts')
for d in udays:
    a = [r for r in um if r['day'] == d]; f = [r for r in a if r['flags']]; i = [r for r in ic if r['day'] == d]
    print(f'{d} {len(a):4d} {len(f):3d} {len(i):3d}')
print('\n== compactions')
cp = [r for r in R if r['k'] == 'compact']
print('total', len(cp), collections.Counter(r['trig'] for r in cp), 'median pre-tokens', statistics.median([r['pre'] for r in cp if r.get('pre')] or [0]))
print('sessions with >=2 compactions:', sum(1 for v in collections.Counter(r['sid'] for r in cp).values() if v >= 2))
print(' per day:', sorted(collections.Counter(r['day'] for r in cp).items()))
print('\n== hook errors outside tool blocks', collections.Counter((r.get('src'), r.get('name')) for r in R if r['k'] == 'hookerr'))
print('stop-hook summaries', sum(1 for r in R if r['k'] == 'stophook'))
print('\n== subagent empties', len(byc.get('agent.empty_return', [])), ' agent calls', sum(1 for r in calls if r['tool'] in ('Agent', 'Task')), 'agent errs', sum(1 for r in errs if r['tool'] in ('Agent', 'Task')))
