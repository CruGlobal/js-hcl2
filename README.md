# @cruglobal/js-hcl2

[![npm](https://img.shields.io/npm/v/@cruglobal/js-hcl2.svg)](https://www.npmjs.com/package/@cruglobal/js-hcl2)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)

> **Status: AI-generated, not actively maintained.** This library was
> authored primarily by an AI assistant against the specification in
> [`docs/design.md`](docs/design.md) and is not on anyone's active
> roadmap. Dependabot keeps dependencies and security advisories up to
> date automatically (patch + minor bumps auto-merge; majors require
> manual review), but feature work, bug fixes, and other changes
> happen on a best-effort basis. **Pull requests and issues are
> welcome** — they may take time to be reviewed. See
> [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution workflow.

Parse and encode [HashiCorp Configuration Language v2](https://github.com/hashicorp/hcl) (HCL2)
in TypeScript. Unlike every other npm HCL2 reader, this library supports both
directions — reading HCL into JS values *and* emitting HCL from JS values —
plus a **lossless round-trip** `Document` API that preserves comments and
formatting across edits.

```ts
import * as HCL from "@cruglobal/js-hcl2";

// Parse
HCL.parse('name = "demo"\nport = 8080\n');
// → { name: "demo", port: 8080 }

// Emit
HCL.stringify({ name: "demo", port: 8080 });
// → 'name = "demo"\nport = 8080\n'

// Edit while preserving trivia
const doc = HCL.parseDocument('# greeting\nname = "demo"\n');
doc.set("name", "production");
doc.toString();
// → '# greeting\nname = "production"\n'
```

Runs on Node.js, Bun, Deno, and modern browsers. Zero runtime dependencies.

---

## Install

```sh
npm install @cruglobal/js-hcl2
```

The package ships both ESM and CJS builds plus TypeScript `.d.ts`s. Pick
whichever your bundler or runtime prefers:

```ts
// ESM
import { parse, stringify, parseDocument } from "@cruglobal/js-hcl2";

// default export — same namespace
import HCL from "@cruglobal/js-hcl2";
HCL.parse(source);
```

```js
// CJS
const { parse, stringify, parseDocument } = require("@cruglobal/js-hcl2");
```

---

## Quickstart

### Parsing HCL into a plain JS value

```ts
import { parse } from "@cruglobal/js-hcl2";

parse(`
  terraform_version = "1.5.0"
  enabled           = true
  regions           = ["us-east-1", "us-west-2"]
`);
/*  {
      terraform_version: "1.5.0",
      enabled: true,
      regions: ["us-east-1", "us-west-2"],
    }
*/
```

Blocks — including Terraform's `resource "type" "name" { … }` shape —
project into nested objects. Repeated blocks with identical labels collect
into arrays:

```ts
parse(`
  resource "aws_s3_bucket" "a" { acl = "private" }
  resource "aws_s3_bucket" "b" { acl = "public" }
`);
/*  {
      resource: {
        aws_s3_bucket: {
          a: { acl: "private" },
          b: { acl: "public" },
        },
      },
    }
*/
```

Expressions that involve variables, operators, calls, or interpolated
templates don't collapse to primitives — they come back as an opaque
`Expression` wrapper with the original source and structural AST preserved:

```ts
import { isExpression, parse } from "@cruglobal/js-hcl2";

const v = parse('tags = merge(var.a, { env = "dev" })\n');
const expr = (v as Record<string, unknown>).tags;
if (isExpression(expr)) {
  expr.source; // → 'merge(var.a, { env = "dev" })'
  expr.kind;   // → "function-call"
  expr.ast;    // → full FunctionCallNode
}
```

### Emitting HCL from a plain JS value

```ts
import { stringify } from "@cruglobal/js-hcl2";

stringify({
  resource: {
    aws_s3_bucket: {
      a: { acl: "private" },
      b: { acl: "public" },
    },
  },
});
/*  resource "aws_s3_bucket" "a" {
      acl = "private"
    }
    resource "aws_s3_bucket" "b" {
      acl = "public"
    }
*/
```

`stringify` accepts JSON-style options:

```ts
stringify(value, {
  indent: 4,           // spaces per nesting level (default 2)
  sortKeys: true,      // alphabetize body and object keys
  trailingNewline: false,
  replacer: (key, val) => (key === "secret" ? undefined : val),
});
```

### Editing HCL with preserved comments and formatting

```ts
import { parseDocument } from "@cruglobal/js-hcl2";

const doc = parseDocument(`
  # Production database
  resource "aws_db_instance" "main" {
    engine = "postgres"
    engine_version = "15.3" # pinned to match prod
  }
`);

doc.set(["resource", "aws_db_instance", "main", "engine_version"], "16.1");
doc.set(["resource", "aws_db_instance", "main", "skip_final_snapshot"], true);

console.log(doc.toString());
// # Production database
// resource "aws_db_instance" "main" {
//   engine = "postgres"
//   engine_version = "16.1" # pinned to match prod
//   skip_final_snapshot = true
// }
```

`parseDocument(source).toString() === source` for any unedited input
(byte-identical). Edits preserve leading/trailing trivia around the
node being replaced or deleted.

---

## Public API

High-level surface. Full signatures and JSDoc in the generated TypeDoc
site.

| Entry point                     | Purpose                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `parse(source, options?)`       | Parse HCL text into a plain `Value`.                                       |
| `stringify(value, options?)`    | Emit canonical HCL text from a `Value`.                                    |
| `parseDocument(source, options?)` | Parse into a trivia-aware `Document` supporting lossless round-trip + edits. |
| `Document#toString()`           | Re-emit the CST (byte-identical when unedited).                            |
| `Document#toValue()`            | Same shape as `parse()`.                                                   |
| `Document#get(path)`            | Resolve a dotted / array path to a CST node.                               |
| `Document#set(path, value)`     | Replace an attribute's value or insert a new attribute.                    |
| `Document#delete(path)`         | Remove an attribute or whole block, cleaning surrounding trivia.           |

Lower-level building blocks are also exported — `SourceFile`, `lex`,
`Parser`, `parseExpr`, `print`, `toValue`, `exprToValue`,
`HCLParseError`, the full CST node type union (`BodyNode`,
`AttributeNode`, `BlockNode`, `ExprNode`, `TemplateNode`, etc.), and
the `Expression` wrapper type. See
[`docs/design.md`](docs/design.md) for how they fit together.

### Error reporting

Both `parse` and `parseDocument` throw `HCLParseError` on malformed
input. Each error carries `filename`, `line`, `column`, `offset`,
`range`, and a caret-marked `snippet`:

```ts
import { HCLParseError, parse } from "@cruglobal/js-hcl2";

try {
  parse("x = \n", { filename: "main.tf" });
} catch (e) {
  if (e instanceof HCLParseError) {
    console.error(`${e.filename}:${e.line}:${e.column}: ${e.message}`);
    console.error(e.snippet);
  }
}
```

Pass `{ bail: false }` to collect every error in one pass (thrown as an
aggregate `HCLParseError` whose `errors[]` has one entry per failure).

---

## Feature / compatibility matrix

### HCL2 native syntax (v0.1)

| Feature                                                | Supported | Notes |
| ------------------------------------------------------ | :-------: | ----- |
| Attributes                                             | ✅        |       |
| Blocks (0 / 1 / 2 / 3+ labels)                         | ✅        |       |
| One-liner blocks (`block { k = v }`)                   | ✅        |       |
| Line comments (`#`, `//`)                              | ✅        |       |
| Block comments (`/* … */`)                             | ✅        |       |
| Primitive literals: number, bool, `null`, string       | ✅        | Numbers are finite JS doubles; NaN/Infinity encode as `null` on emit. |
| Quoted strings with escapes (`\n \t \" \\ \uNNNN`)     | ✅        |       |
| Heredocs (`<<EOT … EOT`)                               | ✅        |       |
| Heredoc strip form (`<<-EOT`)                          | ✅        | Recognised structurally; body content stored verbatim (strip happens at evaluation time — see below). |
| Tuple and object literals (with trailing commas)       | ✅        |       |
| Traversal (`.attr`, `[expr]`, legacy `.digit`)         | ✅        |       |
| Attribute splat (`a.*.b`) and full splat (`a[*].b`)    | ✅        |       |
| Function calls (`f(a, b, c...)`)                       | ✅        |       |
| Unary `-` / `!`                                        | ✅        |       |
| Binary `+ - * / % == != < <= > >= && \|\|`             | ✅        |       |
| Conditional `cond ? then : else`                       | ✅        |       |
| For expressions (tuple + object form with `if`, `...`) | ✅        |       |
| Template interpolation (`${…}`) in strings + heredocs  | ✅        |       |
| Template control directives (`%{if}`, `%{for}`)        | ✅        |       |
| Strip markers (`${~ ~}`, `%{~ ~}`)                     | ✅        |       |
| Unicode identifiers (UAX #31) + dash in ID_Continue    | ✅        |       |

### Out of scope for v0.x

| Feature                              | Status   | Tracked as |
| ------------------------------------ | -------- | ---------- |
| Expression **evaluation**            | ⏳        | Future milestone — everything non-literal is returned as an `Expression` wrapper rather than reduced to a primitive. |
| Standard function library (`jsonencode`, `merge`, …) | ⏳ | Requires evaluator. |
| JSON-syntax HCL (`.tf.json`)         | ⏳        | Planned for v0.2. |
| Schema-directed decoding (Zod-style) | ⏳        | Later sub-package. |

### Runtime matrix

| Runtime            | Supported | CI-enforced |
| ------------------ | :-------: | :---------: |
| Node.js 18+        | ✅        | ✅ (24.x)   |
| Bun 1.x            | ✅        | ✅          |
| Deno 2.x           | ✅        | ✅          |
| Modern browsers (ES2022) | ✅  | Smoke via happy-dom |

---

## Development

This repo uses [`asdf`](https://asdf-vm.com/) to pin the exact Node.js
version (see [`.tool-versions`](.tool-versions)). After cloning:

```sh
asdf plugin add nodejs   # one-time, if not already set up
asdf install
npm install
npm test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow and
[`docs/design.md`](docs/design.md) for the architectural overview.

---

## License

[BSD-3-Clause](LICENSE). Test fixtures vendored from external projects
retain their original licenses; see [`NOTICES.md`](NOTICES.md) for
attributions. Vendored fixtures are excluded from the published npm
tarball.
