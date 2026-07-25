# Keeping coding-agent output concise — what's evidence-backed vs folklore

*Deep-dive research, 2026-07-17. Sourced via the `deep-dive` fanout workflow (4 angles, Sonnet workers, tier-1 blind verification). Reliability per angle: evidence **high**, api-controls **high**, prompts **medium**, actionable **medium**.*

## Question

How do best-in-class coding agents / LLM setups keep model output concise? Which techniques are measured to work vs. prompt-engineering folklore — and which are encodable in a persistent instructions file (CLAUDE.md/AGENTS.md) or a Claude Code output-style?

## TL;DR verdict

- **"Demonstration beats instruction" is mostly folklore *for length control.*** The one controlled head-to-head (ACL Findings 2025, "Brevity") found a prose *directive* cut length up to **88% while improving quality**, while **10-shot in-context length examples gave ~zero reduction — sometimes longer output** ("some models fail to understand the desired output length from examples").
- Two axes were being conflated:
  - **Positive vs negative framing** — Anthropic's own Opus 4.8 docs: *"Positive examples … tend to be more effective than negative examples or instructions that tell the model what not to do."* (Show the good, don't only forbid the bad.)
  - **Few-shot demonstration vs prose directive** — the directive wins for length. These are not the same claim.
- **Only engineered/structural controls are precise:** API verbosity params (GPT-5), effort params (Anthropic), countdown-marker scaffolding (>95% strict-length compliance vs <30% for naive numeric instructions). Most are **not** CLAUDE.md-settable.
- **Rigid numeric line budgets are unreliable** — SOTA models hit exact caps <30% of the time, and **Anthropic walked back its own** "MUST … fewer than 4 lines" to "generally less than 4 lines" (Claude Code 2.0).

## Evidence-backed vs folklore

| Technique | Verdict | Basis |
|---|---|---|
| Directive, positively-framed, **selective-content** ("lead with the outcome; keep only what changes what the reader does next") | ✅ Backed | Anthropic Fable-5 guide; Brevity 88% cut |
| **Separate reasoning from visible output** (thinking / effort) | ✅ Backed | Extended-thinking + effort docs; "still charged for full thinking tokens — omitting reduces latency, not cost" |
| **Don't-recap / let tool output speak** | ✅ Backed | Universal across shipping prompts: Claude Code "just stop"; Cursor `summary_spec`; Codex "findings must be primary" |
| Banned-opener / no-preamble lists | ⚠️ Real but partial | Encodable & widely shipped, but pair the ban with the positive version, not ban-only |
| Hard numeric line budgets ("fewer than N lines") | ❌ Unreliable | <30% exact-cap compliance; Anthropic softened its own rule |
| Few-shot terse example pairs for length | ❌ Weak/folklore | 10-shot examples ≈ zero effect vs directives (Brevity); CLAUDE.md isn't real multi-turn history |
| API verbosity / effort parameters | ✅ Backed, but not prose-settable | GPT-5 `verbosity` low/med/high scales tokens ~linearly (560→849→1288); Anthropic `effort` low→max |

## What shipping agents actually do

Verbatim quotes are real, but mostly from **leak repos** (single-source, vendor-unconfirmed) — except **Codex CLI** and **Aider**, which are open-source official. Representative:

- **Claude Code** (leaked): hard budget ("MUST answer concisely with fewer than 4 lines … One word answers are best"); verbatim few-shot pairs ("2+2 → 4", "is 11 prime? → Yes"); no-preamble/postamble; "After working on a file, just stop." **Anthropic later softened all of these** (the mikhail.io CC 2.0 diff — the single strongest-evidenced item: `MUST` → `should`).
- **OpenAI Codex CLI** (official, live repo): "Default: be very concise"; "Don't dump large files … reference paths only"; "Findings must be the primary focus … change-summary only as a secondary detail."
- **Cursor** (leaked): explicit code-vs-chat split ("Write HIGH-VERBOSITY code, even if you have been asked to communicate concisely with the user"); `summary_spec` bans postamble padding.
- **Cline** (mid-2025 prompt): banned-opener list ("STRICTLY FORBIDDEN from starting … Great/Certainly/Okay/Sure"). *Caveat: the "live main branch" citation was stale — repo restructured; quotes authentic to mid-2025, not current.*
- **Aider** (official): "Be concise in your replies"; `overeager_prompt`: "Do what they ask, but no more."

**Meta-lesson:** rigid rules get walked back as models improve; the frontier trends toward trusting the model's own length calibration + light directive steering.

## Structural finding: output-style > CLAUDE.md (for Claude Code)

An output-style edits the **system prompt** directly and is always-on; CLAUDE.md is appended as a **per-turn user message** (Anthropic's own comparison table — mechanism verified; "therefore stronger" is reasonable inference, not their stated ranking). **Caveat:** a custom output style defaults to `keep-coding-instructions: false`, which strips built-in engineering behavior (scope/comments/verify) unless set `true`. Note also: output-styles are **Claude-Code-only** — a tool-agnostic AGENTS.md rule is the right home for cross-tool (Codex/Gemini) consistency.

## Verification caveats (from the tier-1 pass)

- LC-AlpacaEval gameability figure is **25%→10% std-dev**, not "26%" as first drafted (headline 0.94→0.98 Spearman is exact).
- The "output-style is architecturally stronger than CLAUDE.md" and "strips conciseness behavior" claims are **inference**, not stated by Anthropic docs.
- `effortLevel` in settings.json is reported (#45453) to not apply on startup (defaults to medium) — but that issue is closed-as-duplicate, not live-open.

## Recommendation (what to actually change)

Cross-tool (AGENTS.md), one added principle, positively framed:

> **Length is selection, not compression.** Lead with the outcome; keep only what changes what the reader does next; cut the rest. Don't pad to sound thorough, and don't crush into fragments/jargon to sound brief — readable beats short. Prefer this over fixed line-counts, which models obey unreliably.

Keep existing banned-openers + no-recap rules (they're real and encodable). Optional Claude-Code-only booster: a `concise` output-style with `keep-coding-instructions: true`.

## Sources (grouped, most load-bearing first)

**evidence (high):** Brevity/ACL 2025 `arxiv.org/abs/2506.08686`; Anthropic Opus-4.8 & Fable-5 prompting docs; Singhal 2023 `arxiv.org/abs/2310.03716`; LMSYS style-control `lmsys.org/blog/2024-08-28-style-control`; LC-AlpacaEval `arxiv.org/abs/2404.04475`; Yuan/Meta LIFT-DPO `arxiv.org/pdf/2406.17744`; countdown-marker `arxiv.org/pdf/2508.13805`.
**api-controls (high):** GPT-5 params (OpenAI Cookbook); Anthropic effort + extended-thinking + reduce-latency docs.
**actionable (medium):** Claude Code output-styles / best-practices docs; community `concise.md` / caveman-output-style; issue #45453.
**prompts (medium):** Codex CLI `gpt_5_codex_prompt.md` (official); Aider prompts (official); Claude Code / Cursor / Bolt leaks (caveated); mikhail.io CC 2.0 diff.
