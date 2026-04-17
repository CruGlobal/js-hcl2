# js-hcl2 — Implementation Milestones

Each milestone is **self-contained** and designed to be picked up by Claude
Code as a single unit of work: it has a clear entry state, a clear exit
state, explicit deliverables, and a test bar that must be green before
merging. Milestones within a major version are ordered; dependencies are
called out where they exist.

Sizing convention:

- **S** ≈ a half-day session
- **M** ≈ a full-day session
- **L** ≈ 2–3 sessions

---

## v1.0 — Syntax parsing, canonical emit, lossless round-trip

### M0 — Project scaffolding  *(S)*

**Goal.** A buildable, testable, publishable skeleton repo.

**Deliverables.**

- `.tool-versions` committed at the repo root pinning `nodejs 24.x`
  (latest `24.*` LTS minor at pin time). [`asdf`](https://asdf-vm.com/)
  is the required local toolchain manager; contributors run
  `asdf install` from the repo root to provision Node.js 24.x.
- `package.json` with `"name": "@cruglobal/js-hcl2"`,
  `"publishConfig": { "access": "public" }` (required for scoped public
  packages), `"engines": { "node": ">=24.0.0" }` for the dev toolchain,
  and scripts: `build`, `test`, `test:watch`, `typecheck`, `lint`,
  `format`.
- TypeScript 5.x, `tsconfig.json` with `strict: true`, `target: ES2022`,
  `moduleResolution: "bundler"`.
- `tsup.config.ts` producing dual ESM + CJS outputs with `.d.ts` for both.
- `vitest.config.ts` with coverage reporter.
- `eslint.config.js` (flat config, ESLint 9+) + `.prettierrc` config.
- `src/index.ts` with stub exports: `parse`, `stringify`, `parseDocument`
  (each throwing `NotImplementedError` for now).
- GitHub Actions CI workflow at `.github/workflows/ci.yml` that installs
  `asdf` (via `asdf-vm/actions/install@v3` or equivalent) and runs
  `asdf install` to read `.tool-versions`, so CI uses the exact Node.js
  version committed in the repo — not a separately-pinned
  `actions/setup-node` matrix. Jobs: typecheck, lint, test, build.
- `README.md` with project goals, a "status: pre-alpha" banner, and a
  quickstart that tells contributors to install `asdf` and run
  `asdf install` before `npm install`.
- `LICENSE` (BSD-3-Clause) and `CONTRIBUTING.md`. `CONTRIBUTING.md`
  documents the `asdf` prerequisite explicitly. Add a top-level
  `NOTICES.md` reserved for third-party attributions (initially empty;
  populated by M8 when MPL-2.0 fixtures are vendored).

**Done when.** After a fresh clone, `asdf install && npm install && npm run
build && npm test` succeeds; GitHub Actions CI is green using the same
`.tool-versions`-driven Node.js 24.x version.

---

### M1 — Core types and utilities  *(S)*

**Goal.** Define the foundational types used by every later milestone so
subsequent work never has to rework them.

**Deliverables.**

- `src/source.ts`: `SourceFile`, `Position`, `Range` types with line/column
  math. A single pass computes a line-offset index for O(1) offset→line
  conversion.
- `src/errors.ts`: `HCLParseError` class with `filename`, `line`, `column`,
  `offset`, `snippet`, and `errors[]`. `formatSnippet(source, range)` helper
  that produces a caret-marked snippet.
- `src/unicode.ts`: precomputed UAX #31 `ID_Start` and `ID_Continue` range
  tables plus `isIdStart(cp)` and `isIdContinue(cp)` predicates. Generate
  tables from the official Unicode data as part of a build step and commit
  the generated file.
- Unit tests for each helper, including boundary code points for the
  Unicode tables.

**Done when.** `errors.ts` can render a snippet for a synthetic error and
`unicode.ts` correctly classifies ≥1000 sampled code points.

---

### M2 — Lexer  *(L)*

**Goal.** A complete HCL2 lexer producing a stream of trivia-attached
tokens.

**Depends on.** M1.

**Deliverables.**

- `src/lexer/token.ts`: `Token` type, `TokenKind` enum (per design doc §5.1).
- `src/lexer/lexer.ts`: mode-tracking lexer supporting NORMAL, TEMPLATE,
  TEMPLATE_INTERP, TEMPLATE_CONTROL, and heredoc scanning.
- Trivia attachment: leading trivia on the *next* token, trailing same-line
  trivia on the *previous* token.
- Newline suppression inside balanced `()`/`[]`/`{}` that belong to
  expressions (bracket stack tracked by the lexer; blocks are disambiguated
  later by the parser).
- Error tokens with recovery (`INVALID` kind carrying an error message).

**Tests.**

- Per-token-kind unit tests.
- Round-trip: concatenating `leadingTrivia + lexeme + trailingTrivia` for
  all tokens reproduces the input source exactly.
- Fixture set: 20+ hand-written HCL snippets covering every token kind,
  including edge cases (nested `${}` templates, heredocs with `<<-`,
  identifiers with dashes, Unicode identifiers, CRLF endings).

**Done when.** 100% line coverage on the lexer and the "lex + rejoin"
property holds on the full corpus (see M8).

---

### M3 — Structural parser (bodies, blocks, attributes)  *(M)*

**Goal.** Parse the top-level grammar (ConfigFile, Body, Block,
Attribute), treating expression values as opaque spans for now.

**Depends on.** M2.

**Deliverables.**

- `src/parser/nodes.ts`: CST node types (`BodyNode`, `BlockNode`,
  `AttributeNode`, `BlockLabelsNode`, `ExpressionNode`).
- `src/parser/parser.ts`: recursive-descent parser that consumes the token
  stream and produces a `BodyNode`. Expression values are captured as a
  raw token span (to be replaced by real expression parsing in M4).
- Error recovery: on parse error, skip to the next `NEWLINE` or closing
  brace at the current depth and emit a synthetic error node.
- Distinguish one-line blocks (`block "l" { attr = 1 }`) from full blocks
  per spec.

**Tests.**

- Unit tests per production, including mis-placed newlines, missing `=`,
  unclosed blocks, and blocks with 0/1/2/3 labels.
- Round-trip test: parse a body, walk it printing tokens in order, assert
  equality with input.

**Done when.** Every Terraform fixture in the corpus (M8) parses to a
complete CST without errors.

---

### M4 — Expression parser (structural only)  *(L)*

**Goal.** Replace the opaque expression spans from M3 with a full AST
covering every expression form in the HCL2 spec, *without* evaluation.

**Depends on.** M3.

**Deliverables.**

- `src/parser/expr.ts`: Pratt parser covering literals, templates (quoted
  and heredoc), tuples, objects, variables, traversals
  (`GetAttr`/`Index`/`Splat`), function calls, for-expressions (tuple and
  object form, with optional `if` and `...` grouping), conditionals, unary
  and binary operators with correct precedence and associativity, and
  parenthesized expressions.
- `ExprNode` types per design doc §6.3, each carrying `range` and first/
  last token references.
- Template parts for quoted strings and heredocs, including strip-marker
  handling (`~`) and `$${`/`%%{` escapes.

**Tests.**

- Unit tests for every expression form, including precedence edge cases
  (`a || b && c`, `-x ** 2` where `**` is not an HCL operator, etc.).
- Heredoc strip-marker tests producing the expected min-indent.
- Property test: `lex(text) == lex(print(parseExpr(text)))` — every
  expression re-prints its original tokens.

**Done when.** All corpus files still parse *and* every expression node is
a concrete AST node (no more opaque span fallbacks).

---

### M5 — Value projection (`HCL.parse`)  *(M)*

**Goal.** Expose the `HCL.parse(source) => Value` API as a projection over
the CST.

**Depends on.** M4.

**Deliverables.**

- `src/value.ts`: `Value` union, `Expression` wrapper, and `toValue(node)`
  that walks a CST and produces a `Value`.
- Literal-collapsing rules: literal strings/numbers/bools/null collapse to
  plain JS; collections of pure literals collapse; any expression with
  operators/variables/calls/templates-with-interpolations becomes an
  `Expression`.
- Block grouping per design doc §3.1 (`resource "type" "name" {}` →
  `{ resource: { type: { name: {...} } } }`, with duplicate names collected
  into arrays). Includes an explicit test matrix for 0, 1, 2, 3 labels and
  mixed unique/duplicate names.
- Public `HCL.parse(source, options?)` wired up in `src/index.ts`,
  including `filename` and `bail` options.

**Tests.**

- Unit tests for each Value shape.
- Cross-check against `hcl2-json-parser`: run both over 30 fixture files,
  diff the resulting JSON, investigate any differences, document or fix.

**Done when.** The table of "HCL input → expected Value" in the design doc
is green end-to-end.

---

### M6 — Canonical printer (`HCL.stringify`)  *(M)*

**Goal.** Emit canonical HCL from a plain `Value`.

**Depends on.** M5.

**Deliverables.**

- `src/printer/canonical.ts`: printer implementing all rules in design
  doc §8 (indentation, blocks, attributes, strings, numbers, tuples,
  objects, block grouping, heredoc promotion, expression verbatim).
- Support for `StringifyOptions`: `indent`, `trailingNewline`, `sortKeys`,
  `replacer`.
- Public `HCL.stringify(value, options?)` wired up.

**Tests.**

- Unit tests for each rule.
- Round-trip property: for every corpus file `f`,
  `parse(stringify(parse(f)))` is structurally equal to `parse(f)`.
- Property tests (`fast-check`): generate random JS `Value`s, assert
  `parse(stringify(v))` ≈ `v`.
- Golden-file tests: a curated set of `(input, expected-canonical-output)`
  pairs to lock down formatting decisions.

**Done when.** All round-trip and golden tests pass.

---

### M7 — Document model & lossless round-trip  *(L)*

**Goal.** Ship the `parseDocument` API and editing operations with
byte-identical round-trip on unmodified input.

**Depends on.** M4 (CST) and M6 (printer, reused for new-node formatting).

**Deliverables.**

- `src/document/document.ts`: `Document` class wrapping the root
  `BodyNode`, with `toString()`, `toValue()`, `get(path)`, `set(path, v)`,
  `delete(path)`.
- Path resolution: string paths ("foo.bar.baz") and arrays (`["foo",
  "bar"]`); numeric segments index into arrays/block-groups.
- Trivia-aware edits per design doc §7.2:
  - Replacement preserves leading/trailing trivia of the replaced node.
  - Insertion uses canonical printer for the new subtree, chooses
    indentation from surrounding attributes, inserts a preceding newline.
  - Deletion removes leading trivia up to (but not including) the previous
    newline so no blank hole is left behind.
- `HCL.parseDocument(source, options?)` wired up.

**Tests.**

- Round-trip: for every corpus file `f`,
  `parseDocument(f).toString() === f` (byte equality).
- Edit tests: load a fixture, mutate it (add attribute, change value,
  delete block), assert the resulting output matches a golden file that
  preserves unrelated comments and whitespace.

**Done when.** Byte-equality holds across the full corpus and 10+ edit
golden tests pass.

---

### M8 — Test corpus and fuzzing  *(M)*

**Goal.** Stand up the shared test corpus used by M3–M7 and add property/
fuzz testing.

**Depends on.** Can start in parallel with M3; must complete before v1.0
release.

**Deliverables.**

- `test/corpus/`: vendored fixtures organized by source —
  `hashicorp-hcl/`, `terraform-fixtures/`, `handwritten/`, `malformed/`.
  Include a `MANIFEST.md` documenting provenance and license for each.
- License hygiene for vendored MPL-2.0 fixtures:
  `test/corpus/hashicorp-hcl/LICENSE` retains the upstream MPL-2.0 notice,
  `NOTICES.md` at the repo root is updated with the attribution, and the
  `files` field in `package.json` (and `.npmignore`) explicitly excludes
  `test/` from the published tarball so the shipped artifact contains only
  BSD-3-Clause code.
- `test/corpus.test.ts`: a single test runner that enumerates every
  fixture and asserts the parse/stringify/round-trip properties.
- `test/fuzz.test.ts`: `fast-check` property tests for the Value ⇄ HCL
  round-trip.
- Optional: a `jazzer.js` fuzzer harness for CI nightly runs.

**Done when.** The corpus covers ≥50 real-world Terraform files and every
property test passes on 1000+ generated inputs.

---

### M9 — Browser + Deno + Bun compatibility pass  *(S)*

**Goal.** Confirm the library works in every advertised runtime and keep
it working.

**Depends on.** M6 (things must actually work end-to-end first).

**Deliverables.**

- Playwright test that imports the ESM build in a headless Chromium page,
  parses a fixture, and asserts the result.
- Bun-specific CI job running the existing test suite under `bun test`.
- Deno-specific CI job loading the ESM build with Deno's `npm:` specifier.
- `package.json` `exports` map audited: no conditional exports pointing at
  Node-only code paths.

**Done when.** All four runtime jobs (Node, Bun, Deno, browser) are green.

---

### M10 — Documentation and v1.0 release  *(M)*

**Goal.** Ship a polished 1.0.0 with usable docs.

**Depends on.** Everything above.

**Deliverables.**

- `README.md` with install, quickstart, API reference, and a
  compatibility-matrix table (what parses, what doesn't).
- Typedoc-generated API reference published to GitHub Pages.
- `docs/migrating-from-hcl2-parser.md`: short guide for users coming from
  existing JS parsers.
- `CHANGELOG.md` following Keep a Changelog.
- Publish `0.1.0` → `0.9.x` pre-release tags during M2–M9; cut `1.0.0`
  only after M7 corpus is byte-stable.

**Done when.** `npm publish --dry-run` produces a clean tarball, docs site
builds, and an npm consumer test project installs and uses the published
tarball.

---

## v1.x — Post-1.0 milestones

Each of these is self-contained and can be prioritized based on user
demand.

### M11 — JSON-syntax HCL support *(M)*

Add `syntax: "json" | "native" | "auto"` to `parse` / `parseDocument` /
`stringify`, with `"auto"` selecting based on file extension or first
non-whitespace character. Reuses the existing Value and Document layers;
only the front-end parser and back-end printer change.

### M12 — Expression evaluator *(L)*

Implement `HCL.evaluate(expr, ctx)` and the `evaluate` option on `parse`.
Covers arithmetic, comparison, logical, conditional, unary, indexing,
attribute access, splats, and both `for` forms. Evaluation is type-aware
(HCL cty-style types) with clear error messages for type mismatches.

### M13 — Standard function library *(M)*

Port the subset of `hashicorp/hcl/ext/funcs` that is commonly used:
`length`, `lookup`, `coalesce`, `concat`, `merge`, `jsonencode`,
`jsondecode`, string functions (`upper`, `lower`, `replace`, `format`),
collection functions (`keys`, `values`, `contains`), and numeric
(`abs`, `ceil`, `floor`, `max`, `min`). `HCL.evaluate(expr, { functions:
stdlib })` opts in.

### M14 — Schema-directed decoding *(L)*

`HCL.decode(source, schema)` where `schema` is a Zod or Valibot-style
type description. Emits typed TS objects; errors point at ranges in the
source. Consider publishing the schema helpers as a separate sub-package
(`@cruglobal/js-hcl2-decode`) to keep the core dependency-free.

### M15 — Incremental re-parse + source maps *(L)*

Add an `update(edit: TextEdit)` method to `Document` that re-parses only
affected subtrees, suitable for LSP integrations. Generate source maps
from `stringify` output back to `Value` paths for tooling that transforms
HCL in-place.

### M16 — Full HCL2 spec parity audit *(M)*

Stand up a conformance harness that runs our parser against the
`hashicorp/hcl` test suite via a Go-side bridge (a small Go CLI that
prints the canonical AST for each fixture as JSON; we parse and diff).
Close any gaps found. Publish the compatibility report.

### M17 — Exploratory: WASM "strict" parser *(L)*

Only pursued if M16 reveals real-world divergences that are hard to fix
in the hand-written parser. Package the Go parser as WASM behind the
same public API via an opt-in entry point: `import { parse } from
"@cruglobal/js-hcl2/strict"`. Keep the default export pure-TS to avoid forcing the
WASM bundle on all users.
