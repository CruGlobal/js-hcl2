# Third-party notices

This file lists the licenses of third-party material included in this
repository. The shipped npm package (`@cruglobal/js-hcl2`) is licensed
under [BSD-3-Clause](LICENSE); the material listed here appears in the
source repository for testing and documentation purposes but is excluded
from the published tarball via `package.json`'s `files` field.

## Unicode Character Database (UCD)

Path: `scripts/unicode/DerivedCoreProperties.txt`

Vendored at Unicode 16.0.0 for use as input to the identifier-character
table generator (`scripts/generate-unicode.ts`). The generated output
(`src/unicode.ts`) contains derived data only — no UCD source text is
shipped in the npm tarball.

- Source: <https://www.unicode.org/Public/16.0.0/ucd/DerivedCoreProperties.txt>
- Copyright © 2024 Unicode®, Inc.
- License: <https://www.unicode.org/license.txt> (Unicode Data Files
  License — permissive, BSD-compatible).
- "Unicode" is a registered trademark of Unicode, Inc.

## hashicorp/hcl corpus fixtures

Path: `test/corpus/hashicorp-hcl/*.hcl`

Fixtures from the `specsuite/tests/` tree and the `hclwrite` fuzzer seed
corpus of [`hashicorp/hcl`](https://github.com/hashicorp/hcl). Used by
the parser / printer / document round-trip tests in
`test/corpus.test.ts`. The upstream MPL-2.0 license is retained at
`test/corpus/hashicorp-hcl/LICENSE` alongside the fixtures, and see
`test/corpus/MANIFEST.md` for the per-file manifest.

- Source: <https://github.com/hashicorp/hcl> (main branch at vendor time)
- Copyright IBM Corp. 2014, 2025 (per the upstream LICENSE file).
- License: Mozilla Public License v2.0 (MPL-2.0).

## opentofu/opentofu testdata fixtures

Path: `test/corpus/opentofu/*.tf`

Representative `main.tf` files from OpenTofu's testdata directories
covering real-world Terraform configurations (resources, modules,
variables, outputs, providers). License retained at
`test/corpus/opentofu/LICENSE`; see `test/corpus/MANIFEST.md` for the
per-file provenance.

- Source: <https://github.com/opentofu/opentofu> (main branch at vendor
  time). OpenTofu is the pre-BUSL Terraform fork; these files predate
  the 2023 license change and are MPL-2.0.
- Copyright © The OpenTofu Authors; Copyright © 2014 HashiCorp, Inc.
- License: Mozilla Public License v2.0 (MPL-2.0).

## Vendored malformed-input fixtures (mixed)

Path: `test/corpus/malformed/`

Subset originated from `hashicorp/hcl`'s `specsuite/tests/` (MPL-2.0,
attributed above). Three additional files (`missing_equals.hcl`,
`stray_symbol.hcl`, `unterminated_string.hcl`) are authored by this
repository under BSD-3-Clause.

---

All vendored corpus material lives under `test/` and is excluded from
the published npm tarball (via `package.json#files` and `.npmignore`).
The shipped artifact contains only BSD-3-Clause code.
