# TypeBreeze

TypeBreeze enhances the TypeScript editing experience in WebStorm with
compiler-backed extension-method suggestions and dedicated union tools.

## Extension methods

Put ordinary functions in project files ending in **`.ext.ts`** or **`.ext.tsx`**
and explicitly annotate their first argument:

```ts
// strings.ext.ts
export function truncate(value: string, length: number): string {
  return value.slice(0, length);
}

export const upper = (value: string) => value.toUpperCase();
```

Type `title.` or invoke basic completion after `title.tr` to find compatible
functions alongside normal members. Selecting `upper` produces `upper(title)`
and adds its import. Selecting `truncate` produces `truncate(title, )`, with the
caret ready for the remaining argument and WebStorm parameter information.
The call and import are one undoable edit.

Suggestions use TypeScript's structural types, narrowing, generic inference,
and overload resolution. Receivers can also be expressions such as `user.name`,
`getUser()`, or `items[0]`; the generated call evaluates the receiver once.
Named functions, arrow functions, function expressions, named/default exports,
and accessible local functions are supported. Existing imports and aliases are
reused, and name collisions receive an import alias.

Discovery follows the active file's TypeScript project configuration and includes
unsaved source. Dependency packages, declaration files, excluded files, anonymous
default exports, unannotated or rest receivers, and functions requiring a bound
`this` are not extension candidates. This version handles ordinary dot access;
optional chains do not offer extension suggestions. Generated code remains plain
TypeScript and needs no TypeBreeze runtime.

## Union tools

TypeBreeze gives finite TypeScript string unions a dedicated closed-set member
switcher in WebStorm. Place the caret on a contextually typed string literal and
invoke **Change Union Member** through Alt+Enter or **Alt+Shift+U**.

Union members are styled separately from ordinary string literals. Declaration
and usage styling can be enabled independently under **Settings | TypeBreeze**,
and their colors/effects are configured under **Editor | Color Scheme |
TypeBreeze**. Standard **Go to Declaration** navigation goes from a usage to
its exact member declaration and from a declaration to its matching usages;
Multiple declaration usages open in WebStorm's native **Show Usages** popup,
with its standard code preview and navigation controls. A single usage is
navigated to directly. Hover documentation identifies the literal's union and
available members.

Highlighting is published before the workspace usage scan finishes. Unused
declaration fading and declaration-to-usage navigation become available when
that second pass completes.

Use WebStorm's standard **Rename** command (`Shift+F6`) on a union member
declaration or recognized usage to rename that member across its domain. The
refactoring changes only literals that TypeScript resolves to the same declared
union, validates every source token before writing, and applies all files as one
undoable command. Unrelated identical strings are left untouched.

Use **Alt+Enter → Enum to Union** on an enum declaration to convert it and its
project references in one undoable operation. Values come from member names,
not the old numeric or string initializers: `enum Status { draft = 10, live = 20 }`
becomes `type Status = 'draft' | 'live'`. Member accesses become string literals,
and computed object keys such as `[Status.draft]` become `draft`.

The enum name, exports, member order, and comments are preserved. When object
uses remain (for example `Object.values(Status)` or `typeof Status`), the action
also creates a same-named `const` object checked with
`as const satisfies { [K in Status]: K; }`. Type annotations alone do not require
that object. Imports are removed when their last binding is removed; existing
side-effect-only imports are left unchanged.
Open unsaved documents are included in the plan. Reverse numeric lookups, member
writes, ambient or merged declarations, and conversions that introduce TypeScript
errors are rejected with an explanation. References outside the active project's
editable workspace are not rewritten.

TypeScript semantics are provided by an editor-neutral Rust language server,
which supervises a bundled compiler worker using the project's TypeScript
installation. The worker asks TypeScript directly for each literal's contextual
type. The WebStorm plugin is a thin LSP and popup adapter and does not use
JetBrains TypeScript type-resolution APIs.

The resolver accepts contextual types whose assignable values reduce entirely
to 2–100 string literals (apart from `null`/`undefined` introduced by optional
contexts). Because TypeScript performs the contextual resolution, mapped and
utility types, generics, imports, path mappings, and nested object arguments do
not need TypeBreeze-specific traversal rules.

## Development

The project targets WebStorm 2026.2.1 (`262.9437.145`) and requires Rust stable,
Gradle 9.4.1, and JDK 25.

```text
cargo fmt --all --check
npm ci
npm run test:compiler-worker
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build -p typebreeze-lsp
gradle -p editors/intellij test
gradle -p editors/intellij runIde
gradle -p editors/intellij verifyPlugin
```

For local IDE development, set `TYPEBREEZE_SERVER_PATH` to the freshly built
server executable. Release CI builds all six supported OS/architecture binaries,
bundles them into the plugin ZIP, and uploads both the binaries and installable
`typebreeze-webstorm-plugin` artifact on every push and pull request.

TypeBreeze uses plugin identity `dev.typebreeze`. The rename intentionally does
not migrate settings or identifiers from the former plugin identity.

For verification against the already cached build-target IDE, use
`gradle -p editors/intellij verifyPlugin -Ptypebreeze.verifyCurrentIde=true`.
CI continues to verify against the recommended compatible IDE releases.
