# Audit Backlog, Part 2: Docs and Retirement Implementation Plan

**Goal:** make every shipped document describe the repo as it is after the 2026-09-05 retirements and the Go move, fold the two research and two plan directories into one each, and get the plugin manifests clean under `claude plugin validate --strict`.
**Architecture:** one pull request per plugin (or per repo-wide sweep). Prose edits only, except where a repo-level test pins the old layout — those tests are edited where shown. `scripts/repo-consistency.test.mjs` is the verifier for every citation move: a shipped file may cite a repo path only as a `https://github.com/jasonm4130/claude-skills/blob/main/…` link, and every such link must resolve.
**Tech Stack:** Markdown, JSON, Node 24 `node --test`, `scripts/bump-plugin.mjs`, `claude plugin validate`.

## Global Constraints
- Any change under `plugins/<name>/` outside `README.md`, `CLAUDE.md`, `tests/` MUST be followed by `node scripts/bump-plugin.mjs <name> patch` before the commit. Bumping for a docs-only change is harmless.
- `bash scripts/check` must end with `CHECK OK` before every commit; `node --test scripts/repo-consistency.test.mjs` must pass in every task.
- Do not edit `.github/`, `.claude/`, `loop/`, or `scripts/` unless the task names the file. Never delete a test.
- Stage only the paths the task names; `git status --short` must show nothing else modified before the commit (the loop works in a fresh worktree, so anything unexpected is the task's own stray edit).
- A plugin-root `CLAUDE.md` must end each task at or under 200 lines (`wc -l`); it is loaded as project context for the maintainer and the claude-md-guard budget is 200.
- Commit messages say why and end with the line `Claude-Session: nightshift`.

### Task 1: one research directory, one specs directory, one plans directory

**Files:**
- Move (with `git mv`): every `docs/superpowers/specs/*.md` → `docs/specs/`; every `docs/superpowers/plans/*.md` → `docs/plans/`; then `rmdir` the empty `docs/superpowers` tree.
- Move: `RESEARCH_ai-comprehension-gap.md` → `docs/research/2026-07-25-ai-comprehension-gap.md`; `RESEARCH_concise-output.md` → `2026-07-17-concise-output.md`; `RESEARCH_delegation_model_tiering.md` → `2026-07-11-delegation-model-tiering.md`; `RESEARCH_ecosystem_benchmark.md` → `2026-07-11-ecosystem-benchmark.md`; `RESEARCH_issue_driven_development.md` → `2026-05-26-issue-driven-development.md`; `RESEARCH_subagent_driven_workflow.md` → `2026-06-27-subagent-driven-workflow.md`; `RESEARCH_what_gives_best_deep_research.md` → `2026-05-30-what-gives-best-deep-research.md`; `RESEARCH_writing-systems.md` → `2026-07-30-writing-systems.md` (all under `docs/research/`).
- Modify citations: `plugins/gates/CLAUDE.md:28`, `plugins/gates/scripts/pretooluse-guard-agent-model.mjs:21`, `plugins/writing-artifacts/README.md:33` (the three `RESEARCH_` links); `plugins/gates/skills/docs-consolidate/SKILL.md:97`, `plugins/adr/README.md:39`, `plugins/adr/skills/adr/SKILL.md:110`, `plugins/handoff/skills/handoff/SKILL.md:105`, `plugins/codex-review/README.md:5`, `plugins/codex-review/skills/codex-plan-review/SKILL.md:15`, `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs:4` (the `docs/superpowers/` paths); every `docs/superpowers/` or `RESEARCH_` path inside `docs/research/*.md` and the moved files themselves (`grep -rln 'docs/superpowers/\|RESEARCH_' docs` lists them).
- Modify: `docs/developing.md` (layout tree ~7-20: drop the `docs/superpowers/{specs,plans}/` and `RESEARCH_*.md` lines, add `docs/specs/` and `docs/plans/`; the rule at ~40 loses "a repo-root `RESEARCH_*.md`"); `.gitignore` (delete the four-line `# Cargo build output…` comment and `rust/target/`).
- Test: `scripts/repo-consistency.test.mjs` ~line 201 — delete the `{ re: /(?<![\w/-])RESEARCH_[\w-]+\.md/g, … }` PATTERNS entry (the dated-`docs/` pattern above it now covers those files); ~line 188 its comment's example path `docs/superpowers/plans/YYYY-MM-DD-<name>.md` → `docs/plans/YYYY-MM-DD-<name>.md`; ~line 164 the comment's "a repo-root RESEARCH_*.md" clause goes.
- Bump: gates, writing-artifacts, adr, handoff, codex-review — patch each.

**Interfaces:**
- Produces: `docs/{research,specs,plans}/` as the only doc homes; no file matching `RESEARCH_*.md` at the root; no `docs/superpowers/` directory; no live reference to either legacy location from shipped plugin files, `docs/developing.md`, `docs/research/`, `scripts/`, `README.md`, `.gitignore` or `.claude-plugin/`. Historical prose inside the moved plans and specs, and `docs/migrations.md`, may still name the old paths.

- [ ] **Step 1:** `node --test scripts/repo-consistency.test.mjs` → PASS (baseline). Do the moves with `git mv` so history follows.
- [ ] **Step 2:** rewrite each citation to the new path, keeping the link form each site already uses (a `github.com/…/blob/main/` URL stays a URL with the new path; a bare path in a comment stays bare). In `docs-consolidate/SKILL.md:97` the corpus list becomes `` `docs/specs/`, `docs/plans/`, `docs/adr/`, `` (drop the two superpowers entries).
- [ ] **Step 3:** `ls docs/superpowers RESEARCH_*.md` → no such file. `grep -rn 'docs/superpowers/\|RESEARCH_[A-Za-z_-]*\.md' plugins docs/developing.md docs/research README.md scripts .gitignore .claude-plugin` → no output (the moved plans and specs under `docs/plans` and `docs/specs` are historical and may keep old paths in their prose; `docs/migrations.md` may too). `node --test scripts/repo-consistency.test.mjs` → PASS. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 4:** bump the five plugins patch; `git add -A -- docs/superpowers docs/specs docs/plans docs/research 'RESEARCH_*.md' && git add .gitignore docs/developing.md scripts/repo-consistency.test.mjs .claude-plugin/marketplace.json plugins/gates plugins/writing-artifacts plugins/adr plugins/handoff plugins/codex-review && git commit -m "docs: one research, one specs, one plans directory; citations follow" -m "Claude-Session: nightshift"` (`-A` on those pathspecs records the renames and deletions).

### Task 2: gates docs describe the Go binary, five gates, and fit in 200 lines

**Files:**
- Modify: `plugins/gates/CLAUDE.md` (372 lines; sections `Design decisions — docs-sync` ~71-85, `— consolidation trigger` ~86-151, `— design-gate` ~152-181, `— the model gates` ~182-223; `Gotchas — docs-sync` ~224-295; lines ~5, ~298, ~324, ~332, ~359-360).
- Create: `docs/gates-design-decisions.md`.
- Modify: `plugins/gates/README.md` (~373-384 the arm64/Intel paragraph; ~388 the bare `scripts/hook-runtime-guard.test.mjs` citation; Dependencies section).
- Modify: `plugins/gates/.claude-plugin/plugin.json` (`description`), `docs/developing.md` (Development section), `docs/research/2026-08-26-hook-latency-benchmark.md` (top).
- Test: `scripts/hook-runtime-guard.test.mjs:38` and the header comment of `scripts/ccguard-differential.test.mjs` (~1-20) — the word "Rust" only; no assertion changes.
- Bump: gates patch.

**Interfaces:**
- Consumes: `plugins/gates/go/README.md` (the truth: five ccguard subcommands, macOS universal binary, reproducible build compared byte-for-byte in CI, no fingerprint).

- [ ] **Step 1:** `wc -l plugins/gates/CLAUDE.md` → 372. Create `docs/gates-design-decisions.md` with a one-line header (`# gates: design decisions` and "Moved out of `plugins/gates/CLAUDE.md`, which is loaded as context and budgeted at 200 lines.") and move the four `Design decisions —` sections and the `Gotchas — docs-sync` section into it verbatim. In `CLAUDE.md`, replace each moved section with one line: `See [docs/gates-design-decisions.md](https://github.com/jasonm4130/claude-skills/blob/main/docs/gates-design-decisions.md#<anchor>).`
- [ ] **Step 2:** CLAUDE.md corrections on the remaining lines: line ~5 `Four \`PreToolUse\` gates` → `Five \`PreToolUse\` gates`; add `lsp-first` to the gate list block in `What this is` with one line (`**lsp-first** — a shell or Grep search for a code symbol when its language server resolves → deny; compiled only, no .mjs fallback`); `:298` → `Four of the five gates and the PostToolUse guard run a committed Go binary, with the \`.mjs\` as fallback for three of them`; `:324` `the Rust port` → `the Go port`; `:332` delete `and the staleness fingerprint` (CI compares a fresh reproducible build byte-for-byte instead); `:359-360` bare citations → `github.com/jasonm4130/claude-skills/blob/main/scripts/ccguard-differential.test.mjs` link form. `wc -l` → ≤ 200.
- [ ] **Step 3:** README: the arm64/Intel paragraph says the binary is a macOS universal build (arm64 and Intel), the `.mjs` fallback runs on Linux and Windows, and lsp-first has no fallback; add to Dependencies: `bin/ccguard is a ~6 MB committed universal binary — most of the plugin's install footprint — so the guards run without Node; see go/README.md`; `:388` citation → github link. `plugin.json` description: `Five stateless PreToolUse gates, a PostToolUse JSON-config guard, and a docs-consolidation trigger.`
- [ ] **Step 4:** `scripts/hook-runtime-guard.test.mjs:38` `committed Rust binary` → `committed Go binary`; differential test header comment (lines 1-20 only): every `Rust` there — `Rust pilot` (~5), the "no Rust regex engine has lookaround" clause (~8, → Go's RE2 has no lookaround), `Rust source` (~10), `Rust port` (~15) — becomes Go. Leave that file's `rust` variable names and the lone-surrogate comment (~82-83) alone: they are labels inside a test, not claims a reader is told. Benchmark doc: insert after its title `> Superseded 2026-08 by the Go port (a7bc901): the binary is Go, not Rust; the numbers below still describe the process-start cost this port was built to remove.` `docs/developing.md` Development section lists the four local commands: `bash scripts/run-node-tests.sh`, `(cd plugins/gates/go && go vet ./... && go test ./...)`, `node --test scripts/ccguard-differential.test.mjs`, `claude plugin validate plugins/<name>`.
- [ ] **Step 5:** `grep -n -i 'rust' plugins/gates/CLAUDE.md plugins/gates/README.md scripts/hook-runtime-guard.test.mjs` → only the design-gate scaffolder table row (`| Rust | cargo new …`); `sed -n 1,20p scripts/ccguard-differential.test.mjs | grep -c -i rust` → `0`. `node --test scripts/repo-consistency.test.mjs scripts/hook-runtime-guard.test.mjs scripts/ccguard-differential.test.mjs` → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 6:** bump gates patch; `git add plugins/gates docs scripts/hook-runtime-guard.test.mjs scripts/ccguard-differential.test.mjs .claude-plugin/marketplace.json && git commit -m "gates docs: Go, five gates, universal binary; design decisions move to docs/" -m "Claude-Session: nightshift"`.

### Task 3: session-retro docs match the code and fit in 200 lines

**Files:**
- Modify: `plugins/session-retro/CLAUDE.md` (257 lines; `:9`, `:33` hook counts; overview ~20-30 and Dependencies ~202-210 that duplicate README; `:205` bare citation; the 2026-08-09 incident narrative).
- Modify: `plugins/session-retro/README.md` (`:21` `Five hooks + one skill`; hook table ~23-30; `:76` memory dir).
- Modify: `plugins/session-retro/skills/retro/SKILL.md` (~51-52 the "most-recent sessions" sentence; the Step 5 memory target).
- Bump: session-retro patch.

**Interfaces:**
- Consumes: `hooks/hooks.json` (six events: SessionStart, PostToolUse, PostToolUseFailure, Stop, PreCompact, UserPromptSubmit); `collect-batch-sessions.mjs:57-70` (drains **oldest** first).

- [ ] **Step 1:** README `Five hooks + one skill.` → `Six hooks + one skill.`; the hook table gains a `PostToolUseFailure` row pointing at the same script as `PostToolUse`; `:76` `${CLAUDE_PROJECT_DIR}/memory/` → `the auto-memory directory Claude Code loaded this session (\`~/.claude/projects/<sanitized-repo-path>/memory/\`), never a \`memory/\` directory in the working tree`.
- [ ] **Step 2:** SKILL.md: replace the sentence claiming the most-recent sessions are shown with `The oldest accrued sessions are read first, up to \`RETRO_BATCH_MAX_SESSIONS\` (default 12); newer ones wait for the next retro.` In Step 5, name the target directory as in the README line above.
- [ ] **Step 3:** CLAUDE.md: `Five hooks` → `Six hooks` at `:9`; tree line → `6 events: SessionStart, PostToolUse, PostToolUseFailure, Stop, PreCompact, UserPromptSubmit`; replace the Dependencies block (~202-210) with one line `Dependencies: see the README's Requirements.`; replace the overview paragraphs that restate README lines 21-36 with `Mechanism: see the README.`; delete the dated incident narrative, keeping only the constraint it produced; `:205` citation → github link form. `wc -l plugins/session-retro/CLAUDE.md` → ≤ 200.
- [ ] **Step 4:** `grep -n 'Five hooks\|5 events\|CLAUDE_PROJECT_DIR}/memory' plugins/session-retro -r` → nothing. `node --test scripts/repo-consistency.test.mjs` → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 5:** bump session-retro patch; `git add plugins/session-retro .claude-plugin/marketplace.json && git commit -m "session-retro docs: six hooks, real memory dir, oldest-first batching, CLAUDE.md under budget" -m "Claude-Session: nightshift"`.

### Task 4: no shipped file points at a retired skill or a private repo

**Files:**
- Modify: `plugins/domain-modeling/skills/domain-modeling/SKILL.md:63` (`brainstorming`), `plugins/adr/README.md:8`, `plugins/adr/skills/adr/SKILL.md:3,22` (`brainstorming`), `plugins/adr/skills/adr/SKILL.md:79` (`transcoder/docs/adr/`).
- Modify: `plugins/gates/skills/docs-consolidate/SKILL.md:40,109,126` (three `transcoder` examples); `plugins/writing-artifacts/README.md:30-32`; `plugins/handoff/CLAUDE.md:49`; `plugins/gates/README.md` if any bare `scripts/…` citation remains after Task 2.
- Bump: domain-modeling, adr, gates, writing-artifacts, handoff — patch each.

**Interfaces:**
- Consumes: `nightshift:plan` (the skill that replaced `brainstorming`; `plugins/nightshift/skills/plan/SKILL.md`).
- Out of scope: the design-gate's deny reason still says `brainstorming HARD-GATE` in `plugins/gates/go/designgate.go`, `scripts/pretooluse-guard-design-gate.mjs` and its test; that text ships in the compiled binary and moves with the gates Go work in the gates-config plan, not here.

- [ ] **Step 1:** every `brainstorming` reference in the four adr/domain-modeling sites → `nightshift:plan` (the sentence keeps its meaning: "exploring intent → nightshift:plan's question round"). adr `SKILL.md:79`: `transcoder/docs/adr/` → `one downstream repo's \`docs/adr/\``. docs-consolidate `SKILL.md`: each `transcoder` → `one downstream repo` (`:40`), `a downstream repo's CONFIG-MATRIX` (`:109`), `in one downstream repo` (`:126`), keeping the rest of each sentence.
- [ ] **Step 2:** writing-artifacts README: `every coherent writing system tested halved lint-scored slop` → `in one practitioner experiment (woosal1337, 2026, medium confidence; no controlled comparison exists) a coherent writing system roughly halved lint-scored slop`. handoff `CLAUDE.md:49` citation → github link form.
- [ ] **Step 3:** `grep -rn 'brainstorming\|superpowers-core' plugins --include='*.md'` → nothing; `grep -rn transcoder plugins` → nothing. `node --test scripts/repo-consistency.test.mjs plugins/*/skills/*/skill.test.mjs plugins/gates/tests/*.test.mjs` → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 4:** bump the five plugins patch; `git add plugins/domain-modeling plugins/adr plugins/gates plugins/writing-artifacts plugins/handoff .claude-plugin/marketplace.json && git commit -m "docs: retired skills and private repos are no longer cited from shipped files" -m "Claude-Session: nightshift"`.

### Task 5: manifests pass `claude plugin validate --strict` where no root CLAUDE.md blocks it

**Files:**
- Modify: `plugins/{gates,handoff,session-retro,ship-gate,writing-artifacts}/.claude-plugin/plugin.json` — move the top-level `engines` object under `metadata` (`"metadata": { "engines": { "claude-code": ">=x.y.z" } }`), merging into an existing `metadata` object if present.
- Modify: `docs/developing.md` (the CI paragraph about `claude plugin validate`).
- Test: `scripts/hook-runtime-guard.test.mjs` ~125-138 (the `engines` test).
- Bump: the five plugins patch.

**Interfaces:**
- Produces: `claude plugin validate --strict plugins/ship-gate` and `plugins/writing-artifacts` pass; gates, handoff, session-retro still warn only about the plugin-root `CLAUDE.md` (kept on purpose — the maintainer loads it; installers do not).

- [ ] **Step 1:** in the test, `const engines = JSON.parse(readFileSync(manifestPath, "utf8")).engines;` becomes `const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); assert.equal(manifest.engines, undefined, \`${plugin}: engines belongs under metadata, where --strict accepts it\`); const engines = manifest.metadata?.engines;`, and above the loop add `const CARRY_ENGINES = new Set(["gates", "handoff", "session-retro", "ship-gate", "writing-artifacts"]);` with, inside the loop, `if (CARRY_ENGINES.has(plugin)) assert.ok(engines && typeof engines["claude-code"] === "string", \`${plugin}: metadata.engines.claude-code must survive the move\`);` before the existing `if (engines === undefined) continue;`. `node --test scripts/hook-runtime-guard.test.mjs` → FAIL for the five plugins.
- [ ] **Step 2:** move the field in the five manifests. Same test → PASS. Then:
```bash
for p in plugins/*/; do if out=$(claude plugin validate --strict "$p" 2>&1); then echo "ok   $p"; else echo "FAIL $p"; echo "$out" | grep -E '^\s*❯' ; fi; done
```
  → `ok` for every plugin except `gates`, `handoff`, `session-retro`, and each of those prints exactly one `❯` line, the `CLAUDE.md at the plugin root` warning; any `Unknown field` line anywhere means the move is incomplete.
- [ ] **Step 3:** `docs/developing.md`: the validate paragraph says `--strict` stays off in CI only because three plugins ship a root `CLAUDE.md` for the maintainer; manifests carry `metadata.engines`, which `--strict` accepts; and, in one sentence, that the comment at `.github/workflows/ci.yml` ~50-58 still cites `engines`/`contributors` and is a human's to correct (workflow files are outside the loop's reach; no manifest ever carried `contributors`). Put the same sentence in the commit body so the morning triage sees it. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 4:** bump the five plugins patch; `git add plugins docs/developing.md scripts/hook-runtime-guard.test.mjs .claude-plugin/marketplace.json && git commit -m "manifests: engines under metadata, where validate --strict accepts it" -m "Claude-Session: nightshift"`.

## Open Questions
