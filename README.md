# @cruglobal/js-hcl2

> **Status: pre-alpha.** The public API is being actively designed; nothing
> on npm is production-ready yet. See [`docs/design.md`](docs/design.md) and
> [`docs/milestones.md`](docs/milestones.md) for the roadmap.

A TypeScript library that **parses and encodes** HashiCorp Configuration
Language v2 (HCL2). Unlike the other npm packages in this space,
`@cruglobal/js-hcl2` supports both directions — reading HCL into JS values
*and* emitting HCL from JS values — plus an optional lossless round-trip
mode that preserves comments and formatting.

```ts
import * as HCL from "@cruglobal/js-hcl2";

const value = HCL.parse(source);            // HCL text -> JS value
const text  = HCL.stringify(value);         // JS value -> HCL text

const doc  = HCL.parseDocument(source);     // HCL text -> Document (CST)
doc.set("region", "us-west-2");
const edited = doc.toString();              // byte-identical re-print, with edits
```

## Requirements

- Runtime: Node.js 18+, Bun, Deno, or a modern browser (ESM + CJS bundles
  ship in the published package).
- Development: [`asdf`](https://asdf-vm.com/) + Node.js 24.x. The repo
  commits a `.tool-versions` file pinning the exact Node.js version used
  for development and CI.

## Quickstart (contributors)

```sh
# 1. Install asdf (https://asdf-vm.com/guide/getting-started.html)
# 2. Ensure the Node.js plugin is available
asdf plugin add nodejs

# 3. From the repo root, install the pinned Node.js version
asdf install

# 4. Install dependencies and run the full check
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

## Design

See [`docs/design.md`](docs/design.md) for the complete design document,
including the public API, pipeline architecture, lexer/parser design, CST
model, printer rules, and future roadmap.

[`docs/milestones.md`](docs/milestones.md) breaks the design down into
self-contained milestones (M0–M17) sized for a single implementation
session.

## License

[BSD-3-Clause](LICENSE). Test fixtures vendored from external projects
retain their original licenses; see [`NOTICES.md`](NOTICES.md) for
attributions. Vendored fixtures are excluded from the published npm
tarball.
