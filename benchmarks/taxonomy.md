# Bug taxonomy (v1)

The closed list of plantable bug classes. `schema.mjs#TAXONOMY` is the source of
truth; this file documents each class. Adding a class = edit both + bump this
header's version.

| class | planted defect |
|---|---|
| logic-inversion | a condition or comparison flipped (`<` vs `>=`, `!` added/dropped) |
| off-by-one | boundary index/loop/slice off by one |
| wrong-constant | a magic value subtly wrong (unit multiplier, limit, default) |
| swallowed-error | a failure path silently absorbed (empty catch, default return) |
| null-path | missing null/undefined guard on a reachable path |
| weakened-test | a test changed so it passes trivially (assertion loosened/removed) |
| missing-await | an async result used without awaiting; race or lost rejection |
| resource-leak | handle/listener/timer acquired but not released on a path |
| unsafe-input | untrusted input reaches a sink unvalidated (path, query, exec) |
| api-misuse | a real API used against its contract (wrong arg order, ignored return) |
