# UnionBreeze

UnionBreeze gives finite TypeScript string unions a dedicated closed-set member
switcher in WebStorm. Place the caret on a contextually typed string literal and
invoke **Change Union Member** through Alt+Enter or **Alt+Shift+U**.

The initial implementation deliberately uses only public APIs from WebStorm's
bundled JavaScript and TypeScript plugin. It supports closed string-literal
unions and fails silently for open, mixed, unresolved, or single-member types.

## Development

The project targets WebStorm 2026.2.1 (`262.9437.145`) and requires JDK 25.

```text
gradle test
gradle runIde
gradle verifyPlugin
```

The resolver is isolated behind `UnionResolver`. If the public WebStorm API
fails the acceptance suite, that implementation can be replaced by the planned
Rust language-server adapter without changing the editor action.
