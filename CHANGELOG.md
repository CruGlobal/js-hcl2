# Changelog

All notable changes to `@cruglobal/js-hcl2` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5](https://github.com/CruGlobal/js-hcl2/compare/v0.1.4...v0.1.5) (2026-10-09)


### Fixed

* match Terraform on statement endings, lone CR, splats and template directives ([#73](https://github.com/CruGlobal/js-hcl2/issues/73)) ([6a55ec5](https://github.com/CruGlobal/js-hcl2/commit/6a55ec55d9d36fdc9b6462d05a0469b5404056b3))

## [0.1.4](https://github.com/CruGlobal/js-hcl2/compare/v0.1.3...v0.1.4) (2026-10-09)


### Added

* parse provider functions, decode block labels, reject multi-line strings, fix bail: false loop ([#71](https://github.com/CruGlobal/js-hcl2/issues/71)) ([7e367f3](https://github.com/CruGlobal/js-hcl2/commit/7e367f3b368a93c981e583394d1f34a156f44f70))


### Changed

* **deps-dev:** Bump source-map-js from 1.2.1 to 1.2.2 ([#70](https://github.com/CruGlobal/js-hcl2/issues/70)) ([2bf9c80](https://github.com/CruGlobal/js-hcl2/commit/2bf9c802976477e05c1f82920bdf3c4bc0d0cf00))

## [0.1.3](https://github.com/CruGlobal/js-hcl2/compare/v0.1.2...v0.1.3) (2026-10-08)


### Fixed

* reject invalid escapes and allow identifiers to start with "_" ([#69](https://github.com/CruGlobal/js-hcl2/issues/69)) ([efab3e4](https://github.com/CruGlobal/js-hcl2/commit/efab3e405b1685aeca08d35266b4df45692a84a0))
* round-trip a template marker doubled before its brace ([#30](https://github.com/CruGlobal/js-hcl2/issues/30)) ([13921d8](https://github.com/CruGlobal/js-hcl2/commit/13921d843f14896355ccf0c0ddf34183cbb34052))


### Changed

* **deps-dev:** align @types/node with the pinned Node 24 runtime ([#53](https://github.com/CruGlobal/js-hcl2/issues/53)) ([43186d2](https://github.com/CruGlobal/js-hcl2/commit/43186d2ef39e94faaa9b11b503a91ef2909a7f93))
* **deps-dev:** Bump happy-dom from 20.12.0 to 20.13.2 in the npm-dev-dependencies group ([#55](https://github.com/CruGlobal/js-hcl2/issues/55)) ([6ca70e6](https://github.com/CruGlobal/js-hcl2/commit/6ca70e6570f601bf3f4f20f1639ad4896f061760))
* **deps-dev:** Bump js-yaml from 4.2.0 to 4.3.1 ([#45](https://github.com/CruGlobal/js-hcl2/issues/45)) ([d8d93ec](https://github.com/CruGlobal/js-hcl2/commit/d8d93ec137655e285ed0e9f884df25ccf976300d))
* **deps-dev:** Bump js-yaml from 4.3.1 to 4.3.2 ([#59](https://github.com/CruGlobal/js-hcl2/issues/59)) ([97f7232](https://github.com/CruGlobal/js-hcl2/commit/97f72322c65091a6cdf78ac3b45dcb9d3e53345b))
* **deps-dev:** Bump markdown-it from 14.3.0 to 14.3.2 ([#64](https://github.com/CruGlobal/js-hcl2/issues/64)) ([e910bc0](https://github.com/CruGlobal/js-hcl2/commit/e910bc0e5d59a545bdba7b71987d3b26cffcab49))
* **deps-dev:** Bump postcss from 8.5.17 to 8.5.23 ([#42](https://github.com/CruGlobal/js-hcl2/issues/42)) ([4d794a7](https://github.com/CruGlobal/js-hcl2/commit/4d794a759372c5adf950bf07d0871fa2c39f7549))
* **deps-dev:** Bump the npm-dev-dependencies group with 2 updates ([#40](https://github.com/CruGlobal/js-hcl2/issues/40)) ([2947bb3](https://github.com/CruGlobal/js-hcl2/commit/2947bb3e98a3bd94ef6da22278decd78d2ba1d3e))
* **deps-dev:** Bump the npm-dev-dependencies group with 2 updates ([#54](https://github.com/CruGlobal/js-hcl2/issues/54)) ([8168ba6](https://github.com/CruGlobal/js-hcl2/commit/8168ba60f0c99a73d02ddce6642a225bab8f8d0d))
* **deps-dev:** Bump the npm-dev-dependencies group with 2 updates ([#66](https://github.com/CruGlobal/js-hcl2/issues/66)) ([1c0c9ee](https://github.com/CruGlobal/js-hcl2/commit/1c0c9eed00bd4ff312c08677ea3327a2af541218))
* **deps-dev:** Bump the npm-dev-dependencies group with 3 updates ([#34](https://github.com/CruGlobal/js-hcl2/issues/34)) ([7b37adf](https://github.com/CruGlobal/js-hcl2/commit/7b37adf981985337431a31182b7bb41c8d66a511))
* **deps-dev:** Bump the npm-dev-dependencies group with 3 updates ([#46](https://github.com/CruGlobal/js-hcl2/issues/46)) ([618a694](https://github.com/CruGlobal/js-hcl2/commit/618a694c929df1a20fc4404d789ac137f8ef3025))
* **deps-dev:** Bump the npm-dev-dependencies group with 3 updates ([#48](https://github.com/CruGlobal/js-hcl2/issues/48)) ([6ec87f7](https://github.com/CruGlobal/js-hcl2/commit/6ec87f790e42c2705af39a93afe702e0751e662a))
* **deps-dev:** Bump the npm-dev-dependencies group with 3 updates ([#50](https://github.com/CruGlobal/js-hcl2/issues/50)) ([532c2d3](https://github.com/CruGlobal/js-hcl2/commit/532c2d33c992d1235eb5ff040e0abf1dc7401a81))
* **deps-dev:** Bump the npm-dev-dependencies group with 4 updates ([#32](https://github.com/CruGlobal/js-hcl2/issues/32)) ([7005833](https://github.com/CruGlobal/js-hcl2/commit/70058333b7f1455f14992fbe34c3c31b1f8cb0c4))
* **deps-dev:** Bump the npm-dev-dependencies group with 4 updates ([#41](https://github.com/CruGlobal/js-hcl2/issues/41)) ([77905a7](https://github.com/CruGlobal/js-hcl2/commit/77905a7267a3666ecd9b4e34f3c8e763f739725b))
* **deps-dev:** Bump the npm-dev-dependencies group with 4 updates ([#56](https://github.com/CruGlobal/js-hcl2/issues/56)) ([c8ec897](https://github.com/CruGlobal/js-hcl2/commit/c8ec897706bcc003fd57ec3d62ce09b37daac444))
* **deps-dev:** Bump the npm-dev-dependencies group with 7 updates ([#36](https://github.com/CruGlobal/js-hcl2/issues/36)) ([a46a75d](https://github.com/CruGlobal/js-hcl2/commit/a46a75dfee97a9439a7189e9db43c0d69b37d37e))
* **deps-dev:** Bump typescript-eslint from 8.65.0 to 8.66.0 in the npm-dev-dependencies group ([#44](https://github.com/CruGlobal/js-hcl2/issues/44)) ([e87c371](https://github.com/CruGlobal/js-hcl2/commit/e87c3710c5ee0a417e32a675e6bbfb14570d3763))
* **deps:** Bump brace-expansion ([#49](https://github.com/CruGlobal/js-hcl2/issues/49)) ([202a6cb](https://github.com/CruGlobal/js-hcl2/commit/202a6cbde58d3821f85d742ff41ceb06e84cf4e6))
* **deps:** Bump brace-expansion ([#65](https://github.com/CruGlobal/js-hcl2/issues/65)) ([51895a7](https://github.com/CruGlobal/js-hcl2/commit/51895a7aa2511a172a41d2086863e54b4ce3e4e2))

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
