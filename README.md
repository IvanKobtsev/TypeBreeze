# UnionBreeze

UnionBreeze gives finite TypeScript string unions a dedicated closed-set member
switcher in WebStorm. Place the caret on a contextually typed string literal and
invoke **Change Union Member** through Alt+Enter or **Alt+Shift+U**.

Union members are styled separately from ordinary string literals. Declaration
and usage styling can be enabled independently under **Settings | UnionBreeze**,
and their colors/effects are configured under **Editor | Color Scheme |
UnionBreeze**. Standard **Go to Declaration** navigation goes from a usage to
its exact member declaration and from a declaration to its matching usages;
Declaration usages open in a resizable popup with file and line labels and a
syntax-highlighted source preview. Select a result to preview it; press Enter or
double-click to navigate. Hover documentation identifies the literal's union
and available members.

Highlighting is published before the workspace usage scan finishes. Unused
declaration fading and declaration-to-usage navigation become available when
that second pass completes.

Use WebStorm's standard **Rename** command (`Shift+F6`) on a union member
declaration or recognized usage to rename that member across its domain. The
refactoring changes only literals that TypeScript resolves to the same declared
union, validates every source token before writing, and applies all files as one
undoable command. Unrelated identical strings are left untouched.

TypeScript semantics are provided by an editor-neutral Rust language server,
which supervises a bundled compiler worker using the project's TypeScript
installation. The worker asks TypeScript directly for each literal's contextual
type. The WebStorm plugin is a thin LSP and popup adapter and does not use
JetBrains TypeScript type-resolution APIs.

The resolver accepts contextual types whose assignable values reduce entirely
to 2–100 string literals (apart from `null`/`undefined` introduced by optional
contexts). Because TypeScript performs the contextual resolution, mapped and
utility types, generics, imports, path mappings, and nested object arguments do
not need UnionBreeze-specific traversal rules.

## Development

The project targets WebStorm 2026.2.1 (`262.9437.145`) and requires Rust stable,
Gradle 9.4.1, and JDK 25.

```text
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build -p unionbreeze-lsp
gradle -p editors/intellij test
gradle -p editors/intellij runIde
gradle -p editors/intellij verifyPlugin
```

For local IDE development, set `UNIONBREEZE_SERVER_PATH` to the freshly built
server executable. Release CI builds all six supported OS/architecture binaries,
bundles them into the plugin ZIP, and uploads both the binaries and installable
`unionbreeze-webstorm-plugin` artifact on every push and pull request.
