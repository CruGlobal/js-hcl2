/**
 * Deno smoke test. Run with:
 *
 *     deno run --allow-read --allow-env scripts/deno-smoke.ts
 *
 * Loads the compiled ESM bundle (`dist/index.js`) and exercises the
 * public parse / stringify / parseDocument entry points against a
 * handful of representative inputs. CI runs this after `npm run build`
 * — see .github/workflows/ci.yml. Prints a terse summary and exits
 * non-zero on any assertion failure so the job fails visibly.
 */

// deno-lint-ignore-file no-explicit-any

// @ts-ignore — tsc running under Node doesn't know about ESM URL imports,
// but Deno executes this file directly.
import HCL, { parse, parseDocument, stringify } from "../dist/index.js";

function assertEquals(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${label}\n  expected: ${e}\n  got:      ${a}`);
    (globalThis as any).Deno?.exit?.(1);
    throw new Error(label);
  }
  console.log(`  ok: ${label}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    (globalThis as any).Deno?.exit?.(1);
    throw new Error(label);
  }
  console.log(`  ok: ${label}`);
}

console.log("js-hcl2 under Deno");

assertEquals(
  parse('name = "demo"\nport = 8080\nenabled = true\n'),
  { name: "demo", port: 8080, enabled: true },
  "parse flat attrs",
);

assertEquals(
  stringify({ a: 1, b: [1, 2, 3], c: "hi" }),
  'a = 1\nb = [1, 2, 3]\nc = "hi"\n',
  "stringify flat attrs",
);

const src = 'resource "t" "n" {\n  acl = "private"\n}\n';
assertEquals(
  parseDocument(src).toString(),
  src,
  "parseDocument byte-identical",
);

// Heredoc + unicode + interpolation preserved via Document.
const tricky = 'greeting = "hello ${name}"\nbody = <<EOT\n日本語\nEOT\n';
assertEquals(
  parseDocument(tricky).toString(),
  tricky,
  "heredoc + interpolation + unicode round-trip",
);

// Default export wiring.
assertTrue(HCL.parse === parse, "HCL.parse === parse");
assertTrue(HCL.stringify === stringify, "HCL.stringify === stringify");
assertTrue(
  HCL.parseDocument === parseDocument,
  "HCL.parseDocument === parseDocument",
);

console.log("all Deno smoke checks passed");
