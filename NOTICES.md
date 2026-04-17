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

## hashicorp/hcl test fixtures (planned)

Vendored test fixtures from [`hashicorp/hcl`](https://github.com/hashicorp/hcl)
will be added under `test/corpus/hashicorp-hcl/` during milestone M8. At
that time, this file will be updated with the attribution and a pointer
to the upstream MPL-2.0 license notice retained with the fixtures.
