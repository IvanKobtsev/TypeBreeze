# Resolver architecture decision

## Decision

The public JetBrains resolver spike was rejected after real WebStorm 2026.2
sessions returned no contextual type for representative literals even though
fixture tests passed. UnionBreeze now treats its Rust language server as the
sole semantic authority. No `ExpectedTypeEvaluator`, `JSType`, internal
TypeScript service, or reflective API is used by the shipping adapter.

## Boundary

`unionbreeze-lsp` owns synchronization and supervises an embedded JavaScript
worker. That worker loads the workspace's TypeScript compiler, builds an
incremental `Program`, and calls `TypeChecker.getContextualType()` for string
literals. Rust validates and transports the results through the editor-neutral
protocol. The code in `editors/intellij` only starts the server, caches document
results, displays the closed popup, and performs an undoable replacement.

The protocol is deliberately independent of JetBrains classes so a later VS
Code adapter can consume it unchanged.

## Safety policy

Results are returned only when every alias branch resolves to 2–100 distinct
string literals and the current value belongs to that domain. Unsupported,
open, cyclic, ambiguous, or unresolved contexts return `null`. Literal members
inside declarations are included in `documentUnions` as declarations, with an
empty assignable-member list, and are never switchable in v1.
