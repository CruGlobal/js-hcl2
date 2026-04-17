# Migrating from `hcl2-parser` / `hcl2-json-parser`

Short guide for teams switching to `@cruglobal/js-hcl2` from one of the
older JS readers (`hcl2-parser`, `hcl2-json-parser`, or the `hcl-parser`
shim). The core differences fall in three buckets: the API shape, how
expressions are represented, and how block grouping is surfaced.

## 1. API shape

| `hcl2-json-parser`                          | `@cruglobal/js-hcl2`                   |
| ------------------------------------------- | -------------------------------------- |
| `parseToObject(text): Promise<object>`      | `parse(text): Value` (synchronous)     |
| `parseToString(text): Promise<string>`      | `parseDocument(text).toValue()` or `parse(text)` then `JSON.stringify`. For canonical HCL output, use `stringify(value)`. |
| Errors thrown as plain `Error`              | Errors thrown as `HCLParseError` with `filename` / `line` / `column` / `snippet` / `errors[]`. |
| WASM-backed, async bootstrap                | Pure TS, synchronous.                  |

Typical migration:

```ts
// Before (hcl2-json-parser)
import { parseToObject } from "hcl2-json-parser";
const data = await parseToObject(text);

// After (@cruglobal/js-hcl2)
import { parse } from "@cruglobal/js-hcl2";
const data = parse(text);
```

## 2. Expression representation

`hcl2-json-parser` emits any non-literal expression as a string prefixed
with `${…}`:

```js
// hcl2-json-parser
parseToObject("x = 1 + 2\n");
// → { x: "${1 + 2}" }
```

`@cruglobal/js-hcl2` returns a structured `Expression` wrapper instead,
preserving both the verbatim source and the full AST:

```ts
// @cruglobal/js-hcl2
parse("x = 1 + 2\n");
// → { x: { __hcl: "expression", kind: "binary", source: "1 + 2", ast: … } }
```

Detect wrappers with the `isExpression` type guard:

```ts
import { isExpression, parse } from "@cruglobal/js-hcl2";

const v = parse(source) as Record<string, unknown>;
const expr = v.tags;
if (isExpression(expr)) {
  console.log(expr.source); // original HCL text
  console.log(expr.kind);   // "binary" | "call" | "template" | …
  // expr.ast is the structural AST; see docs/design.md §6.3
}
```

If you were previously stripping the `${…}` wrapper and re-parsing,
you can now walk `expr.ast` directly — the expression's internal
structure is available without another parse step.

## 3. Block grouping

`hcl2-json-parser` always wraps block instances in an array, even when a
block appears exactly once:

```js
// hcl2-json-parser
parseToObject('resource "t" "n" {}\n');
// → { resource: { t: { n: [{}] } } }
```

`@cruglobal/js-hcl2` collapses single blocks to a bare object and
collects only real duplicates into arrays:

```ts
// @cruglobal/js-hcl2
parse('resource "t" "n" {}\n');
// → { resource: { t: { n: {} } } }

parse('resource "t" "n" {}\nresource "t" "n" {}\n');
// → { resource: { t: { n: [{}, {}] } } }
```

If your downstream code unconditionally indexes `[0]` into single-block
values, add a `Array.isArray` check at the boundary.

## 4. Emitting HCL (new capability)

Neither `hcl2-parser` nor `hcl2-json-parser` emits HCL. If you were
building strings by hand, you can now round-trip:

```ts
import { parse, stringify } from "@cruglobal/js-hcl2";

const v = parse(source);
// mutate v freely
v.tags = { ...v.tags, env: "prod" };
const updated = stringify(v);
```

For edits that must preserve comments, blank lines, and original
formatting, use `parseDocument` instead:

```ts
import { parseDocument } from "@cruglobal/js-hcl2";

const doc = parseDocument(source);
doc.set(["resource", "aws_s3_bucket", "main", "acl"], "public");
const updated = doc.toString();
```

See the README for the full `Document` editing API.

## 5. Error handling

The new `HCLParseError` carries structured position info you can format
however you like:

```ts
import { HCLParseError, parse } from "@cruglobal/js-hcl2";

try {
  parse(source, { filename: "main.tf", bail: false });
} catch (e) {
  if (e instanceof HCLParseError) {
    for (const err of e.errors) {
      console.error(
        `${err.filename}:${err.line}:${err.column}: ${err.message}`,
      );
      console.error(err.snippet);
    }
  }
}
```

Pass `bail: false` to collect every error instead of throwing on the
first one.

## 6. Out-of-scope parity (for now)

`@cruglobal/js-hcl2` v0.x parses every HCL2 expression form but does
not **evaluate** expressions. If your workflow relies on the earlier
parsers' partial evaluation of simple expressions (e.g., folding
numeric operators), you'll continue to see the `Expression` wrapper
until a future evaluator milestone lands. The wrapper exposes the full
AST, so you can walk and evaluate yourself if needed.
