# js-hcl2 — Design Document

## 1. Purpose & Scope

`@cruglobal/js-hcl2` is a TypeScript library that **parses and encodes** HashiCorp
Configuration Language v2 (HCL2). Unlike every existing npm package in this
space, it supports **both directions**: reading HCL into JS values *and*
emitting HCL from JS values, with an optional lossless round-trip mode that
preserves comments and formatting.

The public shape mirrors the built-in `JSON` and community `YAML` modules:

```ts
import * as HCL from "@cruglobal/js-hcl2";

const value = HCL.parse(source);           // HCL text -> JS value
const text  = HCL.stringify(value);        // JS value -> HCL text
```

A second, higher-fidelity API operates on a concrete syntax tree (the
**Document**):

```ts
const doc  = HCL.parseDocument(source);    // HCL text -> Document (CST)
const text = doc.toString();               // Document -> HCL text (lossless)
```

### In scope for v1.0

- HCL2 **native syntax** lexing and parsing (the `hclsyntax` subset of the
  official spec). JSON-syntax HCL is out of scope until v1.1.
- **Structural** parsing: config files, bodies, blocks, attributes, literal
  values, collections, templates, heredocs.
- **Expressions parsed-but-not-evaluated.** Every expression becomes an
  `Expression` AST node that preserves the original source text and a
  structural tree; callers that only need to read/write configuration do not
  need an evaluator. See §6.
- **Canonical stringify** from plain JS values (JSON-style).
- **Lossless round-trip** via `parseDocument` / `Document.toString` that
  preserves comments, trailing whitespace, attribute ordering, and block
  ordering. Edits made through the Document API preserve surrounding trivia.
- Pure TypeScript, zero runtime dependencies, ships ESM + CJS + `.d.ts`.
  Runs in Node.js, Bun, Deno, and modern browsers.

### Out of scope for v1.0 (planned follow-ups)

- **Expression evaluation** (arithmetic, conditionals, `for`, splat, function
  calls). Tracked as a future milestone; AST nodes are designed so the
  evaluator can be layered on without a breaking API change.
- **Built-in function library** (`file()`, `jsonencode()`, etc.).
- **JSON-syntax HCL** (the `.tf.json` dialect).
- **Type inference / schema decoding** (the Go `gohcl`/`hcldec` equivalents).
- **Source maps** for emitted HCL.

### Non-goals

- We do **not** try to be a drop-in replacement for the Go parser's internal
  APIs. We target idiomatic TS ergonomics.
- We do **not** provide Terraform-specific semantics (provider resolution,
  state, etc.). This is a *syntax* library.

---

## 2. Why pure TypeScript (vs WASM / native)

Considered alternatives:

| Approach                               | Pros                                         | Cons                                                        |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| WASM port of `hashicorp/hcl` (Go)      | Spec-accurate by construction                | Large `.wasm` blob, Go toolchain dep, JS↔WASM marshalling, still need a custom emitter, awkward in browsers |
| Native N-API binding                   | Fastest                                      | Node-only, per-platform prebuilds, blocks browser/Deno use  |
| Fork existing JS parser                | Fast start                                   | Inherits incomplete AST; existing ASTs lack trivia, blocking round-trip goals |
| **Pure TS, hand-written** *(chosen)*   | Works everywhere; zero deps; full control over CST/trivia; clean TS types | Must implement the spec ourselves; must keep up with upstream spec changes |

The decisive factor is the **lossless round-trip requirement**. No existing
JS parser retains trivia (comments, blank lines, whitespace between tokens),
and neither does the Go `hclsyntax` AST by default — it exposes `Range`s but
discards inter-token trivia. We need a concrete syntax tree designed
specifically for faithful re-printing, so we build it ourselves.

---

## 3. Public API

All names live under the default export and are also available as named
exports.

### 3.1 `HCL.parse(source, options?) => Value`

```ts
function parse(source: string, options?: ParseOptions): Value;

interface ParseOptions {
  /** File name used in error messages. Default: "<input>". */
  filename?: string;
  /** Throw on the first error (true) or collect all errors (false). Default: true. */
  bail?: boolean;
}
```

`Value` is a recursive union representing the parsed configuration in a
shape that is convenient for JS consumers:

```ts
type Value =
  | null | boolean | number | string
  | Value[]
  | { [key: string]: Value }
  | Expression;             // opaque, preserves source for any non-literal expression

interface Expression {
  readonly __hcl: "expression";
  readonly source: string;  // verbatim original text
  readonly kind:
    | "literal" | "template" | "tuple" | "object"
    | "variable" | "traversal" | "function-call"
    | "for" | "conditional" | "binary" | "unary"
    | "splat" | "parens";
  readonly ast: ExprNode;   // full structural AST (see §6)
}
```

Design notes:

- **Literal** values (strings, numbers, booleans, null, and collections
  containing only literal children) are returned as plain JS primitives, so
  `HCL.parse('name = "foo"')` yields `{ name: "foo" }` — matching user
  intuition from JSON.
- **Any expression that references variables, calls functions, or uses
  operators** is returned as an `Expression` object. Callers can inspect
  `.source` for display, or `.ast` for structural manipulation.
- **Block grouping.** HCL allows repeated blocks with the same labels
  (`resource "aws_s3_bucket" "a" {...}` and `resource "aws_s3_bucket" "b"
  {...}`). `parse` returns repeated blocks as an array:
  `{ resource: { aws_s3_bucket: { a: {...}, b: {...} } } }`. When a block
  appears only once, it is still nested by label. This matches the
  convention used by `hcl2-json-parser` and Terraform's JSON output.

### 3.2 `HCL.stringify(value, options?) => string`

```ts
function stringify(value: Value, options?: StringifyOptions): string;

interface StringifyOptions {
  /** Spaces per indent. Default: 2. */
  indent?: number;
  /** Preferred quote style for strings. Default: "double". */
  quotes?: "double";
  /** If true, emit a trailing newline. Default: true. */
  trailingNewline?: boolean;
  /** Sort object keys alphabetically. Default: false (preserves insertion order). */
  sortKeys?: boolean;
  /** Override how a specific JS value is encoded (like JSON.stringify's replacer). */
  replacer?: (key: string, value: unknown) => unknown;
}
```

Canonical, opinionated output. Round-trips are *not* guaranteed to be
byte-identical, but `parse(stringify(parse(x))) === parse(x)` (structural
equality) *is* guaranteed for any well-formed input.

### 3.3 `HCL.parseDocument(source, options?) => Document`

```ts
function parseDocument(source: string, options?: ParseOptions): Document;

class Document {
  toString(): string;                 // re-emit; byte-identical when unmodified
  toValue(): Value;                   // same shape as HCL.parse
  get(path: string | string[]): Node | undefined;
  set(path: string | string[], value: Value | Node): void;
  delete(path: string | string[]): boolean;
  readonly body: BodyNode;            // mutable CST root
}
```

Guarantees:

- `parseDocument(s).toString() === s` for any valid input (exact byte
  preservation — including comments, blank lines, tab/space mixes, CRLF line
  endings, and attribute/block ordering).
- Edits through `set`/`delete` preserve surrounding trivia: deleting one
  attribute in a block leaves comments on adjacent attributes intact.
- New nodes inserted via `set` are pretty-printed using `stringify`-style
  rules and placed with sensible default trivia (a single newline before,
  indentation matching the surrounding block).

### 3.4 Errors

All parse failures throw (or collect) `HCLParseError`:

```ts
class HCLParseError extends Error {
  filename: string;
  line: number;      // 1-based
  column: number;    // 1-based, in characters (not bytes)
  offset: number;    // 0-based byte offset
  snippet: string;   // one line of source with a caret marker
  errors: HCLParseError[]; // only populated when options.bail = false
}
```

---

## 4. Architecture

The pipeline is a straight-through chain, with the CST as the single source
of truth:

```
source text
   │
   ▼
┌─────────┐   tokens (with leading trivia attached)
│  Lexer  │──────────────────────────────┐
└─────────┘                              │
                                         ▼
                                  ┌────────────┐
                                  │   Parser   │
                                  └────────────┘
                                         │
                       ┌─────────────────┴─────────────────┐
                       ▼                                   ▼
               ┌──────────────┐                    ┌──────────────┐
               │ Document/CST │──── toValue() ────▶│  Value (JS)  │
               │ (trivia-aware)│                   │  (no trivia) │
               └──────────────┘                    └──────────────┘
                       │                                   │
                       │ toString()                        │ stringify()
                       ▼                                   ▼
                  HCL text (lossless)             HCL text (canonical)
```

Key architectural decisions:

1. **One parser, two views.** The parser always builds a CST. The plain-JS
   `Value` view is a lightweight projection over the CST. This avoids having
   to maintain two separate parse paths and guarantees `HCL.parse` and
   `HCL.parseDocument().toValue()` agree by construction.
2. **Trivia is attached to tokens, not nodes.** Each `Token` carries its
   `leadingTrivia` (whitespace + comments that precede it). This is the same
   model used by `roslyn`, `libsyntax` (Rust), and `tree-sitter`, and it is
   what makes lossless re-printing tractable.
3. **No external runtime deps.** Lexer and parser are hand-written. The only
   dev-time deps are TypeScript, a test runner (`vitest`), and a bundler
   (`tsup`).

---

## 5. Lexer

The lexer is a mode-tracking state machine over a Unicode code-point stream.
It emits a flat array of `Token`s; each token carries its kind, lexeme
(verbatim source slice), trivia, and `Range` (start/end offset, line,
column).

### 5.1 Token kinds

Grouped to match the HCL2 spec:

- **Literals**: `NUMBER`, `IDENT`.
- **Punctuation**: `LBRACE`, `RBRACE`, `LBRACK`, `RBRACK`, `LPAREN`,
  `RPAREN`, `COMMA`, `DOT`, `ELLIPSIS`, `COLON`, `QUESTION`, `FATARROW`.
- **Operators**: `PLUS`, `MINUS`, `STAR`, `SLASH`, `PERCENT`, `EQ`, `NEQ`,
  `LT`, `LE`, `GT`, `GE`, `AND`, `OR`, `BANG`, `ASSIGN` (`=`).
- **Template structure**: `OQUOTE`, `CQUOTE`, `QUOTED_LIT`, `TEMPLATE_INTERP`
  (`${`), `TEMPLATE_CONTROL` (`%{`), `TEMPLATE_SEQ_END` (`}` closing
  interpolation/control), `TEMPLATE_STRIP` (`~`), `HEREDOC_BEGIN`,
  `HEREDOC_END`. Heredoc body content uses the same `QUOTED_LIT` /
  `TEMPLATE_INTERP` / `TEMPLATE_CONTROL` vocabulary as quoted strings —
  there is no separate per-line heredoc token, because interpolations can
  appear mid-line.
- **Structural**: `NEWLINE`, `EOF`.
- **Synthetic**: `INVALID` (carries an error message for recovery).

### 5.2 Modes

The lexer tracks a stack of modes to handle context-sensitive tokens:

1. `NORMAL` — default. Parses identifiers, numbers, operators, etc.
2. `TEMPLATE` — inside a `"..."` quoted string or heredoc body. Most
   characters become template-literal text; `${`, `%{`, `\"`, `\n`,
   `\uNNNN`, `\\` are special.
3. `TEMPLATE_INTERP` — inside a `${ ... }`. Same as `NORMAL` but `}` pops
   back to `TEMPLATE`.
4. `TEMPLATE_CONTROL` — inside a `%{ ... }`. Same as `NORMAL` plus the
   keywords `if`/`else`/`endif`/`for`/`endfor`.

Heredocs are handled by detecting `<<IDENT` / `<<-IDENT` in `NORMAL` mode;
the body is scanned line-by-line in `TEMPLATE` mode until a line equal to
the delimiter (with optional leading whitespace for `<<-`) is found. The
lexer preserves the exact indentation so the parser can later compute the
strip amount required by `<<-`.

### 5.3 Newlines and statement termination

HCL is newline-sensitive at the top level of a body: `foo = 1 bar = 2` is
illegal, but `foo = 1\nbar = 2` is fine. The lexer emits explicit `NEWLINE`
tokens, but **suppresses them inside** balanced `()`, `[]`, and `{}` that
belong to an expression (not a block body). Matching is tracked with a
bracket stack; block bodies (`{...}` directly after a block header) are
distinguished from object constructors by the parser, so the lexer
conservatively emits newlines and the parser ignores them where
appropriate.

### 5.4 Trivia

Every `NEWLINE`, whitespace run, and comment attaches as `leadingTrivia` to
the next non-trivia token. Trailing trivia (same-line comments) attaches to
the *preceding* token. This asymmetric rule is what lets the printer keep
same-line comments with their attribute:

```hcl
foo = 1  # this stays on the foo line
```

---

## 6. Parser & AST

Hand-written recursive-descent parser. No generator.

### 6.1 Top-level grammar

Directly transcribes the HCL2 grammar:

```
ConfigFile := Body
Body       := (Attribute | Block)*
Attribute  := IDENT "=" Expression NEWLINE
Block      := IDENT (StringLit | IDENT)* "{" Body "}" NEWLINE
           |  IDENT (StringLit | IDENT)* "{" (IDENT "=" Expression)? "}" NEWLINE   -- one-liner
```

### 6.2 Expression parser

A standard Pratt parser over these productions:

```
Expression := Conditional
Conditional:= BinaryOr ("?" Expression ":" Expression)?
BinaryOr   := BinaryAnd ("||" BinaryAnd)*
BinaryAnd  := Equality  ("&&" Equality)*
Equality   := Comparison (("=="|"!=") Comparison)*
Comparison := Additive  (("<"|"<="|">"|">=") Additive)*
Additive   := Multiplicative (("+"|"-") Multiplicative)*
Multiplicative := Unary (("*"|"/"|"%") Unary)*
Unary      := ("-"|"!") Unary | Postfix
Postfix    := Primary (GetAttr | Index | Splat | Call)*
Primary    := Literal | CollectionCtor | TemplateExpr | ForExpr
           |  IDENT | "(" Expression ")"
```

### 6.3 AST node shapes

```ts
type ExprNode =
  | LiteralNode          // { kind: "literal", value: string|number|boolean|null }
  | TemplateNode         // { kind: "template", parts: TemplatePart[] }
  | TupleNode            // { kind: "tuple", items: ExprNode[] }
  | ObjectNode           // { kind: "object", items: ObjectItem[] }
  | VariableNode         // { kind: "variable", name: string }
  | TraversalNode        // { kind: "traversal", source: ExprNode, steps: Step[] }
  | FunctionCallNode     // { kind: "call", name: string, args: ExprNode[], expandFinal: boolean }
  | ForNode              // tuple-for or object-for; see §6.4
  | ConditionalNode      // { kind: "conditional", cond, then, else }
  | BinaryOpNode         // { kind: "binary", op, left, right }
  | UnaryOpNode          // { kind: "unary", op, operand }
  | SplatNode            // { kind: "splat", source, each: Step[], style: "attr" | "full" }
  | ParensNode;          // { kind: "parens", inner }
```

Each node also carries a `range: Range` and a reference to the first and
last underlying `Token` so the printer can emit the exact lexemes when
round-tripping.

### 6.4 Expression scope in v1.0

v1.0 **parses** all of the above but does not **evaluate** any of them.
That means:

- `HCL.parse('x = 1 + 2')` yields `{ x: Expression { source: "1 + 2", ... } }`,
  **not** `{ x: 3 }`.
- `HCL.parse('x = "a"')` yields `{ x: "a" }` — string templates with no
  interpolation evaluate to their literal value, since that is a purely
  lexical operation.
- `HCL.parse('x = "hello ${name}"')` yields
  `{ x: Expression { source: "\"hello ${name}\"", kind: "template", ... } }`.
- Collections that contain only literal children are returned as plain
  arrays/objects; any non-literal child promotes the whole collection to an
  `Expression` node.

This boundary is what lets v1.0 ship without an evaluator while still being
useful: the parse tree is complete, re-printable, and easy to reason about.

### 6.5 Error recovery

In `bail: false` mode, the parser synchronizes on `NEWLINE` and block
boundaries, records an `HCLParseError`, and continues. This powers
editor-friendly use cases (LSP implementations, config validators) without
requiring every downstream tool to tolerate exceptions.

---

## 7. CST (Document model)

The CST is a tree of `Node`s, each wrapping one or more `Token`s and/or
child `Node`s. Unlike the AST, the CST owns trivia and is designed for
mutation + reprint.

```ts
interface Node {
  kind: NodeKind;
  range: Range;
  // children + tokens are laid out in source order in a single array, so
  // reprint is a flat walk that emits trivia-then-lexeme for each token.
  parts: ReadonlyArray<Node | Token>;
}
```

Node kinds include `BodyNode`, `AttributeNode`, `BlockNode`,
`BlockLabelsNode`, `ExpressionNode` (wrapper around `ExprNode`),
`TemplateNode`, and so on.

### 7.1 Lossless re-printing

```
function print(node: Node): string {
  let out = "";
  for (const part of node.parts) {
    if (isToken(part)) {
      out += part.leadingTrivia;
      out += part.lexeme;
      out += part.trailingTrivia;
    } else {
      out += print(part);
    }
  }
  return out;
}
```

By construction, `print(parseDocument(s).root) === s`.

### 7.2 Editing API

`Document.set(path, value)` implements the following contract:

- If `path` resolves to an existing attribute, replace its value node. The
  new value is formatted via the canonical printer (see §8) but inherits the
  old attribute's leading trivia (comments above it) and trailing trivia
  (same-line comments).
- If `path` does not exist, insert a new `AttributeNode` at the end of the
  enclosing body, with indentation matching the body's first existing
  attribute (or a default of two spaces if the body is empty). A newline is
  inserted before it so it does not fuse with the preceding token.
- `delete(path)` removes the node *and* its leading trivia up to (but not
  including) the preceding newline, so deleting the second attribute of
  three does not leave a blank gap.

---

## 8. Canonical printer (stringify)

A small, opinionated printer used by both `HCL.stringify` and
`Document.set` when inserting new subtrees.

Rules:

1. **Indentation**: `options.indent` spaces per nesting level. Tabs are not
   emitted.
2. **Blocks**: `label1 "label2" {\n  body\n}`. One space between labels; one
   space before `{`. Opening brace at end of header line; closing brace on
   its own line at the parent indent.
3. **Attributes**: `name = value`. Single space around `=`. When multiple
   attributes appear in a body, the `=` signs are **not** column-aligned in
   v1.0 (matches `terraform fmt` behavior: alignment is done per-group with
   blank-line separators, which is a rabbit hole; canonical output uses
   single-space alignment).
4. **Strings**: double-quoted with minimal escaping. Newlines inside become
   `\n`. If a string contains more than two `\n`s or is longer than 80
   columns, the printer emits a heredoc.
5. **Numbers**: printed with `toString()`; no locale formatting. Non-finite
   numbers (`NaN`, `Infinity`) are encoded as `null` by default (configurable
   via `replacer`).
6. **Tuples**: `[a, b, c]` on one line if total width < 80 cols, otherwise
   one item per line with trailing commas.
7. **Objects**: same wrapping rule as tuples. Keys that are valid HCL
   identifiers are emitted bare (`foo = 1`); keys that are not are emitted
   as quoted strings (`"foo-bar" = 1`). HCL's `=` vs `:` ambiguity: the
   printer always uses `=` for object literals, matching `terraform fmt`.
8. **Block grouping**: when a JS object's value is itself an object with
   non-identifier keys at the second level, the printer emits a nested
   block. When the value is an array of objects (and the key names are
   valid identifiers), it emits multiple blocks with the same name, matching
   the parse-time grouping from §3.1.

### 8.1 Expression round-trip

When an `Expression` object appears in the input to `stringify`, the
printer emits its `.source` verbatim, with a best-effort re-indent of
multi-line expressions. This means
`stringify(parse(x))` preserves every user-written expression exactly.

---

## 9. Testing strategy

1. **Lexer unit tests** — one token kind per test, including edge cases
   (identifiers with hyphens, heredocs with strip markers, nested templates,
   Unicode identifiers).
2. **Parser unit tests** — one grammar production per test, positive and
   negative.
3. **Corpus tests** — vendored from `hashicorp/hcl`'s testdata directory
   and `terraform`'s config fixtures. For each file `f`:
   - `parse(f)` does not throw.
   - `parse(stringify(parse(f)))` is structurally equal to `parse(f)`.
   - `parseDocument(f).toString() === f` (byte equality).
4. **Property-based tests** (`fast-check`) — generate random `Value`s and
   assert `parse(stringify(v))` is structurally equal to `v`.
5. **Browser smoke test** — one Playwright test that imports the ESM build
   in a headless Chromium page and parses a Terraform fixture.
6. **Compatibility cross-check** — for a subset of the corpus, compare
   `parse(f)` against `hcl2-json-parser`'s output to catch regressions in
   our interpretation of block grouping.

---

## 10. Packaging & distribution

- **Language**: TypeScript 5.x, `strict: true`.
- **Module formats**: dual ESM + CJS via `tsup` bundler, with `.d.ts` for
  both entry points.
- **Targets**: ES2022. Uses only standard lib types (no Node-specific APIs
  in the library; tests may use Node).
- **Toolchain management**: [`asdf`](https://asdf-vm.com/) pins the
  development Node.js version via a committed `.tool-versions` file at the
  repo root (`nodejs 24.x` — latest `24.*` LTS minor at pin time). Every
  contributor and CI runner resolves the same interpreter by running
  `asdf install`. Node.js 24.x is the **development** runtime; the shipped
  library remains runtime-agnostic (see "Targets" above).
- **Package name**: `@cruglobal/js-hcl2`, published under the
  [`cruglobal`](https://www.npmjs.com/org/cruglobal) npm organization. The
  repo directory name (`js-hcl2`) mirrors the unscoped portion.
- **Entry points**:
  - `import { parse, stringify, parseDocument } from "@cruglobal/js-hcl2"`
  - `import HCL from "@cruglobal/js-hcl2"` (default export exposing the same)
- **Semver**: pre-1.0 until the AST shape stabilizes and a full corpus
  passes; post-1.0 the AST is part of the public contract.
- **License**: BSD-3-Clause. HCL2 is a *specification*, not a software
  library we link against — implementing it from scratch in TypeScript does
  not make this project a derivative work of the MPL-2.0-licensed
  `hashicorp/hcl` source. Vendored test fixtures under
  `test/corpus/hashicorp-hcl/` retain their original MPL-2.0 notice and are
  isolated from the shipped library (excluded from the published npm
  tarball via `files` / `.npmignore`).

---

## 11. Future milestones (post-v1.0)

Tracked in detail in `docs/milestones.md`; summary:

- **v1.1** — JSON-syntax HCL (`.tf.json`) support in the same `parse` /
  `stringify` entry points, with a `syntax: "json" | "native"` option.
- **v1.2** — Expression *evaluator*: optional `HCL.evaluate(expr, ctx)` that
  resolves variables, performs arithmetic/conditionals/for, and runs a
  pluggable function table. `HCL.parse(src, { evaluate: ctx })` returns
  fully-evaluated primitives when `ctx` is provided.
- **v1.3** — Built-in standard library of functions matching
  `hashicorp/hcl/ext/funcs` (e.g. `jsonencode`, `length`, `lookup`).
- **v1.4** — Schema-directed decoding (`HCL.decode(src, schema)`), analogous
  to Go's `gohcl`, emitting typed TS objects with good error messages.
- **v1.5** — LSP-quality incremental re-parsing for editor integrations,
  plus source-maps from emitted HCL back to input JS object paths.
- **Exploratory** — consider a WASM-backed "strict" parser that wraps
  `hashicorp/hcl` as an optional peer-dependency for users who need
  bit-for-bit spec compatibility. Only pursued if real-world divergences
  are reported against the hand-written parser.

---

## 12. Risks & open questions

- **Spec drift.** HCL2 is a living spec in `hashicorp/hcl`. We pin to a
  specific commit for v1.0 and add a CI job that diffs the spec file on a
  schedule, opening an issue when upstream changes.
- **Block-grouping ambiguity.** Some HCL users rely on ordered lists of
  blocks (for `terraform` `provisioner` sequences). The v1.0 `Value` layer
  groups by label and then collects duplicates into an array — which is
  lossy for blocks that have no labels *and* repeat (rare, but exists in
  `dynamic` blocks). The `Document` layer is always lossless; the `Value`
  layer documents this limitation explicitly.
- **Heredoc indentation.** The `<<-` strip rule requires two-pass
  processing (scan all lines to find the minimum common indent, then strip
  that from each). The printer must decide whether to re-emit as `<<-` or
  `<<` based on whether the value's lines have a common prefix of
  whitespace; an explicit `hcl.heredoc(...)` helper in the API lets callers
  force one or the other.
- **Unicode identifiers.** UAX #31 requires shipping a small Unicode table.
  We embed a precomputed, compressed range set (≈4 KB gzipped); no runtime
  dependency on `Intl` or ICU.
