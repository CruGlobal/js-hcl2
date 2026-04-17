# Changelog

All notable changes to `@cruglobal/js-hcl2` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.0] — 2026-04-17

Initial public release. Covers the full HCL2 native-syntax surface at
the parsing level, with synchronous plain-JS projection, canonical
emission, and a trivia-preserving `Document` API for in-place edits.

### Added

- `parse(source, options?): Value` — HCL text → plain JS value. Numbers,
  booleans, `null`, string templates without interpolation, and
  collections of pure literals collapse to JS primitives / arrays /
  objects; every other expression becomes an opaque `Expression`
  wrapper.
- `stringify(value, options?): string` — canonical HCL emission with
  configurable `indent`, `trailingNewline`, `sortKeys`, and a JSON-style
  `replacer`. Block vs. attribute policy and label peeling reproduce
  Terraform-style nesting.
- `parseDocument(source, options?): Document` — lossless round-trip
  (`toString()` is byte-identical on unedited input) plus
  trivia-preserving `set` / `delete` / `get` operations.
- Expression AST covering literals, templates (quoted + heredoc,
  including `%{if}` / `%{for}` directives and strip markers),
  collections, for-expressions, traversals, splats (attr and full),
  function calls (including `...` expansion), conditionals, and the
  full binary / unary / parens set.
- `HCLParseError` with `filename`, `line`, `column`, `offset`,
  `range`, `errors[]`, and a caret-marked `snippet`.
- Lower-level API surface: `SourceFile`, `lex` / `Lexer` / `Token` /
  `TokenKind`, `parseBody` / `parseExpr` / `Parser`, `print`,
  `toValue` / `exprToValue` / `isExpression` /
  `unescapeTemplateLiteral`, `isValidIdentifier`, and the full CST
  node type union.
- Unicode identifier support at UAX #31 level (derived from Unicode
  16.0.0), plus the HCL-specific `-` extension in `ID_Continue`.
- Browser / Bun / Deno support: dual ESM + CJS build, zero runtime
  dependencies, no Node-only APIs in `src/`.

### Tested

- 754 unit + integration tests across the lexer, parser, printer,
  Document, Value projection, browser environment (happy-dom), fuzz
  (fast-check, 1300+ generated inputs), and a cross-parser agreement
  check against `hcl2-json-parser`.
- Corpus of 62 real-world fixtures vendored from hashicorp/hcl's
  specsuite + hclwrite fuzz seed corpus + OpenTofu's testdata +
  handwritten edge cases. Corpus fixtures all satisfy: parse ⇒ no
  errors, byte-identical Document round-trip, structural equality of
  parse ∘ stringify ∘ parse, and `stringify` idempotence.

[Unreleased]: https://github.com/CruGlobal/js-hcl2/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CruGlobal/js-hcl2/releases/tag/v0.1.0
