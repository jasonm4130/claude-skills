# Guards packaging verdict (2026-09-04)

Output of the same Workflow run as the landing-loop design review: an inventory of go/ and plugins/gates, two packaging proposals (one plugin with source moved in; individually installable guards), one judge. Includes what deleting subagent-driven-development breaks.

# Verdict: keep one `gates` plugin. Adopt A, minus its config toggle, plus a fix A missed.

Judged against the working tree at `/Users/jasonmatthew/Work/Git/claude-skills` (HEAD, 2026-09-04). Every claim below that decided something was re-run; I did not build Go.

## The decision

**Proposal A**, with three amendments. B is rejected — not on taste, on two verified defects and a version story that does not deliver what it promises.

---

## Axis 2 first, because main is red and both proposals agree

Confirmed positively, not inferred:

- `go/go.mod` is exactly `module ccguard` / `go 1.27` — **no `toolchain` line**.
- `.github/workflows/ci.yml:85` — `go-version: "1.27"`, floating.
- `go version -m plugins/gates/bin/ccguard` → `go1.27.0`; the file is dated 30 Aug.

Diagnosis holds: `-trimpath` strips source paths, not the toolchain stamp, so a 1.27.1 runner rebuilds different bytes from identical source. Both proposals prescribe the same fix and it is correct. B additionally claims to have *run* all three builds (1.27.0 reproduces byte-identical; explicit `GOTOOLCHAIN=go1.27.1` differs; `toolchain` directive reproduces the 1.27.1 bytes). A flags the same steps as unverified. Take B's evidence, A's or B's implementation — they are the same three changes:

1. `go/go.mod` gains `toolchain go1.27.1`.
2. CI: `go-version-file: go/go.mod` replacing `go-version: "1.27"`, with `GOTOOLCHAIN: auto` set explicitly on the job (B's addition, and the right one — a runner image defaulting to `local` silently defeats the directive).
3. `go/build.sh` as the single definition of `-buildvcs=false -ldflags="-s -w" -trimpath` + `lipo`, called by CI, `go/README.md` and `ccguard-differential.test.mjs`. The flag string is written out in at least three places today.

Plus both proposals' stamp check, run **before** `cmp`, so drift reports as drift instead of as staleness. That is the actual defect in today's red job: PR #89 touches neither `go/` nor `bin/` and gets told the binary is stale.

Keep the byte-compare. `go/README.md:44-54` argues correctly that comparing the artifact catches a stale binary *and* one built from other source, and that the Rust predecessor's FNV-1a fingerprint was a workaround for an irreproducibility Go does not have once the toolchain is pinned. Neither proposal wants to regress this; noting it so nobody re-litigates.

**Ship this alone, first, as its own PR.** It is unrelated to packaging and main stays red until it lands.

---

## Axis 1 — can a stranger install only what they want

B wins the literal reading and loses the real one.

**B's resolver is wrong as written.** From `~/.claude/plugins/cache/jasonm4130-claude-skills/gates/` on this machine: `0.1.1` and `0.2.0` both present. Superseded versions stay on disk. B's `for d in .../ccguard-core/*/bin/ccguard; do [ -x "$d" ] && exec "$d" "$@"; done` takes the **lexicographically first** match, not the newest — `0.10.0` sorts before `0.2.0`. B describes it as "a glob taking the newest"; it is not.

Worse, the repo already learned this and wrote it down. `plugins/adr/skills/adr/SKILL.md:127-130`: *"Do not glob the cache for another version: superseded and rolled-back versions stay on disk, so picking the highest cached one silently runs a loop whose `args` contract this skill no longer matches."* B's central mechanism contradicts an existing, documented, tested constraint (`scripts/cached-path-pin.test.mjs`) without engaging with it. B saw the precedent, cited it, then inverted its conclusion.

**B's install story has a silent-inert failure mode.** Claude Code has no dependency field — B concedes this. A stranger who installs `lsp-first-gate` and skips `ccguard-core` gets a plugin that does nothing, reports nothing, and looks installed. That is a worse outcome than A's one install with everything on by default.

**A's counter-argument is partly overstated.** A claims `plugins/lsp-first/hooks/hooks.json` naming `../gates/bin/ccguard` is "precisely the outside-its-own-payload citation `"shipped plugin files cite no path outside their own payload"` exists to catch." I read that test (`scripts/repo-consistency.test.mjs:161-248`): it flags exactly three patterns — dated `docs/…` paths, `RESEARCH_*.md`, `dotfiles/…`. A relative sibling-plugin path would **not** fail it. A's *substance* is right (the path is genuinely dead in an install cache, which is why `adr` and `landing-loop` resolve at runtime instead) but the test does not enforce it, and the verdict should not rest on a check that would stay green.

What survives: the 31 MB-per-clone vendoring cost, which B measured (~400 KB of guard logic in a 6.2 MB artifact; 94% Go runtime) and correctly rejected — leaving B with only the broken resolver.

---

## Axis 3 — maintenance cost for one developer. This is what decides it.

**B's version story does not deliver what B claims.** B's opening argument is that an `lspfirst.go` change should not notify docs-sync users. But under B, that change rebuilds the shared artifact → bumps `ccguard-core` → and all five compiled gates depend on `ccguard-core`. Every compiled-gate user still sees an update on every guard change. The only users insulated are `docs-sync-gate`'s and `docs-consolidate`'s — pure `.mjs`. B pays 7 plugins' worth of permanent bookkeeping to spare two plugins' users from version noise.

Itemised, forever, for one maintainer: 7 `plugin.json` + 7 `marketplace.json` entries kept in sync, 7 README/CLAUDE.md pairs (docs-sync will demand them), `lib.mjs` (11.9 KB) copied into 4-5 payloads, `ccguard-differential.test.mjs`'s `IMPLS` map re-pointed, `plugin-validate` looping 7× per CI run, and a deprecation-shim window whose behaviour B admits is untested ("I am not claiming what `claude plugin update` does when a marketplace entry disappears").

A's one plugin costs one version number. `scripts/check-version-bumps.mjs` keys on the plugin directory and already models this correctly.

**A's amendment here is sound and necessary if `go/` moves inside.** `check-version-bumps.mjs`'s exempt set is documented at lines 11-15 as `.claude-plugin/**`, any `tests/` dir or `*.test.*` file, and the plugin's own top-level README/CLAUDE.md. `*_test.go` matches none of those, so A's `isExempt` additions are required, not optional. A also correctly flags that `repo-consistency.test.mjs` imports the same helper and needs a look.

---

## Axis 4 — does deleting SDD retire the workflow-model gate? No.

I read `go/workflowmodel.go`. The gate matches the **`Workflow` tool generally**, not SDD:

- Its `nameDenylist` is `["deep-research"]` — a Claude Code built-in, present with zero plugins installed. That is the `ask` path, and on a frontier session it is the one that fires most.
- `plugins/landing-loop/workflows/land.mjs` is itself a fan-out Workflow script.
- The `script` / `scriptPath` paths gate any ad-hoc Workflow Jason writes.

The gate's cheapest justification survives SDD's deletion entirely. Packaging and the SDD decision are orthogonal; do not couple them.

---

## Amendments to A

**1. Split the toolchain fix out and ship it alone.** A already sequences it first; make it a standalone PR with no packaging content, so the red job clears without waiting on a decision.

**2. If `go/` moves inside the plugin, patch `docs-sync`'s `CODE_RE` in the same commit — A's stated rationale for the move is backwards.**

A claims the move makes the gates plugin's own docs gate cover the guard source. Verified false, and inverted:

- `plugins/gates/scripts/pretooluse-guard-docs-sync.mjs:45` — `const CODE_RE = /^plugins\/([^/]+)\/(scripts|hooks|agents|workflows)\//`. `plugins/gates/go/designgate.go` does not match.
- Line 347 — `if (f.startsWith("plugins/")) continue; // rule 1 territory`. Rule 2's nearest-covering-doc walk **skips everything under `plugins/`**.

So today, `go/designgate.go` at the repo root *is* covered (rule 2 walks up to the root `README.md`). After the move it is covered by neither rule. The move as proposed **removes** docs-sync coverage from the guard source. Fix: `(scripts|hooks|agents|workflows|go)` in `CODE_RE`. One token, but it must ship with the move, and A's §2 argument for the move should be rewritten around the auditability benefit — which is real and is the only one — rather than this one.

**3. Drop A's per-guard config toggle (§4) until someone asks for it.** It is new surface for a want with no reported instance: the first `os.Getenv` in the module, a mirrored precedence chain in `lib.mjs` (mandatory — otherwise a disabled gate reappears the moment the `|| node` fallback fires, which is every Linux and Intel-Mac session), and new differential-corpus cases. A already marks it optional. If it does land later, A's fail-open-on-malformed-config posture is right and matches `main.go`'s stated contract.

**The move itself is optional.** Its one real benefit is that a 6.2 MB Mach-O binary running on every Bash tool call currently ships with its source only in a repo the installer never cloned; +120 KB puts the source beside it. Worth doing, not urgent. Skipping it changes nothing else in this verdict.

---

## Migration, as ordered commits

1. **`go/go.mod` gains `toolchain go1.27.1`; add `go/build.sh`; CI switches to `go-version-file: go/go.mod` with `GOTOOLCHAIN: auto`; add the `go version -m` stamp assertion before `cmp`; rebuild and recommit `plugins/gates/bin/ccguard` with 1.27.1.** Bumps `gates` (binary changed) → `node scripts/bump-plugin.mjs gates patch` → 0.2.1. Clears the red `go-guards` job. Own PR, merge before anything below.
2. **`git mv go plugins/gates/go`.** Update the ten path references — `README.md:58`, `docs/developing.md:14,17,50`, `plugins/gates/README.md:378,384`, `plugins/gates/CLAUDE.md:317,331,371`, `scripts/repo-consistency.test.mjs:128-138` (hard-codes `join(root, "go", name)` and is designed to fail loudly if `go/` moves), `scripts/ccguard-differential.test.mjs:309,326`, `.github/workflows/ci.yml`'s `cd go` and `cache-dependency-path`. Rewrite `go/README.md`'s self-references. Binary bytes unchanged, so PR 1's `cmp` proves the move was source-only. Bump → 0.2.2.
3. **In the same commit as 2: add `go` to `docs-sync`'s `CODE_RE`, and add the `*_test.go` / `go/README.md` exemptions to `check-version-bumps.mjs`'s `isExempt`.** Check `repo-consistency.test.mjs`'s use of the same helper. Both are consequences of the move, not separate work.
4. *(Optional, only on request)* the per-guard toggle: `config.go` + `config_test.go`, the same precedence in `lib.mjs`, disabled-config differential cases, README "Turning a gate off", rebuild → minor bump 0.3.0.

Commits 2-3 are one PR. Nothing here changes a single hook command, so `hook-runtime-guard.test.mjs`'s shell-form constraint is untouched and current installs see no runtime change.

---

## Deleting `subagent-driven-development`: what breaks, and the minimal clean-up

### Hard runtime breaks

- **`plugins/landing-loop/workflows/land.mjs:369`** — `await workflow({ scriptPath: cfg.sddPath }, …)`. This is not a doc reference: landing-loop *executes* `sdd.mjs` as its inner loop, per task. Without SDD, landing-loop has no implementation phase. **The inventory undersold this** — it listed only the `land.mjs:4,14` comment/title hits. `landing-loop` must be deleted alongside SDD or have its inner loop reimplemented; no edit to `adr` or `superpowers-core` saves it.
- **`plugins/adr/skills/adr/SKILL.md:120-130`** — Phase 4 resolves the pinned cache path and stops with `MISSING:` when absent. Graceful, but `adr`'s terminal phase dead-ends.
- **`scripts/cached-path-pin.test.mjs:118-121`** — asserts *both* `plugins/adr/skills/adr/SKILL.md` and `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md` contain cached-path snippets. Fails twice on deletion.

### Minimal edits to `adr`

1. `plugins/adr/skills/adr/SKILL.md` — replace Phase 4 (≈ lines 98-150) with a terminal hand-off: commit the ADR, present the parsed `### Task N` decomposition, tell the user to execute it. Delete the `P="$HOME/.claude/plugins/cache/…"` block, the `MISSING:` guard, and the line-145 reference to SDD's tiering table (inline the tiers or drop them). Keep the loud-fail "no parseable `### Task N`" guard — it is about the ADR's own quality, not the loop.
2. `plugins/adr/skills/adr/skill.test.mjs:30-35` — the two assertions matching `subagent-driven-development|sdd\.mjs` and `subagent-driven-development/\d+\.\d+\.\d+/workflows/sdd\.mjs` must be rewritten against the new hand-off text or deleted.
3. `scripts/cached-path-pin.test.mjs:118-121` — remove both expected entries (adr no longer resolves, SDD no longer exists).
4. `plugins/adr/.claude-plugin/plugin.json:3,9` and `plugins/adr/README.md:6,39` — strip SDD from description, `keywords`, and prose.
5. `node scripts/bump-plugin.mjs adr minor` — `SKILL.md` is shipped payload, so `check-version-bumps.mjs` requires it; the script updates `marketplace.json` in the same pass.

### Minimal edits to `superpowers-core`

1. `skills/writing-plans/SKILL.md:65` — remove `> **For agentic workers:** REQUIRED SUB-SKILL: Use \`subagent-driven-development:subagent-driven-development\`…` from the **mandatory plan header**. This is the highest-value edit: every plan the skill writes currently embeds a directive naming a skill that will not exist.
2. Same file, lines 179-185 — rewrite the hand-off paragraph and the second `REQUIRED SUB-SKILL` line; keep the `codex-review` gate, drop the SDD execution step.
3. Same file, frontmatter and lines 3/14/20 — the "plans are disposable because SDD regenerates them" rationale dies with SDD. Restate why the format is what it is, or the skill argues from a premise that no longer holds.
4. `skills/test-driven-development/SKILL.md:3` — delete the "Do NOT use inside the subagent-driven-development loop… supersedes this skill there" clause. Cosmetic, but `writing-skills` requires every description carry a negative scope, so replace it rather than leave a gap.
5. `plugins/superpowers-core/README.md:47,49` — prose about the dangling hand-off.
6. `node scripts/bump-plugin.mjs superpowers-core minor`.

### Repo-wide

`.claude-plugin/marketplace.json` — delete SDD's entry, and the `adr` / `landing-loop` entries' SDD keywords and description text (lines 14, 24, 124, 136, 175-176, 184). `README.md:36,39` — the plugin table's deps column and SDD's row. Repo-root docs (`RESEARCH_subagent_driven_workflow.md`, 14 files under `docs/superpowers/plans/`, 3 under `specs/`, 3 under `docs/research/`) are not shipped and break nothing; `repo-consistency.test.mjs`'s `mustExist: true` means deleting the research doc *silences* rather than trips the citation check, so either choice is safe.
