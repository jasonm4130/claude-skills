# Local skeptic on M5 Max: serving stack and model shortlist

Date: 2026-09-05. Machine: M5 Max, 128 GB, Claude Code 2.1.261 via `ANTHROPIC_BASE_URL`.
Workload: read-only reviewer prompt, ~30k-char diff, 14 turns; context grows 27k to 43k tokens, so roughly 1.2k new tokens per turn plus decode. Opus baseline: 178 s, $0.99.

Legend: **[V]** observed this session (command run, source read, HTTP fetched); **[R]** remembered from the research pass or vendor text, not reproduced here.

## Decision: ranked shortlist

The problem to beat is the established every-turn cache MISS (27k to 43k tokens re-prefilled at ~400 tok/s, i.e. 70 to 110 s per turn before decode). Each row below gives one serve command and the per-turn cost if prefix reuse works as claimed. Per-turn = prefill of ~1.2k new tokens + decode of ~400 tokens (decode dominates once reuse works).

### 1. vllm-mlx 0.4.1 (installed) + a non-hybrid MoE: `mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit`

```
vllm-mlx serve mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit --continuous-batching --enable-prefix-cache --cache-memory-mb 24000 --tool-call-parser qwen3_coder --port 8000
```

- Expected per-turn with reuse: ~1 to 2 s prefill + ~10 to 15 s decode (A3B decode ~35 tok/s is **[R]**, from a third-party Qwen3.5-35B-A3B figure; not measured on this stack).
- Rests on **[V]**: the config is `qwen3_moe`, no `layer_types`, no `linear_*` keys (fetched from HF today), so every cache layer is a plain `KVCache` with `offset`/`keys`. In the installed `memory_cache.py` the LCP branch is only blocked when a layer lacks those attributes (lines 889 to 908), and a probe against the installed class returned `exact`, `prefix`, and `miss` for a fake SSM layer, i.e. the block is layer-type-driven exactly as the source says. For a pure-attention model all four match types are live, so re-rendered tool calls that diverge mid-history still hit via LCP.
- Swap: `mlx-community/GLM-4.7-Flash-8bit` (`glm4_moe_lite`, 64 experts, non-hybrid **[V]**) with `--tool-call-parser glm47 --reasoning-parser glm4` (both in 0.4.1's parser list **[V]**). Reviewer quality of either model on this workload: not tested.
- Cost of adopting: zero migration; drops from Qwen3.8-27B to an older coder model.

### 2. Rapid-MLX 0.13.4 + `qwen3.6-35b-8bit` (hybrid A3B, DeltaNet snapshots)

```
rapid-mlx serve qwen3.6-35b-8bit
```

then `rapid-mlx launch claude-code` patches `~/.claude/settings.json` to route to `http://localhost:8000` (no trailing `/v1`).

- Expected per-turn with reuse: ~1 to 2 s + ~10 to 15 s decode (same **[R]** decode figure as row 1; Rapid-MLX's own table gives 868 tok/s prefill on a 6B-active model on M3 Ultra **[V]**, so 1.2k new tokens is about 1.5 s).
- Rests on: PyPI/Socket page **[V by the research pass]** describing "Deep-copy RNN state at prefix boundary, restore in ~0.1ms" for Qwen3.5 4B to 122B and Qwen3-Coder-Next, and README lines 117, 137, 239, 265 **[V]** giving a native `/v1/messages` route and Claude Code as Tier-1, last re-verified 2026-07-28 on claude 2.1.211. Latest release v0.13.4 was published 2026-09-03 **[V]**.
- Caveat: the multi-turn agent-loop hit is inferred. The measured number in its release notes (5273/5288 tokens reused, 0.539 s vs 6.497 s) is a warm repeat of one prompt **[R]**; nobody has published the 14-turn shape. Also a new engine to learn, with its own bugs.

### 3. vllm-mlx 0.4.1 (installed) + `mlx-community/Qwen3.8-27B-8bit`, rerun with diagnostics

```
vllm-mlx serve mlx-community/Qwen3.8-27B-8bit --continuous-batching --enable-prefix-cache --cache-memory-mb 24000 --tool-call-parser qwen3_coder --reasoning-parser qwen3 --port 8000
```

(no `--max-kv-size`, so the plain `KVCache` path is used instead of `RotatingKVCache`, the most-patched trim path: #353.)

- Expected per-turn with reuse: ~3 s prefill + ~25 to 45 s decode at the established 9 to 17 tok/s. Over 14 turns that is 7 to 11 min, versus 25 to 35 min cold. Still the best reviewer model of the four.
- Rests on **[V]**: the installed 0.4.1 does implement think-suffix stripping (`mllm_batch_generator.py:693` `_compute_think_suffix_len`, `:1405` strips `<think>\n` from the lookup key, `:2000` stores the prompt-only key) and the strict-PREFIX path hits on non-trimmable layers (probe above). In principle turn N+1's prompt is a strict superset of turn N's stored key, so turns 2+ should hit as `prefix`, not miss. The observed miss-every-turn therefore has an unexplained cause; do not rerun blind.
- Diagnostic before committing: poll `GET /v1/cache/stats` (`server.py:3551` **[V]**) between turns and grep the server log for `Failed to store prefix cache` (`mllm_batch_generator.py:2006`). Candidate causes, none confirmed: store-time extraction failing on hybrid caches; the auto-memory request (a different prompt) competing for cache budget; per-turn changes above the prompt boundary.
- Correctness risk **[V]**: `_trim_cache_offset` passes non-KV layers through untrimmed (`memory_cache.py`, final `else` branch), so a stored "prompt-only" entry carries SSM state that already consumed the previous reply. On a PREFIX hit the model re-reads its re-rendered reply on top of that state. oMLX issue #825 **[R]** reports tool-calling degradation from this class of stale recurrent state. Watch for malformed tool calls after the first hit.

### 4. vMLX 1.6.53 (`vmlx`, PyPI 2026-09-04) + `mlx-community/Qwen3.8-27B-8bit`

```
vmlx serve mlx-community/Qwen3.8-27B-8bit --continuous-batching
```

- Expected per-turn with reuse: as row 3 if the vendor claim holds; unknown otherwise.
- Rests on vendor text only **[V that the text exists, R that it works]**: PyPI description lists "Hybrid SSM Support: Mamba/GatedDeltaNet layers handled correctly alongside attention", a "Memory-Aware Prefix Cache", and a `POST /v1/messages` Anthropic route. No third-party measurement of a hybrid cache hit was found. Trial-only; one evening to accept or reject.

Not shortlisted: Ornith-1.5-35B-A3B-MLX-8bit is `qwen3_5_moe` hybrid **[V]**, same class as Qwen3.6-35B; on vllm-mlx it inherits row 3's caveats, and whether Rapid-MLX accepts an arbitrary HF repo rather than a catalog alias was not checked. `mlx-community/Devstral-Small-2-24B-Instruct-2512-8bit` is dense `mistral3`, non-hybrid **[V]**, a further row-1-style option. `gpt-oss-120b-MXFP4-Q8` has `layer_types` for sliding-window attention, not SSM **[V]**; its `RotatingKVCache` layers are trimmable but that path is the one with the #353 history, so it was left out.

## Angle: vllm-mlx (installed 0.4.1, mlx-lm 0.31.3, mlx 0.32.2, all [V])

- Version facts **[V]**: `vllm_mlx 0.4.1`, requires `mlx-lm>=0.31.3`; 0.4.1 is the latest release (2026-08-12) and latest PyPI. No newer tag exists, so "upgrade" means building main.
- Think-suffix stripping is real and wired **[V]**, not a phantom: `memory_cache.py:901-903` carries the exact comment from the established facts; the engine strips the trailing `<think>\n` (typically 2 tokens) from both the store key and the lookup key so multi-turn prompts match as a clean PREFIX. It is automatic, no flag.
- LCP block for hybrids **[V]**: `memory_cache.py:889-908`, driven by `hasattr(offset) and hasattr(keys)` per layer.
- The #691 regression (issue #730) does **not** apply to 0.4.1 **[V]**: `grep _can_rewind_prefix_cache` on the installed `mllm_batch_generator.py` returns nothing; #691 merged 2026-08-21, after the 0.4.1 tag. Both fix PRs are still open today: #731 and #744 (`gh api`, state `open`). Building main today would make hybrid prefix reuse worse than 0.4.1, not better.
- Issue #736 is open **[V]** (title: scheduler monkey-patch layer targets pre-0.31 mlx-lm; chunked-prefill and prompt-cache-save inert, `--enable-mtp` crashes). Installed mlx-lm is 0.31.3, so per the issue text **[R]** `--enable-mtp` will crash and `--chunked-prefill-tokens` does nothing. Do not rely on MTP for decode speed on this stack.
- Issue #178 (prefix cache + >19k prompts crash) is **closed** 2026-04-18 **[V]**, so it predates 0.4.1 and is not a live risk.
- Billing header: `api/anthropic_adapter.py:64-67` and `api/prompt_canonicalize.py:10-11` strip `x-anthropic-billing-header` lines **[V]**; `CLAUDE_CODE_ATTRIBUTION_HEADER=0` is optional on this stack.
- Cache budget **[V]**: default `max_memory_percent` 0.20 of available RAM, `min_prefix_tokens` 128, `max_entries` 1000; flags `--cache-memory-mb`, `--cache-memory-percent`, `--prefix-cache-size`, `--ssd-cache-dir`, `--kv-cache-quantization` exist. A 43k-token bf16 entry for the 27B is a few GB, so 24 GB explicit is generous.
- Upstream did ship hybrid recurrent state across prefix-cache blocks in v0.2.7 to v0.2.9 (#217) **[R, confirmed by the verifier]**, contradicting the asiai.dev panel's "no hybrid support upstream".
- Warm-prompts guide **[R]**: strict-prefix warm-up of the rendered system prompt; helps turn 1 only. https://vllm-mlx.is-a.dev/guides/warm-prompts
- URLs: https://github.com/waybarrios/vllm-mlx/issues/730 , /issues/736 , /issues/178 , /pull/731 , /pull/744 , https://github.com/waybarrios/vllm-mlx/releases

## Angle: other stacks

- Rapid-MLX: forked from vllm-mlx, renamed March 2026 **[V, README]**; PyPI 0.13.4 (2026-09-03) **[V]**. Mechanism page: https://socket.dev/pypi/package/rapid-mlx/overview/0.3.12 **[R]**. README: https://github.com/raullenchai/Rapid-MLX **[V]**. Its M3 Ultra table **[V]** shows Qwen3.8-27B-4bit at 330 tok/s prefill, 43 tok/s decode with MTP; 8-bit dense numbers are not published. Whether it carries the upstream #691/#736 classes of bug: not investigated.
- vMLX / MLX Studio: https://mlx.studio and https://pypi.org/project/vmlx/ **[V that the claims are printed]**. Everything about hybrid correctness is vendor-asserted.
- mlx-lm server alone: issues #980 and #1162 **[R]** report zero speedup on hybrid cache "hits" because the cache path allocates `KVCache` for SSM layers and silently resets recurrent state. Not a candidate. https://github.com/ml-explore/mlx-lm/issues/980 , /issues/1162
- llama.cpp: PR #19408 (Feb 2026) added hybrid checkpoints; issues #22746, #21831, #19794 **[R]** show "forcing full prompt re-processing" on Qwen3.5/3.6 through May 2026. No Sept 2026 evidence either way. Would also need a GGUF and its own Anthropic route or proxy. https://github.com/ggml-org/llama.cpp/issues/22746
- LM Studio mlx-engine 1.8.5 disk checkpoints **[R]**: bug tracker #1818 shows a repeated 60k prompt at 70 to 80 s TTFT on MLX vs 1 s on llama-server with `--ctx-checkpoints`. Not a candidate for the MLX path. https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1818
- oMLX (vllm-mlx fork): issue #825 **[R]**, stale recurrent state on hybrid hits degrades tool calling. Relevant as the symptom to watch for in row 3. https://github.com/jundot/omlx/issues/825
- Ollama: inherits llama.cpp semantics **[R, inference from a general description]**; nothing hybrid-specific found.

## Angle: models

- Hybrid (GatedDeltaNet, `layer_types` + `linear_*` in config) **[V]**: Qwen3.8-27B-8bit (`qwen3_5`), Qwen3.6-35B-A3B-8bit and Ornith-1.5-35B-A3B (`qwen3_5_moe`). These need a stack with recurrent-state snapshots (row 2) or the strict-PREFIX path (row 3).
- Non-hybrid, all cache paths usable on 0.4.1 **[V]**: Qwen3-Coder-30B-A3B-Instruct-8bit (`qwen3_moe`, 128 experts), GLM-4.7-Flash-8bit (`glm4_moe_lite`, 64 experts), GLM-4.5-Air-8bit (`glm4_moe`, 128 experts), Devstral-Small-2-24B-8bit (`mistral3`, dense).
- No published head-to-head of these models as an unattended reviewer under Claude Code exists **[R]**; every throughput number found was single-shot. Quality ranking for this task is a guess until run.
- Too large for the box: MiniMax M2 (230B) **[R]**. Magistral: dense by inheritance, config not fetched **[R]**.

## Angle: Claude Code knobs

All from official docs, vLLM's Claude Code page, or the established facts unless marked.
- `ANTHROPIC_BASE_URL=http://localhost:8000` (Rapid-MLX: root URL, no `/v1`, else requests double to `/v1/v1/messages` **[R]**), `ANTHROPIC_AUTH_TOKEN=x`, `ANTHROPIC_DEFAULT_OPUS_MODEL`/`SONNET`/`HAIKU` all set to the served model id. https://docs.vllm.ai/en/stable/serving/integrations/claude_code
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: removes the per-turn `<transcript>` extraction request, which is a second full-context prefill with a different prefix and competes for the cache budget. Established fact, worth setting on every row.
- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`: needed only on stacks that do not strip the billing line; vllm-mlx 0.4.1 strips it **[V]**. Harmless against a local backend; the LiteLLM issue #29572 caveat (OAuth recognition) applies only to real Anthropic endpoints **[R]**.
- `MAX_THINKING_TOKENS=0`: on third-party providers omits the `thinking` field; the model may still think. https://code.claude.com/docs/en/model-config **[R]**. Decode time on a Qwen3.x reviewer is governed by the reasoning parser, not this knob.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`: strips `anthropic-beta` headers; fallback if a stack 400s on them **[R]**. https://docs.litellm.ai/docs/tutorials/claude_responses_api
- SessionStart hooks: the trailing `role:system` message is why the proxy exists. For the overnight profile, simplest is a settings profile with no SessionStart hooks, which removes the proxy from the path; keep the proxy only for row 2 if Rapid-MLX's template rejects it too (untested).
- Subagents: each `Agent` dispatch is a fresh prefix; a reviewer prompt that forbids delegation keeps one growing prefix per session, which is the shape every row's cache is built for.
- `API_TIMEOUT_MS` default 600000 covers a 110 s cold prefill; leave it.

## Refuted, superseded, or unverifiable

- **Refuted**: "issue #178 unresolved". Closed 2026-04-18 (`gh api` today).
- **Refuted in attribution, mechanism stands**: the "deep-copy RNN state at the system-prompt boundary, ~0.1 ms" detail is on Rapid-MLX's PyPI/Socket page, not its README, which says only "prompt cache (radix + DeltaNet RNN snapshots)" **[V]**.
- **Superseded**: wave-1 "no source uses the phrase think-suffix stripping". True of the web; false of the installed source, which implements it (file:line above) **[V]**.
- **Superseded**: asiai.dev panel row "no documented hybrid/DeltaNet support upstream". Changelog #217 shipped it in 0.2.x; issue #730 documents its regression on main after 0.4.1. The panel is a secondary source; do not cite it for upstream state.
- **Does not apply to the installed build**: issue #730 (#691 regression). 0.4.1 predates #691 **[V]**.
- **Unreliable source**: contracollective.com posts (flags such as `--prefix-cache-policy`, `/cache/preload` that exist in no mlx-lm or vllm-mlx source; same domain runs near-future-dated content). Not cited anywhere above.
- **Unverified vendor claims**: vMLX hybrid cache hits; Rapid-MLX multi-turn hits on the 14-turn shape; Rapid-MLX serving a non-catalog HF repo.
- **Unverified third-party findings (capacity cap in the research pass)**: llama.cpp #19408 and its regressions, LM Studio 1.8.5 and tracker #1818, oMLX #825, mlx-lm #980/#1162, qMLX blog measurements, mlx-omni-server caching, Ollama hybrid behaviour. Each is cited above as **[R]**.
- **Not established**: the cause of the observed miss-every-turn on row 3. The source says it should hit; the run says it did not. `/v1/cache/stats` plus the store-failure log line is the cheapest way to close that gap, and it should be closed before spending an overnight run on row 3.

## Suggested order of trials

1. Row 1 tonight: no migration, all cache paths live; measure `/v1/cache/stats` hit type per turn and wall time for the 14-turn run.
2. Row 3 the following night with the same diagnostics, to learn whether the 27B can be kept.
3. Row 2 only if 1 and 3 both fail to hit, or if the 27B's decode makes the run too slow.
4. Row 4 is optional, one evening, accept or reject on its own `/v1/messages` behaviour.

## Trial results (same day, task 1 skeptic replay, M5 Max)

Same prompt, worktree and diff as the loop's Opus run. Bench: `claude -p` in plan mode with `--tools Read,Grep,Glob,Bash`, auto-memory and attribution header off, no `--max-budget-usd` on local backends.

| Backend | Model | Wall | Turns | Verdict | Prefix reuse |
|---|---|---|---|---|---|
| Anthropic (in loop) | Claude Opus 5 | 178 s | 14 | OK, verified the host binary's hook schema | Anthropic cache: 422k read / 52k written |
| vllm-mlx 0.4.1 | Qwen3.8-27B-8bit | cut at 45 min | 4 | none | none (hybrid); 8 to 16 min per turn |
| vllm-mlx 0.4.1 batched | Qwen3-Coder-30B-A3B-8bit | 322 s | 8 | OK, rambling, verified nothing beyond the diff | partial (2.4k to 6.6k of 13k to 35k) |
| vllm-mlx 0.4.1 batched | Ornith-1.5-35B-A3B-8bit | 1048 s | 31 | none: thorough, never converged, final turn looped 13k tokens | none |
| Rapid-MLX 0.13.4 | Ornith-1.5-35B-A3B-8bit | 189 s | 12 | OK, near Opus quality (file:line checks of every task step) | none |
| Rapid-MLX + `--relocate-mid-conversation-system` | Ornith | 327 s | 19 | OK | none (flag does not cover the Anthropic route) |
| Rapid-MLX + folding proxy | Ornith | 161 s | 15 | correct review, ended via ExitPlanMode without the `VERDICT:` line | 10 hits; turns 3+ prefill 400 to 2,200 tokens |
| Rapid-MLX + folding proxy | Qwen3-Coder-Next-80B-A3B-6bit | 48 s | 7 | false refutation: claimed a test lacks the assertion it quotes, flagged unrelated code | hits from turn 3 |

Read of the table: Ornith on Rapid-MLX is the only local combination that matched Opus's verdict with Opus-grade evidence, and with the folding proxy it does so in Opus's wall time. Coder-Next is the fastest and the least trustworthy. Every row is n=1; run three replays per row before adopting one.

What broke prefix reuse, in order of discovery:

1. `--max-kv-size` selects a RotatingKVCache (non-trimmable). Drop it.
2. `--max-budget-usd` adds a `USD budget: $x/$y` line to the system prompt that changes every turn. Drop it for local backends.
3. Claude Code appends a `<total_tokens>N tokens left</total_tokens>` system-role message to `messages` every turn. Hoisting it into the leading system block (my first proxy, Rapid-MLX's default, and Rapid-MLX even with `--relocate-mid-conversation-system` on the Anthropic route) grows the system block by one line per turn and shifts everything after it. Folding it into the preceding user message keeps the prefix stable; that is the proxy's current behaviour.
4. Lazily loaded CLAUDE.md contents are appended to the system prompt after the first reads under a directory that has one: a one-off shift per directory, not per turn.
5. vllm-mlx renders tool-call history as `[Calling tool: …]` text unless the parser class declares `SUPPORTS_NATIVE_TOOL_FORMAT`; Ornith mimicked the text form after a few turns. `qwen` and `qwen3_xml` declare it, `qwen3_coder` (the CLI name) did not in this run. Rapid-MLX renders natively and the same model reviewed cleanly.

Side traffic seen on the local server: Claude Code's security monitor (a two-stage harm classifier, `<transcript>` plus `Respond with <severity>N</severity>`) runs on the small-fast model after Bash calls, 10 times in one run, 23k tokens each. Point `ANTHROPIC_SMALL_FAST_MODEL` at something tiny if it matters.

## Angle: OpenRouter instead of local

Separate Sonnet worker, same day. Verified vs remembered as marked inline.


All prices verified via OpenRouter model pages / Tavily search, September 2026 snapshot. Workload model: ~500k input tokens + ~15k output tokens per pass (midpoint of 10-20k), 14 growing-prefix requests. Cached-cost column assumes an 80%-cache-hit / 20%-fresh-input split — this ratio is not directly reported by OpenRouter, but it's what makes the math reproduce your own measured Opus 5 result ($0.99 with caching vs $2.875 computed at 0% cache), so I used it consistently across models rather than guessing separately per model.

### 1. Per-pass cost by model (OpenRouter, Sept 2026)

| Model | In/Out $/M | Cache read $/M | No-cache $/pass | Cached $/pass |
|---|---|---|---|---|
| Claude Opus 5 (Anthropic direct, reference) | $5/$25 | $0.50 (0.1x) | $2.88 | $1.08 (measured: $0.99) |
| Claude Sonnet 5 | $2/$10 | $0.20 | $1.15 | $0.43 |
| Claude Haiku 4.5 | $1/$5 | $0.10 | $0.58 | $0.22 |
| Qwen3.5-27B (dense, closest to "Qwen3.8-27B") | $0.195/$1.56 | not offered (dash in provider table) | $0.12 | same (no caching) |
| Qwen3-Coder-30B-A3B-Instruct | $0.07/$0.27 | ~$0.007 (Qwen uses explicit 0.1x `cache_control`) | $0.039 | $0.014 |
| Qwen3-Coder-480B-A35B (larger Qwen3-Coder) | $0.22/$1.80 | $0.10 (DeepInfra Turbo) | $0.14 | $0.089 |
| gpt-oss-120b | $0.03/$0.17 | $0.03 (= input, no real discount) | $0.018 | ~$0.018 |
| GLM-4.7 | $0.40/$1.75 | $0.08 (0.2x) | $0.23 | $0.098 |
| GLM-4.7-Flash (Air-class) | $0.06/$0.40 | $0.01 | $0.036 | $0.016 |
| Kimi K2.5 | $0.45/$2.25 | $0.07 | $0.26 | $0.107 |
| DeepSeek V3.2 | $0.209/$0.310 | ~$0.021-0.028 (0.1x, provider-stated) | $0.109 | $0.037 |
| MiniMax M2 | $0.255/$1.02 | unconfirmed on OpenRouter | $0.143 | not verified — treat as ≈no-cache |
| Ornith-1.5-35B-A3B | **not on OpenRouter's catalog** | n/a | n/a | n/a |

Ornith is a hobbyist agentic-coding fine-tune distributed on FriendliAI dedicated endpoints and run locally via llama.cpp (github.com/noonghunna/club-3090/discussions/480, Sept 2026); it does not appear in OpenRouter's model list.

Sources: openrouter.ai/qwen (Sept 2026 snapshot), openrouter.ai/z-ai/glm-4.7, openrouter.ai/moonshotai/kimi-k2.5, openrouter.ai/openai/gpt-oss-120b, openrouter.ai/qwen/qwen3.5-27b-20260224, openrouter.ai/qwen/qwen3-coder, pricepertoken.com/pricing-page/model/qwen-qwen3.5-27b, openrouter.ai/compare/deepseek/deepseek-v3.2/minimax/minimax-m2, openrouter.ai/anthropic/claude-haiku-4.5.

### 2. Claude Code → OpenRouter (verified, Sept 2026)

OpenRouter now exposes a native Anthropic-Messages-compatible endpoint ("Anthropic Skin") — set `ANTHROPIC_BASE_URL` to OpenRouter's API base and `ANTHROPIC_AUTH_TOKEN` to your OpenRouter key (`ANTHROPIC_API_KEY` must be explicitly empty or Claude Code falls back to your Anthropic login). **No proxy required** for this path — the older `claude-code-router`/`y-router`/LiteLLM proxies are now redundant for this use case (y-router's own README says "archived... OpenRouter now provides an official integration"). Docs: openrouter.ai/docs/cookbook/coding-agents/claude-code-integration; blog walkthrough: openrouter.ai/blog/tutorials/claude-code-openrouter (2026).

**Caveat that matters for your use case**: OpenRouter's own docs state the integration "is only guaranteed to work with the Anthropic first-party provider" and recommend setting Anthropic 1P as top-priority provider for maximum compatibility. Running *open* models (Qwen/GLM/Kimi/DeepSeek/MiniMax/gpt-oss) through Claude Code via this Anthropic-skin path is exactly the untested edge case — thinking-block passthrough and native tool-use are confirmed for Claude models routed through OpenRouter, not confirmed for third-party open models. Third-party summaries (ofox.ai, Sept 2026) report "some features like fine-grained tool streaming may be unavailable" on OpenRouter generally. Fast Mode is Anthropic-1P-only regardless.

### 3. Reliability notes (verified)

- **Prompt caching by provider** (openrouter.ai/docs/guides/best-practices/prompt-caching, Sept 2026): Anthropic 0.1x read/1.25x write (explicit); Alibaba Qwen 0.1x read/1.25x write (explicit `cache_control`, same as Anthropic); DeepSeek 0.1x read, automatic; most others (OpenAI-style, Gemini, Grok, Moonshot, Groq, Z.AI) auto-cache at 0.25-0.5x with no `cache_control` needed. Real-world reports (Cursor forum, GitHub issue #7479) show `cached_tokens` sometimes staying at 0 across turns even on nominally-supported models/providers — caching is real but not guaranteed to fire.
- **Provider/quantization variance**: OpenRouter explicitly warns some providers serve heavier-quantized variants of the same model that underperform; you can pin with `provider: {order: [...], allow_fallbacks: false}` or filter by `quantizations: ["fp16","bf16"]` to exclude int4/fp4 (openrouter.ai/blog/insights/model-routing; openrouter.ai/docs/guides/routing/provider-selection).
- **Rate limits are inherited from the upstream provider**, not from OpenRouter itself — a 429 on a given model/provider path reflects that provider's own RPM/TPM caps (requesty.ai, Jul 2026).
- Pinning is fully supported via `provider.order` + `allow_fallbacks: false`.

### 4. Local M5 Max baseline

- **Power**: independent Sept 2026 teardown (creativestrategies.com) measured brief GPU peaks ~80W and CPU peaks ~75-80W, with sustained CPU settling around 50W; notebookcheck's Cinebench 2024 multi-core stress test measured **117.5W sustained** system draw on the 16" M5 Max. Idle is ~7W. Your 90W estimate sits between "typical mixed inference load" and "full stress" — plausible but on the low side if both CPU+GPU are pegged; electricity cost is trivial either way: 90W × 1.4h ≈ 0.13 kWh ≈ **$0.02-0.03/pass** at ~$0.17-0.20/kWh (remembered US-average rate, not verified for your specific utility).
- **Wall time**: HN thread (Sept 2026, ycombinator.com/item?id=48721903) and a benchmarking writeup (note.com/jujube) confirm a **dense** 27B-class Qwen model runs 5-13 tok/s generation and takes tens of seconds to over a minute just on prompt processing for a few-thousand-token prompt without cache reuse — consistent with your stated 4-8 min/turn; MoE models (Qwen3-Coder-30B-A3B, GLM-Air, gpt-oss-120b class) were 5-10x faster (33-51 tok/s gen, prompt processing 3.7s vs 21s for equivalent-length prompts) because only ~3B parameters activate per token.
- **Prefix-cache fragility**: a documented llama.cpp/Claude Code interaction (mykolaaleksandrov.dev, 2026) shows Claude Code's per-request attribution header changes the prompt prefix byte-for-byte each turn, silently breaking local KV-cache reuse unless `CLAUDE_CODE_ATTRIBUTION_HEADER=0` is set — the same failure mode that would erase most of the benefit of a local dense model in your loop unless addressed.

### Summary table

| Option | $/pass | Wall time/pass | Needs proxy? | Prompt caching? | Verdict (5 words) |
|---|---|---|---|---|---|
| Claude Opus 5 (Anthropic direct) | $0.99-2.88 | ~3 min | No | Yes, native | Best quality, priciest baseline |
| OpenRouter DeepSeek V3.2 | $0.04-0.11 | ~2-4 min | No | Yes (0.1x) | Cheapest strong-quality open option |
| OpenRouter Qwen3-Coder-30B-A3B | $0.014-0.039 | ~2-4 min | No | Yes (Qwen 0.1x) | Near-free, coding-tuned, compat unverified |
| OpenRouter GLM-4.7 | $0.10-0.23 | ~2-4 min | No | Yes (0.2x) | Solid mid-tier agentic reviewer |
| OpenRouter gpt-oss-120b | ~$0.018 | ~2-4 min | No | No real discount | Dirt cheap, caching doesn't help |
| Local M5 Max (dense 27B) | ~$0.02-0.03 elec. | 60-140 min | No (no proxy, no net) | Cache reuse fragile w/ Claude Code | Free-ish but painfully slow |

Every OpenRouter row assumes the Anthropic-skin direct connection works for that model's tool-calling — unverified for non-Anthropic models specifically, per OpenRouter's own compatibility caveat above.