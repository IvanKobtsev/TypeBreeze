# Resolver architecture decision

## Decision

The public JetBrains resolver spike was rejected after real WebStorm 2026.2
sessions returned no contextual type for representative literals even though
fixture tests passed. UnionBreeze now treats its Rust language server as the
sole semantic authority. No `ExpectedTypeEvaluator`, `JSType`, internal
TypeScript service, or reflective API is used by the shipping adapter.

## Boundary

`unionbreeze-typescript` extracts owned semantic facts from TypeScript source.
`unionbreeze-core` atomically replaces per-file contributions and resolves
finite domains. `unionbreeze-protocol` is the editor-neutral JSON/LSP contract,
including UTF-16 conversion. `unionbreeze-lsp` owns synchronization, workspace
indexing, and the two custom requests. The code in `editors/intellij` only
starts the server, translates editor positions, displays the closed popup, and
performs an undoable token-content replacement.

The protocol is deliberately independent of JetBrains classes so a later VS
Code adapter can consume it unchanged.

## Safety policy

Results are returned only when every alias branch resolves to 2–100 distinct
string literals and the current value belongs to that domain. Unsupported,
open, cyclic, ambiguous, or unresolved contexts return `null`. Literal members
inside declarations are included in `documentUnions` as declarations, with an
empty assignable-member list, and are never switchable in v1.
