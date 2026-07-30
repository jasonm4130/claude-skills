# Positive writing systems for agent prose — primary sources and LLM-transfer evidence

*Deep-dive research, 2026-07-30. Sourced via the `deep-dive` fanout workflow (3 angles, Sonnet workers, tier-1 blind verification). Reliability: reader-expectation **high**, artifact-structure **high**, llm-transfer **medium**. Companion to RESEARCH_concise-output.md (2026-07-17), which covers reply-length control; this covers durable-artifact prose. Preceded by an STE/anti-slop survey (same day, session-local): woosal1337's STE skill experiment, petergyang/no-ai-slop, yzhao062/agent-style.*

## Question

What are the precise, codifiable formulations of the positive writing systems (Gopen & Swan reader-expectation, classic style, Diátaxis, plain language), and what does the evidence say about using positive systems vs. negative rule-lists as LLM writing instructions?

## The one complication that changes the design

The clean story "positive beats negative" is **not** what the controlled evidence says. Three studies, three different axes:

1. **Zhang et al. 2026 (arXiv:2604.11088, "Guardrails Beat Guidance in Coding Agents")** — 25,532 rules, 5,000+ Opus 4.6 SWE-bench runs: negative constraints ("do not refactor unrelated code") were the only individually beneficial rule type; **positive directives ("follow code style") actively hurt** task performance. But this measures *coding-task behavior*, not prose quality. (Caveat from verification: the "+7–14pp" range circulating for this paper couldn't be confirmed from the abstract, which states +13.8pp on a discriminative subset.)
2. **Bohr 2025 (arXiv:2511.13972, "Show and Tell")** — for *style* control across turns: directive instructions held their effect at turn 2 while few-shot examples drifted badly. Instructions > examples for style durability. (Axis: instruction-vs-example, not positive-vs-negative.)
3. **arXiv:2601.08070 (mechanistic)** — word-level bans backfire: in 87.5% of violations, naming the forbidden word primed the model to produce it (activation patching, layers 23–27). Ban *words* and you advertise them.

**Reconciliation:** the axis that matters is not positive-vs-negative polarity but *what the rule targets*. Word-level bans fail mechanistically. Behavioral don'ts (scoped, structural) work. Style is best carried by a directive **system** — a model of the reader plus positional/structural principles — which is "positive" in the sense of supplying a target, not in the sense of avoiding the word "not". No study directly tests classic-style/Gopen & Swan prompts against ban-lists for prose quality — that's an evidence gap; the practitioner evidence (below) is anecdotal.

Practitioner data points: Jesse Vincent fed Strunk's full Elements of Style (~12k tokens) before README drafting → "about 30% shorter and I like the style more" (blog.fsck.com 2025-10-13; single anecdote, later packaged as the obra/the-elements-of-style plugin — the same one data point cited twice). Diátaxis exists as several unvalidated community Claude skills (keithpatton, afsharalex, stichbury). woosal1337's STE experiment: any coherent system halved lint-scored slop; the ban-list barely moved it (−3% on Claude).

## The codified spine (verified primary-source formulations)

### Gopen & Swan, "The Science of Scientific Writing" (American Scientist 78(6), 1990)

Verified verbatim against the full text (usenix.org mirror 403'd; confirmed via faculty.washington.edu mirror). Their closing seven principles:

1. "Follow a grammatical subject as soon as possible with its verb."
2. "Place in the stress position the 'new information' you want the reader to emphasize." ("Readers naturally emphasize the material that arrives at the end of a sentence. We refer to that location as a 'stress position.'")
3. "Place the person or thing whose 'story' a sentence is telling **at the beginning of the sentence**, in the topic position." (Bolded phrase was dropped in first-pass research; restored per verifier.)
4. "Place appropriate 'old information' (material already stated in the discourse) in the topic position for linkage backward and contextualization forward."
5. "Articulate the action of every clause or sentence in its verb."
6. "In general, provide context for your reader before asking that reader to consider anything new."
7. "In general, try to ensure that the relative emphases of the substance coincide with the relative expectations for emphasis raised by the structure."

Plus: "Each unit of discourse, no matter what the size, is expected to serve a single function, to make a single point" — where a unit is "anything with a beginning and an end: a clause, a sentence, a section, an article." And their diagnosis: "the misplacement of old and new information turns out to be the No. 1 problem in American professional writing."

### Classic style (Thomas & Turner; Pinker, Sense of Style ch. 2)

Verified against classicprose.com (the authors' companion site — single-source but authorial): "the writer is competent and assured, the motive is truth, the purpose is presentation, prose is a window, the occasion is informal, and the model scene is conversation between equals"; the reader "is in a position to verify [the observations] by direct observation." Pinker's curse of knowledge (verified excerpt): "It simply doesn't occur to the writer that her readers don't know what she knows." *Caveat: the two Pinker "window/agent" chapter quotes came from a reading-notes site that 403'd on re-fetch — treat those two as plausible-but-unconfirmed; the stance is independently established by the Thomas & Turner quotes.*

### Diátaxis (diataxis.fr, all quotes verified)

Four types from a 2×2 (action/cognition × acquisition/application): tutorial (study, a lesson), how-to (work, steps to a goal), reference (facts, consulted while working), explanation (understanding, read away from the work). Compass: "action or cognition? acquisition or application?" Core rule: each piece of content "has one particular job to do"; when types mix they "bleed into each other," worst case "a complete or partial collapse of tutorials and how-to guides into each other, making it impossible to meet the needs served by either." The while-working test for reference vs explanation: would someone turn to this while executing a task, or after stepping away to think?

Limits: no official guidance for READMEs/ADRs/PR descriptions (third-party extensions only, e.g. gavindidrichsen/diataxis with 9 types); community critiques say it's abstract, drifts under many contributors, and its own docs don't follow it; the maintainer explicitly warns against creating empty four-section scaffolds ("Don't do that. It's horrible."). Apply as a compass, not a filing system.

### Plain language (digital.gov / archives.gov, verified)

"The first rule of plain language is: write for your audience." "Start by stating your purpose and the bottom line... Put the most important information at the beginning. Include background information (when necessary) toward the end." "General first. Exceptions, conditions, and specialized information later." Hidden verbs (nominalizations: -ment/-tion/-sion/-ance, or paired with make/take/give/have/reach/achieve/effect) → uncover the verb. Mechanical rules (active voice, nominalizations, topic sentences) are codifiable; audience analysis is judgment guided by questions ("Who is my audience? What do they already know? What questions will they have?") — that split is our inference, the source doesn't rank its own rules.

## Design conclusions (what this repo/dotfiles adopted or should adopt)

Two problems, two artifacts, one shared spine:

1. **Agent replies (global AGENTS.md/CLAUDE.md):** already governed by "length is selection, not compression." Add the spine compactly (reader model + actor-as-subject/action-as-verb + known-before-new); do not duplicate artifact rules there.
2. **Durable artifacts (a `writing-artifacts` skill, on-demand):** document layer = Diátaxis compass + plain-language front-loading; paragraph layer = one point per unit, point first; sentence layer = Gopen & Swan's seven; strict STE-style mode reserved for procedures/runbooks/error messages. Verification by optional deterministic lint (agent-style CLI or woosal's ste-lint.py) as a check, not as the system.
3. **Phrasing rule for skill authors:** target structures, not words (word-bans prime); carry style with a positive system; keep negative constraints for scoped behavioral anti-patterns.

## Sources

**reader-expectation:** Gopen & Swan 1990 (usenix.org PDF, cited; verified via faculty.washington.edu mirror) · classicprose.com/csx.html and /thinking.html · barnsworthburning.net Pinker excerpt · APS Observer 2015-07-30 (Pinker interview) · notes.chughkabir.com (unreachable on verify, 403).
**artifact-structure:** diataxis.fr (start-here, compass, map, tutorials-how-to, reference-explanation, how-to-use-diataxis) · digital.gov plain-language guides (2025-09) · archives.gov Top 10 Principles · HN 36610846 · emmanuelbernard.com 2024-12-19 · ekline.io 2026-03-17 (Python-community attribution unverified).
**llm-transfer:** blog.fsck.com 2025-10-13 · lysenko.dev 2026-04-01 · arXiv:2604.11088 (Zhang et al. 2026) · arXiv:2511.13972 (Bohr 2025) · arXiv:2601.08070 · github.com/yzhao062/agent-style · Diátaxis skills: keithpatton, afsharalex, stichbury, lilliangreenberg.
**Prior session context:** github.com/woosal1337/blog ep01 (STE skill + experiment) · github.com/petergyang/no-ai-slop · asd-ste100.org.
