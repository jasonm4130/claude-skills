package main

import (
	"bytes"
	"encoding/json"
	"os"
)

// The tool-call payload shape used by the two guards that were already Go
// (`lsp-first`, `json-config-guard`). Fields absent from a given tool's input
// simply stay zero.
//
// The three ported guards read their fields off a generic map instead (see
// nestedStr/topStr), because they must reproduce JS's `typeof x === "string"`
// semantics on fields whose value may be of any type.
type payload struct {
	ToolName  string    `json:"tool_name"`
	CWD       string    `json:"cwd"`
	ToolInput toolInput `json:"tool_input"`
}

type toolInput struct {
	Command  string `json:"command"`   // Bash
	FilePath string `json:"file_path"` // Edit/Write/MultiEdit
	Pattern  string `json:"pattern"`   // Grep
	Glob     string `json:"glob"`      // Grep
	Path     string `json:"path"`      // Grep
	Type     string `json:"type"`      // Grep
}

// readTypedPayload decodes raw stdin bytes into the typed payload. Each caller
// decides whether a failure means fail open or fail closed, because the answer
// differs by hook.
func readTypedPayload(raw []byte) (p payload, why readFailure) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return p, readUnreadable
	}
	// A non-object payload (`null`, a bare string, an array) must be rejected,
	// not silently accepted as an empty struct. Unmarshalling `null` into a
	// struct succeeds and leaves every field zero, which would make a guard
	// exit 0 on input it never inspected.
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return p, readUnparseable
	}
	if _, isObject := v.(map[string]any); !isObject {
		return p, readNotAnObject
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, readUnparseable
	}
	return p, readOK
}

// deny emits the current PreToolUse deny contract and exits 0. The older
// top-level `decision: "block"` field is deprecated, and exit-code-2 blocking
// is unreliable for Edit/Write tool calls.
//
// The envelope is hand-assembled by emitPermissionDecision, which does not
// escape `<` and `>` — the default Go encoder would rewrite them as < and
// >, mangling placeholders the reason text tells the user to type. These
// reasons are read by a human, not embedded in HTML.
func deny(reason string) {
	emitPermissionDecision("deny", reason)
	os.Exit(0)
}
