#!/usr/bin/env node
// @ts-check
// PostToolUseFailure hook (matcher: Bash): when a git commit or SSH push fails
// because the 1Password agent is locked or unreachable, tell the model so, once,
// instead of letting it retry or start debugging signing config. The session-retro
// corpus (2026-08-22..09-25) held ~51 of these failures, recurring across
// sessions; the fix is always a human unlocking 1Password.
//
// Adds context only. Never blocks, never exits non-zero.

import process from "node:process";
import { readStdin, safeJsonParse, emitAdditionalContext, isGuardDisabled } from "./lib.mjs";

/** Error text 1Password's SSH agent and git signing produce when locked. */
const LOCKED_RE =
  /sign_and_send_pubkey: signing failed|1Password: (Could not connect to socket|failed to fill whole buffer)|error: 1Password:|agent refused operation/i;

const raw = await readStdin();
if (isGuardDisabled("signing-nudge")) process.exit(0);
const p = /** @type {{ tool_name?: string, error?: unknown } | null} */ (safeJsonParse(raw));
if (!p || p.tool_name !== "Bash" || typeof p.error !== "string" || !LOCKED_RE.test(p.error)) process.exit(0);

emitAdditionalContext(
  "PostToolUseFailure",
  "signing-nudge: this failed because the 1Password SSH agent is locked or unreachable. " +
    "Don't retry, re-sign, or change git/SSH config. Ask Jason to unlock 1Password, " +
    "then re-run the same command once.",
);
process.exit(0);
