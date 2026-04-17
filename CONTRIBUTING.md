# Contributing to @cruglobal/js-hcl2

Thanks for your interest in contributing. This document covers the
conventions and toolchain expectations for the repository.

## Toolchain

This project uses [`asdf`](https://asdf-vm.com/) to pin the exact Node.js
version used for development and CI. The pinned version is declared in the
repo-root `.tool-versions` file; contributors must install `asdf`, add the
Node.js plugin, and run `asdf install` from the repo root before running
`npm install`.

```sh
asdf plugin add nodejs
asdf install
npm install
```

Do **not** bypass `asdf` by installing Node.js through a different mechanism
(e.g. Homebrew, fnm, nvm) for contribution work — divergent versions cause
hard-to-debug failures and make PR reviews inconsistent. CI reads the same
`.tool-versions` file, so a green local build implies a green CI build.

## Workflow

1. Pick exactly one milestone from [`docs/milestones.md`](docs/milestones.md)
   and work through its deliverables in order. Do not mix work from
   multiple milestones in the same PR.
2. Keep commits focused. The "Done when" bar on each milestone is the
   acceptance criterion — do not mark work complete until it is green.
3. Before opening a PR, run the full local check:
   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```
4. Design-level changes require updating
   [`docs/design.md`](docs/design.md) in the same PR. The design doc is
   authoritative; drift between docs and code is a bug.

## Code conventions

- TypeScript `strict: true`. No implicit `any`; no unchecked indexed
  access.
- Zero runtime dependencies in the published library. Dev dependencies
  are fine.
- ESM + CJS must both work. Do not import Node-only APIs from library
  source (`src/**`); tests may use Node APIs.
- The library must also run in Bun, Deno, and modern browsers. See M9 in
  [`docs/milestones.md`](docs/milestones.md) for the cross-runtime CI bar.

## License

By contributing, you agree that your contributions will be licensed under
the [BSD-3-Clause License](LICENSE).
