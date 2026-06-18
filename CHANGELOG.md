# Changelog

All notable changes to `@cruglobal/js-hcl2` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2](https://github.com/CruGlobal/js-hcl2/compare/v0.1.1...v0.1.2) (2026-06-18)


### Fixed

* parse multi-line object for-expressions ([#29](https://github.com/CruGlobal/js-hcl2/issues/29)) ([7c28fe5](https://github.com/CruGlobal/js-hcl2/commit/7c28fe5bd68db760f9a18d37814c39ff77c12f82))


### Changed

* **deps-dev:** Bump js-yaml from 4.1.1 to 4.2.0 ([#28](https://github.com/CruGlobal/js-hcl2/issues/28)) ([66d1337](https://github.com/CruGlobal/js-hcl2/commit/66d1337e4a305e0890348739b1cd5e53936fb9c7))
* **deps-dev:** Bump markdown-it from 14.1.1 to 14.2.0 ([#27](https://github.com/CruGlobal/js-hcl2/issues/27)) ([2f9e88c](https://github.com/CruGlobal/js-hcl2/commit/2f9e88c44c675535966e34a84a1afff684c94280))
* **deps-dev:** Bump the npm-dev-dependencies group with 2 updates ([#20](https://github.com/CruGlobal/js-hcl2/issues/20)) ([ab5d0a7](https://github.com/CruGlobal/js-hcl2/commit/ab5d0a7d4068397d1ab55b108bdd50a34e8ecd6b))
* **deps-dev:** Bump the npm-dev-dependencies group with 2 updates ([#21](https://github.com/CruGlobal/js-hcl2/issues/21)) ([040ab6b](https://github.com/CruGlobal/js-hcl2/commit/040ab6b24220af7db71afe5343b1fe3bb752c38b))
* **deps-dev:** Bump the npm-dev-dependencies group with 2 updates ([#24](https://github.com/CruGlobal/js-hcl2/issues/24)) ([cd68566](https://github.com/CruGlobal/js-hcl2/commit/cd6856677a043410a06810a5822730c6f0fb76aa))
* **deps-dev:** Bump the npm-dev-dependencies group with 3 updates ([#18](https://github.com/CruGlobal/js-hcl2/issues/18)) ([1042e11](https://github.com/CruGlobal/js-hcl2/commit/1042e11bf96f09ea01f0b94bc148ac9b8994378a))
* **deps-dev:** Bump the npm-dev-dependencies group with 4 updates ([#23](https://github.com/CruGlobal/js-hcl2/issues/23)) ([c499a30](https://github.com/CruGlobal/js-hcl2/commit/c499a30e163d27150f7c2bcaca84b58972dbb498))
* **deps-dev:** Bump the npm-dev-dependencies group with 5 updates ([#25](https://github.com/CruGlobal/js-hcl2/issues/25)) ([874629a](https://github.com/CruGlobal/js-hcl2/commit/874629ad4c80c136db7104125d6d347c8bff896e))
* **deps-dev:** Bump the npm-dev-dependencies group with 5 updates ([#26](https://github.com/CruGlobal/js-hcl2/issues/26)) ([b503128](https://github.com/CruGlobal/js-hcl2/commit/b503128541ca9de295fb97045fd1f534db637817))

## [0.1.1](https://github.com/CruGlobal/js-hcl2/compare/v0.1.0...v0.1.1) (2026-04-20)


### Fixed

* patch serialize-javascript RCE + DoS via npm override ([1b44a05](https://github.com/CruGlobal/js-hcl2/commit/1b44a05159f05155e8587b9e1f574936ac9d412f))


### Changed

* bump typescript 5→6, vitest 3→4, eslint 9→10 ([#11](https://github.com/CruGlobal/js-hcl2/issues/11)) ([15a2380](https://github.com/CruGlobal/js-hcl2/commit/15a2380b25efc8adb7567ee98ca1e90fe07b0c05))
* **deps-dev:** Bump @eslint/js from 9.39.4 to 10.0.1 ([#4](https://github.com/CruGlobal/js-hcl2/issues/4)) ([6a1ea43](https://github.com/CruGlobal/js-hcl2/commit/6a1ea43d07cb71e39e850615c199b723175004c3))

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
