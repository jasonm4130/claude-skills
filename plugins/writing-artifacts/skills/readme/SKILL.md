---
name: readme
description: Use when writing, auditing or revising a project's README.md, including its badge row. Grounds every claim in a file:line fact inventory, scores the first screen, orders sections as a reader funnel, defines terms before use, keeps prose plain, and runs a checker for broken paths, links, anchors, commands, badges, emoji and leftover TODOs. Do NOT use for GitHub profile READMEs, API reference, CHANGELOGs or PR descriptions; writing-artifacts owns the sentence-level prose, and the adr skill owns ADRs.
---

# readme

A README is read by a stranger deciding, in about thirty seconds, whether this project is for them. Everything in it must be true of the repository as it stands today, and the first screen must answer the stranger's questions before it answers the maintainer's. This skill gives the procedure for getting there and a checker for the parts a script can verify. For sentence-level prose, apply `writing-artifacts:writing-artifacts` as well.

It applies to a new README, a rewrite, an audit of an existing one, or a README change inside a pull request. It does not decide what the project is, capture screenshots, or pick a license. When one of those is missing, say so and leave the decision to the owner.

## Stance

Say only what a reader could verify from the repository, and mark what you could not verify. A README that overclaims is worse than a short one: the reader trusts it once.

## Procedure

### 1. Read before writing

Read the existing README, the manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `.claude-plugin/plugin.json` or equivalent), the CLI's own help output, `.github/workflows/`, the LICENSE file if any, and every doc the README links to. Note whether the repository is public or private (`gh repo view --json visibility`).

### 2. Build a fact inventory

Before drafting, list every fact the README will state, each with its source as `file:line` or the command whose output shows it:

- commands and their flags
- paths and file names
- numbers: versions, counts, ports, timeouts, defaults
- requirements: runtime and its version, OS, accounts, other tools
- what the project produces or shows

A fact with no source is marked unverified. Either find its source, run the command to confirm it, or leave it out. Never invent a command, flag, path or link because it is what such a project usually has.

### 3. Score the first screen

The first screen is what shows before scrolling: roughly the title, badges and first twenty lines. Score each item present, missing, or not applicable:

1. What it is, in the first sentence, in plain words. Not a slogan, not a feature list.
2. Who it is for, and when it is not the right tool.
3. A picture, diagram or sample output, when the project has visible output. If one is needed and none exists, say so; do not fabricate one.
4. The requirements, stated before the first command that needs them.
5. The first command a new reader can run, and what they should see.

Anything a notice, logo or badge row pushes below the first screen counts as missing.

### 4. Choose the badge row

Badges are claims, so each must be true and point at something real. Pick at most five, in this order, and only those that apply:

- **CI**: the status of the workflow that gates merges. It must name a file under `.github/workflows/`.
- **Version**: the released version. It must agree with the manifest, or read the registry dynamically.
- **Runtime**: the required runtime and version, matching the manifest's `engines` or equivalent.
- **Platform**: only when the project is limited to some platforms.
- **License**: only when a LICENSE file exists, and naming the license that file holds.

Leave out download counts, stars, "PRs welcome", chat links and anything decorative. A private repository needs GitHub's own workflow badge (`https://github.com/<owner>/<repo>/actions/workflows/<file>/badge.svg`) or a static badge: shields.io's GitHub endpoints cannot read a private repository and render as errors or as "repo not found". When no badge is true and useful, have none.

### 5. Order sections as a funnel

Each section serves a reader further along than the one before. Use this order and skip what does not apply:

1. What it is (title, one-paragraph statement, badge row, picture)
2. Fit: who it is for, what it does not do
3. Try it: requirements, install, a first run and its expected output
4. Use it: the common tasks, each as a short recipe
5. Reference: configuration, options, links to fuller docs
6. Contributing and development
7. License

Maintainer procedures (release steps, CI internals, how the docs are built) move to a doc under `docs/` with a link from the README. Keep one home per fact: if a doc already holds it, link there rather than copying it.

### 6. Define terms before use

List every noun a newcomer would not know: project-specific names, internal tools, acronyms, product names. For each, find its first use in the README. Define it in a clause there, link to where it is defined, or cut it. A term defined three sections after its first use counts as undefined.

### 7. Keep the prose plain

- No emoji, in headings or text. They also break heading anchors (an emoji heading slugs to `#-name`).
- No hype adjectives ("blazing", "powerful", "seamless", "beautiful") and no sales framing. State what it does and let the reader judge.
- No count, benchmark or comparison without its source.
- No leftover TODO, TBD or placeholder text.
- Commands in fenced blocks tagged `sh` or `bash`, one per line, with no `$` prompt unless the block also shows output.

### 8. Run the checker

From the repository root, run the bundled script. Its path is relative to this skill's base directory, as stated when the skill loaded (do not use `${CLAUDE_PLUGIN_ROOT}`; it is unset in session shells):

```sh
node "<this skill's base directory>/scripts/check-readme.mjs" README.md
```

Options:

- `--cli "<name>=<help command>"` declares a CLI the README documents, for example `--cli "mytool=node bin/mytool.mjs --help"`. Every `<name> <subcommand>` in the README must then appear in that help output. Repeat it for each CLI.
- `--private` flags shields.io badges that need to read the repository from GitHub.
- `--root <dir>` sets the repository root (default: the git root above the README).
- `--json` prints the findings as JSON.

It prints `README.md:<line>: <kind> <message>` per finding and exits 1 when there are any. Kinds: `path` (a backticked path that does not exist, or a machine path such as `/Users/...`), `link` (a relative link or image whose target is missing), `anchor` (a `#anchor` that matches no heading under GitHub's slug rules, in the README or the linked Markdown file), `command` (a `npm`, `pnpm`, `yarn` or `bun` script that `package.json` does not define, a `node <file>` whose file is missing, or a CLI subcommand absent from its help), `badge` (a workflow badge whose workflow file is missing, a license badge with no LICENSE file, a static version badge that disagrees with the manifest, or a shields.io GitHub badge on a private repo), `emoji` and `leftover`.

Fix every finding, or say in the report why it is a false positive. The checker covers what can be checked mechanically. Steps 3 to 7 remain reading checks, and passing the checker does not mean they pass.

### 9. Report decisions, not a diff

When done, report in a few lines: the first-screen score before and after, what moved and why, what was cut and why, the facts left unverified, and anything only the owner can supply (a screenshot, a license, a statement of scope).
