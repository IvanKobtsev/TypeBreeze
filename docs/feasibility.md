# Public API feasibility gate

## Decision

UnionBreeze's first resolver uses the public JavaScript/TypeScript APIs bundled
with WebStorm 2026.2.1. A direct TypeScript-service integration is not used.

The following 2026.2.1 classes and methods were inspected from the WebStorm
distribution and are not annotated `ApiStatus.Internal`,
`IntellijInternalApi`, or `ApiStatus.Experimental`:

- `ExpectedTypeEvaluator(PsiElement, JSExpectedTypeKind)` and
  `findExpectedType()`
- `JSType` and `JSType.getSourceElement()`
- `JSUnionOrIntersectionType`, `isUnionType()`, and `getTypes()`
- `JSPrimitiveLiteralType` and `getLiteral()`
- TypeScript literal-union and type-alias PSI interfaces

`TypeScriptServiceResolveFacade` is explicitly annotated
`ApiStatus.Internal`. UnionBreeze must not import it, invoke it reflectively, or
copy its protocol. The public expected-type evaluator may internally select the
service-powered engine; that remains WebStorm's implementation detail.

## Acceptance gate

The public resolver is accepted only when `PublicApiUnionResolverTest` passes
all of these cases on WebStorm 2026.2.1:

1. Direct type annotation.
2. Function argument.
3. Typed object property.
4. Imported type alias.
5. Rejection of an ordinary string.
6. Rejection of a union containing broad `string`.
7. Quote-preserving replacement and Undo.

`verifyPlugin` must additionally report no internal or experimental API use.
If either condition fails, feature work stops and the resolver is replaced by
the approved Rust language-server design. A failed local build caused by the
build host itself is not evidence that the API gate failed.

## Current scope

The resolver accepts only unions whose fully returned branches are string
literal types, contain 2–100 distinct values, and include the literal currently
under the caret. It rejects intersections, primitive `string`, mixed unions,
unresolved types, and all other computed shapes. Duplicate members retain their
first returned occurrence.
