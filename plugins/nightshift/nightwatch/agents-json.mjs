#!/usr/bin/env node
// Turn the plugin's agents/*.md into the JSON `claude -p --agents` takes, so the
// headless unit resolves `worker` and `verifier` on any machine, under their bare
// names, without depending on what the child loads from ~/.claude or the repo.
//
//   node agents-json.mjs <agents-dir>      → {"worker": {...}, "verifier": {...}}
//
// Frontmatter keys carried: description, model, effort, tools, disallowedTools
// (comma lists become arrays). The body, minus HTML comments, is the prompt.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function parseAgent(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("no frontmatter");
  const fm = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!fm.name || !fm.description) throw new Error("frontmatter needs name and description");
  const prompt = m[2].replace(/<!--[\s\S]*?-->/g, "").trim();
  const def = { description: fm.description, prompt };
  for (const k of ["model", "effort"]) if (fm[k]) def[k] = fm[k];
  for (const k of ["tools", "disallowedTools"]) {
    if (fm[k]) def[k] = fm[k].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return { name: fm.name, def };
}

export function agentsJson(dir) {
  const out = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const { name, def } = parseAgent(readFileSync(join(dir, f), "utf8"));
    out[name] = def;
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: agents-json.mjs <agents-dir>"); process.exit(64); }
  process.stdout.write(`${JSON.stringify(agentsJson(dir))}\n`);
}
