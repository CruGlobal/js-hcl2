# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

**Pre-implementation.** The repo currently contains only design documents
under `docs/`. There is no `package.json`, no source, no tests, and no
build system yet. The first coding milestone (M0) stands up the
TypeScript/tsup/vitest scaffolding.

Before writing any code, read `docs/design.md` and `docs/milestones.md` —
they are the authoritative specification. All implementation work should
map to a numbered milestone (M0–M17) from `milestones.md` and respect the
architectural decisions in `design.md`.

## What this project is

`@cruglobal/js-hcl2` — a TypeScript library that both **parses and
encodes** HashiCorp Configuration Language v2 (HCL2). The novel
contribution vs. existing npm packages is bidirectionality plus a
lossless round-trip Document API.

## Load-bearing design decisions

These decisions are already settled and should not be revisited without
updating the design doc first:

- **Pure TypeScript, hand-written lexer + parser.** No WASM port, no
  native bindings, no fork of existing JS parsers. The rationale is in
  `design.md` §2 — primarily that lossless round-trip requires a
  trivia-aware CST that no existing parser provides.
- **Zero runtime dependencies.** Dev deps only (TypeScript, tsup, vitest,
  eslint, prettier, fast-check).
- **Dual runtime support**: Node.js + Bun + Deno + modern browsers. No
  Node-specific APIs in the library itself. ESM + CJS dual build.
- **Two public APIs over one parser:**
  - `HCL.parse` / `HCL.stringify` — plain JS `Value` projection,
    JSON-style ergonomics.
  - `HCL.parseDocument` / `Document.toString` — trivia-aware CST,
    byte-identical round-trip, trivia-preserving edits.
- **v1.0 scope is *syntax only, expressions unevaluated*.** Every
  non-literal expression becomes an opaque `Expression { source, kind,
  ast }` wrapper. Evaluator + function stdlib are deferred to M12/M13.
- **Trivia model**: leading trivia attaches to the *next* token, trailing
  same-line trivia attaches to the *previous* token. This asymmetric rule
  is what makes edits preserve same-line comments correctly — don't
  "simplify" it to one-sided attachment.
- **License**: BSD-3-Clause for the library. Vendored `hashicorp/hcl`
  test fixtures stay under MPL-2.0 in `test/corpus/hashicorp-hcl/` with
  original notices intact, and `test/` is excluded from the published
  npm tarball. Do not copy Go source into `src/`; implementing from the
  spec is fine, porting MPL-2.0 code is not.

## Working on milestones

Each milestone in `docs/milestones.md` has a "Done when" bar. When
implementing:

1. Pick exactly one milestone and work through its deliverables in order.
2. Respect stated dependencies — e.g. M4 (expression parser) requires
   M3's CST node types to exist.
3. A milestone is not complete until its test bar is green. The corpus
   round-trip and property tests in M8 are the load-bearing correctness
   checks; most milestones from M3 onward feed into those.

## Toolchain

- **Node.js 24.x** is the development runtime, pinned via a
  `.tool-versions` file at the repo root and provisioned by
  [`asdf`](https://asdf-vm.com/). Run `asdf install` from the repo root
  before `npm install`. CI uses the same `.tool-versions` file via an
  `asdf` GitHub Action — never pin Node separately in a workflow matrix.
- The *shipped library* targets ES2022 and is runtime-agnostic (Node +
  Bun + Deno + browsers). The 24.x pin only applies to the dev
  environment.

## Commands

Build/test/lint commands will be added in M0. Until then there are no
runnable commands in this repo.

## Architecture preview

Once M0–M7 land, the pipeline will be:

```
source text → Lexer → tokens (with trivia) → Parser → CST
                                                       ├─► Document (lossless reprint + edits)
                                                       └─► Value (plain JS projection)
```

The CST is the single source of truth; `Value` is a projection over it.
This means `HCL.parse(s)` and `HCL.parseDocument(s).toValue()` must
always agree by construction — don't build them as two independent
parsers.
