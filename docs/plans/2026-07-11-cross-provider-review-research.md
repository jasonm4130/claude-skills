# Cross-provider LLM code review — deep-dive research

**Date:** 2026-07-11
**Question:** Does having a different model provider review work (e.g., GPT reviewing Claude-written code) measurably improve outcomes vs same-model self-review — and is it worth building a skill + buying a GPT subscription? What tier?
**Method:** deep-dive fanout (4 Sonnet research angles, blind tier-1 verification per angle). All angles returned `reliability: medium`; verification corrections are folded in below and flagged inline.

---

## Recommendation (TL;DR)

**Yes, wire it up — but don't build much and don't buy much.**

1. **Don't write a skill from scratch.** OpenAI ships an official first-party Claude Code plugin — [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) — with `/codex:review` and `/codex:adversarial-review`, installed via `/plugin marketplace add openai/codex-plugin-cc`. It wraps the locally-authenticated Codex CLI. If we want cross-provider review inside our own pipelines (SDD review stage, code-review flow), a *thin* skill wrapping `codex review --uncommitted/--base` or `codex exec --json --output-schema` is a half-day job, not a project.
2. **Access route: API key, not a subscription.** At a few reviews/day on few-hundred-to-few-thousand-line diffs, pay-per-token is ~US$3–15/month (verifier-recomputed: $0.01–$0.34/review depending on tier). ChatGPT Plus ($20/mo) only wins if you'd also use ChatGPT/Codex for other things. Pro ($100/$200) is unambiguously overkill — Plus's lowest Codex allowance (15 messages/5h on the top model) already covers this workload.
3. **Model tier: mid-tier (gpt-5.6-terra), medium reasoning effort.** Codex's own docs position Terra as the default for code review; the (limited) academic evidence says review quality does not scale with model tier the way generation does. Escalate to Sol per-review only when a diff is genuinely hard.
4. **Set expectations: the cross-provider premise is weaker than the folk wisdom.** The evidence supports *independent review passes* strongly, *cross-provider specifically* only weakly. Treat GPT review as a cheap decorrelated second opinion layered on the existing review stack, not a replacement for it. The two levers the evidence actually screams about: **keep diffs small** (dominant predictor of review quality) and **use adversarial framing** (counters the provider-agnostic agreeableness bias) — both already present in this repo's practices.

---

## Angle 1 — Evidence: does cross-provider review actually help?

### What's solid

- **Self-preference bias is real and well-replicated.** Panickssery, Bowman & Feng (NeurIPS 2024) show LLM evaluators recognize and favor their own generations; bias strength correlates with self-recognition capability (Kendall's τ up to 0.82, fine-tuned condition). GPT-4's unambiguous self-preference: 0.593 for own output vs 0.18 for another model's. *(Verifier: every number confirmed verbatim against the primary source — strongest-sourced claim in the set.)*
- **Harmful self-preference grows with capability.** Chen et al. 2025 ("Do LLM Evaluators Prefer Themselves for a Reason?"): when the judge's own answer is objectively wrong and the alternative right, Qwen2.5-72B still prefers its own 86% of the time (MATH500) — far above its 55% baseline self-preference. Stronger models show *more* harmful self-preference, not less. *(Verified verbatim; note: single arXiv preprint, no peer-review venue.)*
- **Same-family "preference leakage" exists even without literal self-review.** Judges favor outputs from models related to themselves (same family / distilled lineage) by up to ~28pp win-rate skew (arXiv 2502.01534).
- **Both vendors do it.** GPT-4o *and* Claude 3.5 Sonnet systematically over-score their own outputs vs expert-human-anchored independent judgment (arXiv 2508.06709). Self-bias is not a one-vendor problem.
- **The dominant failure mode is provider-agnostic agreeableness.** Across 14 SOTA judges on a code task: >96% true-positive rate approving valid code, **<25% true-negative rate catching buggy code** (arXiv 2510.11822). *(Verifier: numbers confirmed; the "this is an RLHF property" framing was the researcher's gloss, not the paper's claim.)* Crossing providers does not fix a reviewer that approves almost everything — adversarial prompting and review structure do more.

### What the verifier killed (the load-bearing correction)

The research pass cited SWR-Bench (arXiv 2509.01494, 1,000-PR review benchmark) as showing multi-model review beats single-model review by **+43.67% F1**. The verifier re-fetched the paper: **that number is the *Self-Agg* result — the same model run 10 times and aggregated** (Gemini-2.5-Flash, F1 19.38%→21.91%). The paper reports that *both* same-model ensembles and cross-model aggregation help, but the headline figure belongs to the same-model ensemble, which was the best configuration overall. **Verdict: unsupported as cross-provider evidence — if anything it suggests repeated independent sampling from one model matches or beats cross-model diversity.**

### Honest read

- The self-preference literature is mostly about *comparative judging* (pick A vs B, score my answer). A code review — "find bugs in this diff" — is a different task shape where the self-recognition mechanism is weaker. The best mechanistic argument for crossing providers in review is Wataoka et al.'s perplexity hypothesis (judges under-flag text that feels familiar), which implies an author-model reviewing its own diff may under-catch its own idiom-level bugs — plausible, unquantified for review.
- **No controlled study directly measures GPT-reviews-Claude vs Claude-reviews-Claude bug-catch rates.** Practitioner reports (MindStudio, Zylos, the proposer–checker skill READMEs) all favor cross-vendor review but none run a controlled comparison; two are vendor content.
- CriticGPT (OpenAI 2024) is instructive in the other direction: a *same-family* critic beat plain self-review — but only after specialized fine-tuning on inserted bugs. Plain same-model self-critique was the weak baseline. Independent-critic *structure* did the work.
- Anthropic's own shipped Code Review feature (March 2026) uses same-provider multi-agent review; third-party analysis (CodeAnt) calls the self-review problem "architecturally real but partially mitigated by the multi-agent design."
- Curio: in an adversarial-incentive NeurIPS 2025 workshop study, models across GPT/Gemini/Claude families showed collusion-like reviewer selection — cross-provider review is not automatically adversarially robust. (Marginal relevance to benign review.)

**Bottom line:** independent review passes: strong evidence. Multiple aggregated reviews: strong evidence (but same-model ensembles work too). Cross-provider *specifically*: plausible, decorrelated-blind-spots argument, thin controlled evidence. Cheap to do, so worth doing — with calibrated expectations.

## Angle 2 — Integration mechanics

- **`codex exec`** is the documented headless entry point: progress → stderr, final message → stdout; `--json` gives a JSONL event stream; `--output-schema <file>` forces a JSON-Schema-conformant verdict; `-o` writes the final message to a file. No dedicated diff flag — pipe via stdin (`git diff | codex exec "review this"`; *note: the piped-diff pattern is real but that exact example was the researcher's construction, not a doc quote*).
- **`codex review`** is a purpose-built non-interactive review subcommand: exactly one of `--uncommitted`, `--base <ref>`, `--commit <sha>`, or a custom prompt. *(Verified verbatim against the CLI reference.)*
- **Auth:** two methods — ChatGPT-subscription OAuth or API key. `codex exec` reuses cached auth from `~/.codex/auth.json`, so subscription auth works headless after one interactive `codex login` (device-code fallback exists for headless boxes). For API-key auth: `CODEX_API_KEY=... codex exec ...` (exec-only) or `printenv OPENAI_API_KEY | codex login --with-api-key` to persist. **Codex ignores plain `OPENAI_API_KEY`** — confirmed by an OpenAI engineer on issue #20099. *(Verified verbatim from the issue.)*
- **Prior art (don't rebuild):**
  - `openai/codex-plugin-cc` — **official OpenAI plugin for Claude Code**: `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:transfer`, status/result/cancel. Requires "ChatGPT subscription (incl. Free) or OpenAI API key." *(Verifier pulled the README via `gh api` — every detail confirmed verbatim.)*
  - `Arystos/skill-codex` — community MCP bridge, subscription-first, adds a PostToolUse auto-review hook.
  - `lucas-lima-s/claude-codex-skill` — seven modes with per-mode reasoning-effort/sandbox/timeout presets (its `verify` mode: medium reasoning, read-only sandbox, 180s, reviews a git diff) — a good design reference if we write our own thin wrapper.
  - `adampaulwalker/codex-claude-skill` — explicit proposer–checker loop (Claude implements, Codex reviews until approval).
  - `yigitkonur/codex-bridge` — heavyweight variant (job tracking, worktree isolation, gated merge); its own README says the official plugin "is still the clean default."

## Angle 3 — Cost

Landscape shifted **yesterday** (2026-07-10): GPT-5.6 launched (Sol/Terra/Luna); `gpt-5.2`/`gpt-5.3-codex` are deprecated inside Codex — don't hardcode old model names.

- **API pricing (per 1M tokens, in/out):** Sol $5/$30 · Terra $2.50/$15 · Luna $1/$6. *(Verified on OpenAI's pricing page. The research pass's GPT-5.1/GPT-5 rows and the "$6.25 priority input" figure were flagged unsupported/wrong by the verifier — Sol priority input is $10 — but neither affects the recommendation.)*
- **Per-review cost** (5k–50k input + 1–3k output tokens; verifier independently recomputed and matched): Luna ~$0.01–0.07 · Terra ~$0.03–0.17 · Sol ~$0.06–0.34. At 3–5 reviews/day → roughly **$3–15/month on Terra/Luna via API**.
- **Codex allowances by plan** (local messages per rolling 5h, plus unpublished weekly caps; verified verbatim on the pricing page): Plus $20/mo — Sol 15–90, Terra 20–110, Luna 50–280. Pro now splits into $100/mo (5× Plus) and $200/mo (20× Plus, 1M context). Business ≈ Plus per seat. Top-up credits purchasable without upgrading; `/status` in Codex CLI shows live remaining allowance.
- **Caveats:** one review ≠ necessarily one "local message" if the review runs multi-turn/agentic — the rate-limit comparison is a proxy. The official plugin's "incl. Free" claim is verbatim-real but Free-tier allowance size is unverified — assume it won't sustain daily reviews.

**Route call:** API key wins on pure cost at this workload. Plus only if ChatGPT/Codex would get other use. Pro: no.

## Angle 4 — Model tier needed

- SWE-bench team's independent eval *(verifier correction: not "OpenAI's own" as the research pass claimed)*: GPT-5-mini gave up only ~5pp vs full GPT-5 at ~1/5th cost; nano trades too much.
- "Bigger Isn't Always Better" (arXiv 2606.15689, June 2026) — the only study testing *review* rather than generation: cheap-tier models matched or beat bigger siblings on review F1/recall. *(Verifier: the Claude Haiku 4.5 > Claude Sonnet 4.6 half is strongly supported — F1 0.365 vs 0.343, 3.2× cheaper, replicated on the Martian benchmark; the GPT-5.4-mini half could not be verified in the accessible text.)*
- Same study's sobering headline: **every model collapsed on real-world PRs** (best F1 0.847 on synthetic bugs → 0.066 on real PRs), and **diff size — not model tier — was the dominant predictor** (F1 ~15× worse on >150-line diffs vs <10-line). *(Single-model figures verified; the "every model, three conditions" universality rests on unverified search synthesis.)* Keep review diffs small; no subscription tier compensates for a 2,000-line diff.
- OpenAI's guidance: default **medium** reasoning effort, escalate only on measured gains *(verified)*; the claim that low effort "performs especially well on coding" could not be corroborated on any OpenAI page — ignore it. Codex docs position **gpt-5.6-terra** as the everyday default for code review.
- Counterpoint: OpenAI's own highest-stakes bug-finder (Aardvark/Codex Security) runs full-frontier GPT-5 — for security-critical hunting, frontier tier is their revealed preference. For routine diff review, mid-tier is the evidence-backed choice. Also GPT-5.1 (general) matched GPT-5.1-Codex on bug-finding in one practitioner head-to-head — "Codex-branded" isn't automatically better.

## Contradictions & open questions

1. **The strongest quantified "multi-model wins" stat is actually a same-model ensemble result** (SWR-Bench Self-Agg). The direct GPT-reviews-Claude vs Claude-reviews-Claude comparison remains unmeasured in controlled settings — the core folk wisdom is running ahead of the evidence.
2. Self-preference bias (judging) vs review blind spots (bug-finding) are different mechanisms; the literature mostly measures the former.
3. Agreeableness bias (approving bad code, TNR <25%) dwarfs the provider question — review *structure* (adversarial framing, forced-verdict schemas, small diffs) matters more than reviewer *brand*.
4. Unverified: Free-tier Codex allowance; whether a multi-turn Codex review consumes 1 or several rate-limit "messages"; GPT-5.4-mini's specific review scores.

## Suggested next step (if building)

Install `openai/codex-plugin-cc` and trial `/codex:adversarial-review` on a few real branches for a couple of weeks with an API key (`codex login --with-api-key`, default model Terra, medium effort). If the verdicts add non-duplicate findings over the existing `/code-review` + adversarial-agents stack, then fold a thin `codex review --base` call into the SDD review stage as an extra reviewer whose findings merge into the existing verify pipeline. Decision gate: does Codex surface ≥1 confirmed finding per ~5 reviews that the Claude stack missed? If not, drop it — the evidence says diff hygiene and adversarial structure were the real levers all along.

---

## Sources

### Evidence angle
- https://arxiv.org/abs/2404.13076 — LLM Evaluators Recognize and Favor Their Own Generations (NeurIPS 2024) — 2024-04
- https://arxiv.org/html/2504.03846v2 — Do LLM Evaluators Prefer Themselves for a Reason? — 2025-04
- https://arxiv.org/abs/2410.21819 — Self-Preference Bias in LLM-as-a-Judge (NeurIPS 2024 SafeGenAI wksp) — 2024-10
- https://aclanthology.org/2025.emnlp-main.86.pdf — Beyond the Surface: Measuring Self-Preference (EMNLP 2025) — 2025
- https://arxiv.org/html/2508.06709v1 — Play Favorites: Measuring Self-Bias in LLM-as-a-Judge — 2025-08
- https://openai.com/index/finding-gpt4s-mistakes-with-gpt-4 — CriticGPT (verified via arXiv 2407.00215) — 2024-06
- https://arxiv.org/abs/2510.11822 — Beyond Consensus: Agreeableness Bias in LLM Judges — 2025-10
- https://neurips.cc/virtual/2025/128054 — Coordination and Collusion in Multi-Agent LLM Code Reviews — 2025-12
- https://arxiv.org/html/2406.07791v9 — Judging the Judges: Position Bias — 2024-06
- https://arxiv.org/abs/2502.01534 — Preference Leakage — 2025-02
- https://arxiv.org/abs/2509.01494 — SWR-Bench — 2025-09 *(verifier: +43.67% is Self-Agg, not cross-model)*
- https://www.mindstudio.ai/blog/cross-vendor-ai-agent-review-claude-codex — MindStudio (vendor content) — 2026
- https://zylos.ai/research/2026-03-01-multi-model-ai-code-review-convergence — Zylos Research — 2026-03
- https://www.codeant.ai/blogs/anthropic-claude-code-review — CodeAnt on Anthropic Code Review — 2026

### Integration angle
- https://developers.openai.com/codex/noninteractive — Codex non-interactive mode (official)
- https://developers.openai.com/codex/cli/reference.md — Codex CLI reference (official)
- https://developers.openai.com/codex/auth — Codex authentication (official)
- https://github.com/openai/codex/issues/20099 — OPENAI_API_KEY not read; CODEX_API_KEY for exec — 2026-04
- https://github.com/openai/codex-plugin-cc — official Claude Code plugin — 2026-03
- https://github.com/Arystos/skill-codex — community MCP bridge — 2026-03
- https://github.com/lucas-lima-s/claude-codex-skill — community skill, per-mode presets — 2026-04
- https://github.com/adampaulwalker/codex-claude-skill — proposer–checker loop — 2026-01
- https://github.com/yigitkonur/codex-bridge — heavyweight bridge — n.d.
- https://codex.danielvaughan.com/2026/06/12/codex-cli-exit-codes-error-handling-resilient-shell-scripts-ci-pipeline-automation/ — exit codes (unofficial, single-source) — 2026-06

### Cost angle
- https://learn.chatgpt.com/docs/pricing — ChatGPT/Codex plan limits & credits (official) — fetched 2026-07-11
- https://developers.openai.com/api/docs/pricing — OpenAI API pricing (official) — fetched 2026-07-11
- https://openai.com/index/gpt-5-6/ — GPT-5.6 launch — 2026-07-10
- https://apidog.com/blog/gpt-5-6-codex/ — GPT-5.6 in Codex, deprecations — 2026-07-10
- https://www.cloudzero.com/blog/how-much-does-chatgpt-cost/ — plan-tier roundup (partially stale) — 2026-04

### Tier angle
- https://www.swebench.com/post-250808-gpt5.html — SWE-bench team GPT-5/mini/nano eval (independent, not OpenAI's) — 2025-08
- https://arxiv.org/html/2606.15689v1 — Bigger Isn't Always Better: LLMs for Automated Code Review — 2026-06
- https://developers.openai.com/api/docs/guides/latest-model — reasoning-effort guidance (page drifts in place) — 2026
- https://openai.com/index/gpt-5-1-codex-max/ — Codex-Max launch (verified via secondary corroboration; direct fetch 403) — 2025-11
- https://openai.com/index/introducing-aardvark — Aardvark/Codex Security — 2025-10, upd. 2026-03
- https://www.codeant.ai/blogs/gpt-5-1-vs-gpt-5-1-codex — GPT-5.1 vs Codex head-to-head (practitioner) — 2026-07
