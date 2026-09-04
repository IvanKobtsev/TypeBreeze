# UnionBreeze

UnionBreeze gives finite TypeScript string unions a dedicated closed-set member
switcher in WebStorm. Place the caret on a contextually typed string literal and
invoke **Change Union Member** through Alt+Enter or **Alt+Shift+U**.

TypeScript semantics are provided by the bundled, editor-neutral Rust language
server. The WebStorm plugin is a thin LSP and popup adapter and does not use
JetBrains TypeScript type-resolution APIs. Declaration literals are indexed but
are intentionally not switchable.

The current resolver supports explicit variable annotations, unambiguous
explicitly typed function parameters, typed object properties, `satisfies`,
local aliases, and named imports. It fails closed for broad, mixed, computed,
cyclic, generic, overloaded, unresolved, or oversized domains.

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
