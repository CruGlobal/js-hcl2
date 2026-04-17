# Test corpus manifest

Organized by provenance. Every entry below contributes to the corpus
runner in `test/corpus.test.ts`. None of this directory is published to
npm (`package.json#files` and `.npmignore` exclude `test/`).

## `hashicorp-hcl/` — MPL-2.0

- **Source:** <https://github.com/hashicorp/hcl> (main branch at vendor time).
- **License:** Mozilla Public License v2.0. Full notice at
  `hashicorp-hcl/LICENSE`.
- **Contents:**
  - `specsuite_tests_*.hcl` — canonical HCL specification fixtures from
    `specsuite/tests/`. Cover empty files, the three comment styles,
    attribute structure, block structure (including empty / one-line /
    multi-line forms), primitive literals, expression operators, and
    heredocs (all opening forms and the strip variant).
  - `hclwrite_fuzz_*.hcl` — inputs from the hclwrite Go fuzzer's seed
    corpus (`hclwrite/fuzz/testdata/fuzz/FuzzParseConfig/`). Each is a
    small, targeted fragment exercising a specific construct
    (splats, traversals, interpolations, escapes, comments, etc.).

## `opentofu/` — MPL-2.0

- **Source:** <https://github.com/opentofu/opentofu> (main branch at
  vendor time). OpenTofu is a fork of Terraform from just before the
  2023 license change; everything vendored here predates the BUSL
  switch and remains MPL-2.0.
- **License:** Mozilla Public License v2.0. Full notice at
  `opentofu/LICENSE`.
- **Contents:** 16 representative `main.tf` files from
  `internal/backend/local/testdata`, `internal/backend/remote/testdata`,
  and `internal/checks/testdata`. Each is a real-world Terraform
  configuration covering provider blocks, variable declarations,
  resource definitions, modules, outputs, policy checks, and interpolation
  patterns. File names are the upstream path with `/` transliterated to
  `_` so provenance is trivially visible.

## `handwritten/` — BSD-3-Clause

- **Author:** this repository. No external license obligations.
- **Contents:** seven hand-crafted fixtures that exercise patterns
  underrepresented in the vendored sets — complex comment trivia,
  unicode identifiers and string content, every heredoc variant,
  nested interpolation + template directives, every expression form
  (operators / collections / traversals / splats / for-expressions /
  splats), a realistic Terraform-shaped module, and assorted edge
  cases (empty blocks, trailing commas, dashed identifiers, deeply
  nested structures).

## `malformed/` — mixed

- **Contents:** intentionally-broken inputs used to exercise the parser's
  error-recovery paths:
  - `specsuite_tests_*` from hashicorp/hcl (MPL-2.0), for spec-defined
    "must be an error" cases.
  - `missing_equals.hcl`, `stray_symbol.hcl`, `unterminated_string.hcl`
    hand-written by this repository (BSD-3-Clause), for targeted error
    shapes.
- The corpus runner expects these to produce at least one parse error
  when parsed with `bail: false`.

## Opportunistic local corpus (not vendored)

The runner additionally walks `/Users/brian/src/other/cru-terraform`
and `/Users/brian/src/other/cru-terraform-modules` when they exist on
disk (they are not part of this repository). That's a large private
real-world test set for the author; CI and third-party contributors
skip those directories transparently.
