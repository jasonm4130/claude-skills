# design-gate-guard

A single `PreToolUse` hook (matcher `Bash`) that enforces the brainstorming
**HARD-GATE** at the one place it most often breaks: jumping straight to a
new-project scaffold before a design has been approved.

The brainstorming skill says, in prose:

> Do NOT ... write any code, scaffold any project, or take any implementation
> action until you have presented a design and the user has approved it.

Prose doesn't intercept anything. The classic failure is the model, on autopilot,
running `npm create vite` (or `create-next-app`, `rails new`, …) the moment a
project is mentioned — skipping the design entirely. This hook catches exactly
that action and turns it into a checkpoint.

## What it does

On every `Bash` command it checks whether any command *segment* starts with a
new-project scaffolder. If so, it emits an **`ask`** — the user confirms whether a
design was approved before the scaffold runs. It never denies and never edits
anything; a scaffold you meant to run is one keystroke away.

### Why `ask`, not `deny`

A PreToolUse hook can't see the conversation, so it **cannot know** whether a
design was approved — the session model and any "approval" are not in the hook's
stdin or environment (the same constraint `workflow-model-guard` documents). A
hard `deny` would therefore dead-end a *legitimate* post-approval scaffold with no
way for the model to resolve it. `ask` routes the decision to the human, who *can*
see whether the design happened. This mirrors `workflow-model-guard`, which
likewise `ask`s (rather than denies) when it can't determine session state.

### Why only scaffold commands

Gating arbitrary `Write`/`Edit` on hidden "is a design approved?" state would need
a stateful flag whose worst failure — a flag that never clears — silently blocks
*all* future editing. Every sibling guard in this repo is deliberately stateless
for that reason. Scaffold commands are the **high-signal, low-frequency** slice:
distinctive, rare (you scaffold a project once), and the exact documented incident.
An occasional confirmation on a command you run once per project is a cheap price;
a guard that blocks your live editing is not.

## Commands it asks about

| Ecosystem | Examples |
|---|---|
| JS/TS package managers | `npm create vite`, `pnpm create`, `yarn create next-app`, `bun create`, `npm init vite` |
| `create-*` CLIs | `npx create-next-app`, `npx create-react-app`, `pnpm dlx create-astro`, `create-react-app my-app` |
| Rust | `cargo new`, `cargo init` |
| Python | `django-admin startproject`, `django-admin startapp` |
| Ruby | `rails new` |
| Angular / NestJS / Vue | `ng new`, `nest new`, `vue create` |
| Mobile | `expo init`, `flutter create` |
| .NET | `dotnet new <template>` |
| Elixir/Phoenix | `mix new`, `mix phx.new` |
| PHP | `laravel new`, `composer create-project` |
| Static site | `gatsby new`, `hugo new site`, `jekyll new` |

The match is anchored to the **start of each command segment**, so it fires on
`mkdir app && cd app && npm create vite` (later segment) and on
`FOO=bar sudo npm create vite` (env / `sudo` prefix), but **not** on a scaffold
name that only appears inside a commit message (`git commit -m "add
create-react-app docs"`), an `echo`/`printf` string, or a `dotnet new --list`.

## Bypassing (deliberate, self-documenting)

Add `design-gate:ack` anywhere in the command to run a scaffold that *is*
legitimate (design already approved, or not a fresh project):

```bash
npm create vite@latest my-app   # design-gate:ack
```

The marker stays in your shell history, so the bypass is auditable — the same
pattern the other guards use (`docs-sync:ack`, `model-guard:ack`).

## What it does NOT do

- It does **not** enforce design-before-*editing* — only design-before-*scaffolding*.
  A stronger Write/Edit gate would need session state this hook deliberately avoids.
- It does **not** guarantee a design happened — it surfaces a checkpoint to the
  human. It breaks autopilot; it doesn't replace judgment.

## Requirements

- **Node.js 18+ on PATH.** No third-party packages, no `package.json`. Stdlib only.
  Claude Code ships a self-contained native binary and its documented system requirements do **not** include Node, so this is an external prerequisite the host does not provide — install it via Homebrew, WinGet, or your distro's package manager. Hooks use **exec form** (`command: "node"`, `args: [...]`), so Claude Code spawns node directly with no shell on any platform; without a shell there is no sh-vs-PowerShell dialect to get wrong. On a machine with no node the spawn fails and Claude Code shows a non-blocking `hook error` per event — loud and self-diagnosing by design.
- **Claude Code >= 2.1.110** — for `hooks.json` plugin hook registration.

## Development

```bash
node --test plugins/design-gate-guard/tests/
```

```bash
# Manual smoke test (scaffold → ask envelope)
echo '{"tool_name":"Bash","tool_input":{"command":"npm create vite@latest app"}}' \
  | node plugins/design-gate-guard/scripts/pretooluse-guard-design-gate.mjs
```
