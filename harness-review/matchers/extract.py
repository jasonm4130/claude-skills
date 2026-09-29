#!/usr/bin/env python3
"""Extract a normalized, input-free failure-event stream from Claude Code transcripts.

Usage: extract.py [--since YYYY-MM-DD] [--out events.jsonl]
Reads ~/.claude/projects/**/*.jsonl (incl. subagents/). Emits rows:
  call   every tool_use (tool, normalized-input hash, Bash head token)
  err    tool_result with is_error, or a soft failure (interrupted, empty agent return, EPERM)
  umsg   human-typed top-level message (regex flags only; no text kept)
  intr   [Request interrupted by user ...]
  compact, hookerr, stophook, queued
No raw command or message text is written.
"""
import json, glob, os, re, sys, hashlib, argparse, time

ap = argparse.ArgumentParser()
ap.add_argument('--since', default='2000-01-01')
ap.add_argument('--out', default=os.path.join(os.environ.get('TMPDIR', '/tmp'), 'harness-corpus', 'events.jsonl'))
a = ap.parse_args()
ROOT = os.path.expanduser('~/.claude/projects')

def h(s): return hashlib.md5(s.encode()).hexdigest()[:10]
def norm_input(inp): return h(re.sub(r'\d+', 'N', json.dumps(inp, sort_keys=True)))

def head_tok(cmd):
    """First token of the first substantive segment (skips cd/export/echo/env-assign/wrappers)."""
    for seg in re.split(r'&&|\|\||;|\n|\|', cmd):
        toks = seg.strip().split()
        while toks and (re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', toks[0]) or toks[0] in ('sudo', 'time', 'command', 'exec', '(', '{', 'then', 'do', 'if', 'op', 'run')):
            toks = toks[1:]
        if not toks or toks[0] in ('cd', 'export', 'echo', 'set', 'unset', 'true', 'printf', 'source', 'for', 'while', 'until', 'fi', 'done', 'cat'):
            if toks and toks[0] == 'cat': return 'cat'
            continue
        return re.sub(r'^.*/', '', toks[0])[:24]
    return ''

def classify(tool, text):
    t = text[:1500]; tl = t.lower()
    if 'denied by the claude code auto mode classifier' in tl:
        m = re.search(r'Reason: \[([^\]]+)\]', t); return 'perm.classifier_denied', (m.group(1) if m else '')
    if re.search(r'permission to use .* has been denied|permission for this action', tl):
        return 'perm.rule_denied', ''
    if "the user doesn't want to proceed" in tl or 'tool use was rejected' in tl or 'user rejected' in tl:
        return 'user.rejected_tool', ''
    if 'request interrupted by user' in tl: return 'user.interrupted_tool', ''
    if tool == 'StructuredOutput': return ('tool.structured_output_schema', 'toolcall_shape' if 'was called with' in tl[:120] else 'schema_mismatch')
    if re.match(r'this (session|agent) is isolated in the worktree', tl): return 'agent.worktree_isolation', ('agent' if tl.startswith('this agent') else 'session')
    mh = re.match(r'(?:<tool_use_error>)?(?:pretooluse:\w+ hook error: )?(?:\[([^\]]+)\]\s*)?(?:blocked by )?([a-z][a-z0-9_\-]{2,30}):\s', tl)
    if mh and (mh.group(1) or re.match(r'^(lsp-first|docs-sync-guard|secrets-scan|no-route-around-ci|kill-guard|[a-z\-]+-guard)$', mh.group(2))):
        nm = (mh.group(1) or mh.group(2)); nm = re.sub(r'^.*/', '', nm).split()[0]
        return 'hook.block', nm
    if 'hook error' in tl[:200] or 'hook blocked' in tl[:200] or 'workflow-model-guard' in tl:
        m = re.search(r'hook error: (?:\[([^\]]+)\]|([\w\-\.]+))', t)
        name = ''
        if m:
            name = m.group(1) or m.group(2) or ''
            name = re.sub(r'^.*/', '', name).split()[0] if name.strip() else ''
        if 'workflow-model-guard' in tl: name = 'workflow-model-guard'
        return 'hook.block', name
    if tl.startswith('<tool_use_error>blocked'): return 'hook.block', 'harness-bash-blocked'
    if 'operation not permitted' in tl: return 'sandbox.eperm', ''
    if ('1password' in tl and ('socket' in tl or 'agent' in tl)) or 'failed to write commit object' in tl:
        return 'env.1password_locked', ''
    if 'concurrent subagent limit' in tl: return 'agent.concurrency_cap', ''
    if 'worktree' in tl[:400] and re.search(r'isolation|refus|cannot create|unable', tl[:400]): return 'agent.worktree_isolation', ''
    if re.search(r'file has not been read yet|must read the file|read it first', tl): return 'file.not_read_first', ''
    if 'file has been modified since' in tl or 'unexpectedly modified' in tl: return 'file.modified_since_read', ''
    if 'string to replace not found' in tl: return 'file.edit_nomatch', ''
    if 'matches of the string to replace' in tl: return 'file.edit_ambiguous', ''
    if 'exceeds maximum allowed tokens' in tl or 'file content' in tl[:80] and 'exceeds' in tl[:160]: return 'read.too_large', ''
    if 'eisdir' in tl or 'illegal operation on a directory' in tl: return 'fs.is_dir', ''
    if 'zoxide' in tl: return 'shell.zoxide_cd', ''
    if re.search(r'\(eval\):\d+|zsh:\d*:? |no matches found|bad substitution|parse error near|unmatched|unknown file attribute|bad pattern|number expected|zsh: ', t):
        mm = re.search(r'no matches found|bad substitution|parse error near|unmatched|unknown file attribute|bad pattern|number expected|command not found|\(eval\)', tl)
        return 'shell.zsh_ism', (mm.group(0) if mm else 'zsh_other')
    if 'command killed' in tl or 'timed out' in tl[:300]: return 'exec.timeout_or_killed', ''
    if 'inputvalidationerror' in tl or re.search(r'required parameter .* is missing|the required parameter', tl): return 'tool.input_validation', ''
    if 'no such tool available' in tl: return 'tool.unknown_or_deferred', ''
    if 'did not respond in time' in tl or 'extension' in tl[:200] and 'connect' in tl[:200]: return 'browser.extension_unreachable', ''
    if tool.startswith('mcp__claude-in-chrome') or tool.startswith('mcp__chrome-devtools'):
        if 'accessibility tree' in tl or 'no element' in tl or 'not find' in tl or 'no ' in tl[:12]: return 'browser.element_not_found', ''
        if 'not allowed' in tl or 'safety restrictions' in tl: return 'browser.site_blocked', ''
        return 'browser.other', ''
    if tool.startswith('mcp__'):
        if re.search(r'unauthor|not authenticated|401|403', tl[:300]): return 'mcp.auth', ''
        return 'mcp.other', ''
    if tool == 'WebFetch':
        if 'unable to fetch from' in tl: return 'web.domain_blocked_or_unfetchable', ''
        if 'timeout of' in tl[:60]: return 'web.timeout', ''
        if re.search(r'403|429|blocked|forbidden|cloudflare|captcha|certificate|maxcontentlength', tl[:300]): return 'web.bot_protection_or_tls_or_size', ''
        return 'web.other', ''
    if re.search(r'no such file or directory|enoent|file does not exist|does not exist', tl[:300]): return 'fs.not_found', ''
    if tool in ('Agent', 'Task'): return 'agent.error', ''
    m = re.match(r'exit code (\d+)', tl)
    if m: return 'bash.exit_' + m.group(1), ''
    return 'other', ''

def text_of(c):
    if isinstance(c, str): return c
    if isinstance(c, list): return '\n'.join(b.get('text', '') if isinstance(b, dict) else str(b) for b in c)
    return json.dumps(c) if c is not None else ''

CORR = [
    ('stop', re.compile(r'^\s*(wait|stop|hold on|hang on)\b', re.I)),
    ('neg', re.compile(r"^\s*(no|nope|nah|not that|that'?s not|that is not|incorrect)\b[\s,.!:-]", re.I)),
    ('wrong', re.compile(r"\b(that'?s wrong|that is wrong|you'?re wrong|wrong (file|repo|branch|approach|dir)|not what i (asked|meant|wanted)|i didn'?t (ask|say|want)|why did you|why are you|you (didn'?t|shouldn'?t|forgot|missed|ignored|keep)|don'?t do that|stop doing|as i (said|mentioned)|i already (told|said))", re.I)),
    ('revert', re.compile(r'^\s*(revert|undo|roll ?back|put it back)\b', re.I)),
]
def corr_flags(text): return [n for n, r in CORR if r.search(text)]

rows = []
cut = time.mktime(time.strptime(a.since, '%Y-%m-%d'))
nfiles = 0
for f in glob.glob(ROOT + '/**/*.jsonl', recursive=True):
    try:
        if os.path.getmtime(f) < cut: continue
    except OSError: continue
    nfiles += 1
    fside = '/subagents/' in f
    proj = f[len(ROOT) + 1:].split('/')[0]
    uses = {}
    try: fh = open(f)
    except OSError: continue
    for l in fh:
        try: d = json.loads(l)
        except Exception: continue
        ts = d.get('timestamp', '')
        if not ts or ts[:10] < a.since: continue
        sid = d.get('sessionId') or d.get('session_id') or os.path.basename(f)[:36]
        side = bool(d.get('isSidechain')) or fside
        base = {'ts': ts, 'day': ts[:10], 'sid': sid, 'side': side, 'proj': proj, 'ver': d.get('version', '')}
        t = d.get('type')
        if t == 'assistant':
            c = d.get('message', {}).get('content')
            if isinstance(c, list):
                for b in c:
                    if b.get('type') == 'tool_use':
                        inp = b.get('input', {})
                        r = dict(base, k='call', tool=b['name'], id=b['id'], sig=norm_input(inp), exact=h(json.dumps(inp, sort_keys=True)))
                        if b['name'] == 'Bash': r['head'] = head_tok(inp.get('command', ''))
                        uses[b['id']] = (b['name'], r['sig'], r.get('head', ''), r['exact'])
                        rows.append(r)
        elif t == 'user':
            c = d.get('message', {}).get('content')
            if isinstance(c, list):
                for b in c:
                    if b.get('type') == 'tool_result':
                        txt = text_of(b.get('content'))
                        tool, sig, hd, ex = uses.get(b.get('tool_use_id'), ('?', '', '', ''))
                        is_err = bool(b.get('is_error')); tur = d.get('toolUseResult'); soft = None
                        if not is_err:
                            tl = txt[:800].lower()
                            if tool == 'Bash' and isinstance(tur, dict) and tur.get('interrupted'): soft = 'exec.interrupted'
                            elif tool in ('Agent', 'Task') and len(txt.strip()) < 40: soft = 'agent.empty_return'
                            elif 'operation not permitted' in tl: soft = 'sandbox.eperm'
                        if is_err or soft:
                            cat, sub = classify(tool, txt)
                            if soft and cat == 'other': cat = soft
                            if tool in ('Agent', 'Task') and cat in ('other', 'agent.error') and len(txt.strip()) < 40: cat = 'agent.empty_return'
                            rows.append(dict(base, k='err', tool=tool, id=b.get('tool_use_id'), cat=cat, sub=sub, sig=sig, exact=ex, head=hd, hard=is_err, n=len(txt)))
                    elif b.get('type') == 'text' and b.get('text', '').startswith('[Request interrupted by user'):
                        rows.append(dict(base, k='intr', tool_use=('for tool use' in b['text'])))
                if not side and not d.get('isMeta'):
                    txt = '\n'.join(b.get('text', '') for b in c if b.get('type') == 'text')
                    if txt and not txt.startswith(('<', '[Request interrupted', 'Caveat:')):
                        rows.append(dict(base, k='umsg', len=len(txt), flags=corr_flags(txt[:400])))
            elif isinstance(c, str) and not side and not d.get('isMeta'):
                if c.startswith('[Request interrupted by user'):
                    rows.append(dict(base, k='intr', tool_use=('for tool use' in c)))
                elif not c.startswith(('<', 'Caveat:')):
                    rows.append(dict(base, k='umsg', len=len(c), flags=corr_flags(c[:400])))
        elif t == 'system':
            st = d.get('subtype')
            if st == 'compact_boundary':
                cm = d.get('compactMetadata') or {}
                rows.append(dict(base, k='compact', trig=cm.get('trigger'), pre=cm.get('preTokens')))
            elif st == 'stop_hook_summary':
                errs = d.get('hookErrors') or []
                if errs or d.get('preventedContinuation'):
                    rows.append(dict(base, k='hookerr', src='stop', n=len(errs), prevented=bool(d.get('preventedContinuation'))))
                rows.append(dict(base, k='stophook', n=d.get('hookCount', 0)))
        elif t == 'attachment':
            at = d.get('attachment', {})
            if at.get('type') == 'hook_non_blocking_error':
                rows.append(dict(base, k='hookerr', src='nonblocking', name=str(at.get('hookName'))[:40], code=at.get('exitCode')))
            elif at.get('type') == 'queued_command':
                rows.append(dict(base, k='queued'))
os.makedirs(os.path.dirname(a.out), exist_ok=True)
with open(a.out, 'w') as o:
    for r in rows: o.write(json.dumps(r) + '\n')
print(f'files={nfiles} rows={len(rows)} -> {a.out}')
