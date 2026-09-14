package main

import (
	"os"
	"strings"
)

// GATES_DISABLE names the guards that must not run, comma separated:
//
//	"env": { "GATES_DISABLE": "docs-sync,agent-model" }
//
// A Claude Code settings.json `env` block reaches hook subprocesses, so the same
// mechanism turns a guard off for one project or for every session, with no file
// for this binary to find, parse or fail on. It follows the precedent already in
// scripts/lib.mjs, which reads DOCS_SYNC_CONSOLIDATE_THRESHOLD the same way.
//
// Names are the subcommands in main.go's dispatch, plus the two node-only guards
// (docs-sync, docs-consolidate), so there is one vocabulary across both
// implementations. Matching is exact: an unrecognised name disables nothing and
// says nothing, which is the fail-open posture the rest of this binary holds.
const disableEnv = "GATES_DISABLE"

func guardDisabled(name string) bool {
	return guardDisabledIn(os.Getenv(disableEnv), name)
}

func guardDisabledIn(raw, name string) bool {
	for _, field := range strings.Split(raw, ",") {
		if strings.TrimSpace(field) == name {
			return true
		}
	}
	return false
}
