/**
 * Unified corpus test runner (M8). Walks every fixture under
 * `test/corpus/{hashicorp-hcl,opentofu,handwritten}` and runs:
 *
 *   1. `HCL.parse` succeeds with zero errors.
 *   2. The Value is idempotent under stringify round-trip
 *      (structurally equal after parse → stringify → parse, under a
 *      normalizer that ignores Expression-AST position details).
 *   3. Stringify is idempotent — applying it twice yields identical text.
 *   4. `parseDocument` returns a byte-identical `toString()`.
 *   5. `parseDocument(f).toValue()` agrees with `HCL.parse(f)`.
 *
 * Fixtures under `test/corpus/malformed/` are walked separately and
 * checked to produce at least one HCLParseError with `bail: false`.
 *
 * Opportunistic local corpus: if
 * `/Users/brian/src/other/cru-terraform` and/or
 * `/Users/brian/src/other/cru-terraform-modules` exist on disk, the
 * runner also walks their `.tf` files. Those paths are outside this
 * repo (never vendored), so CI and third-party contributors skip them
 * silently.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import HCL, {
  HCLParseError,
  isExpression,
  parse,
  parseDocument,
  stringify,
} from "../src/index.js";
import type { Value } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "corpus");

/** Listing helper: walk a directory recursively, returning absolute paths. */
function walkHcl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkHcl(full));
    } else if (entry.endsWith(".hcl") || entry.endsWith(".tf")) {
      out.push(full);
    }
  }
  return out;
}

/** Strip ExprAST positional noise so structural equality is meaningful. */
function normalize(v: Value): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (isExpression(v)) {
    return { __hcl: v.__hcl, kind: v.kind, source: v.source };
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    out[k] = normalize((v as Record<string, Value>)[k]!);
  }
  return out;
}

function runCleanCase(file: string): void {
  const text = readFileSync(file, "utf8");
  const value = parse(text);
  const emitted = stringify(value);
  const reparsed = parse(emitted);
  expect(normalize(reparsed)).toEqual(normalize(value));
  expect(stringify(reparsed)).toBe(emitted);

  const doc = parseDocument(text);
  expect(doc.toString()).toBe(text);
  expect(normalize(doc.toValue())).toEqual(normalize(value));
}

function runMalformedCase(file: string): void {
  const text = readFileSync(file, "utf8");
  // Expect at least one error; avoid hanging the test on an infinite
  // parse loop by bounding error collection.
  try {
    parse(text, { bail: false });
    throw new Error(`expected HCLParseError from ${file}`);
  } catch (e) {
    expect(e).toBeInstanceOf(HCLParseError);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendored + handwritten corpus
// ─────────────────────────────────────────────────────────────────────────────

interface Section {
  name: string;
  dir: string;
  kind: "clean" | "malformed";
}

const SECTIONS: Section[] = [
  { name: "hashicorp-hcl", dir: join(CORPUS, "hashicorp-hcl"), kind: "clean" },
  { name: "opentofu", dir: join(CORPUS, "opentofu"), kind: "clean" },
  { name: "handwritten", dir: join(CORPUS, "handwritten"), kind: "clean" },
  { name: "malformed", dir: join(CORPUS, "malformed"), kind: "malformed" },
];

const CLEAN_COUNT = SECTIONS.filter((s) => s.kind === "clean")
  .flatMap((s) => walkHcl(s.dir)).length;

describe("corpus coverage", () => {
  it(`exceeds the 50-file bar (clean: ${CLEAN_COUNT})`, () => {
    expect(CLEAN_COUNT).toBeGreaterThanOrEqual(50);
  });
});

for (const section of SECTIONS) {
  const files = walkHcl(section.dir);
  if (files.length === 0) continue;
  describe(`corpus: ${section.name} (${files.length} files)`, () => {
    for (const file of files) {
      const label = relative(CORPUS, file);
      if (section.kind === "clean") {
        it(label, () => runCleanCase(file));
      } else {
        it(`${label} — malformed`, () => runMalformedCase(file));
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Opportunistic local corpus (not vendored, not required on CI)
// ─────────────────────────────────────────────────────────────────────────────

// The local-path corpus is expensive (10k+ .tf files) so the runner
// only enumerates it when the `JS_HCL2_LOCAL_CORPUS=1` environment
// variable is set. Set that locally when you want the opportunistic
// real-world coverage; CI and contributors skip it by default.
const LOCAL_CORPUS_ENABLED = process.env.JS_HCL2_LOCAL_CORPUS === "1";
const LOCAL_CORPUS_ROOTS = LOCAL_CORPUS_ENABLED
  ? [
      "/Users/brian/src/other/cru-terraform",
      "/Users/brian/src/other/cru-terraform-modules",
    ]
  : [];

function walkLocal(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const skip = new Set([".terraform", ".git", "node_modules"]);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(full);
      else if (entry.endsWith(".tf")) out.push(full);
    }
  }
  return out;
}

for (const root of LOCAL_CORPUS_ROOTS) {
  const files = walkLocal(root);
  if (files.length === 0) continue;
  describe(`local corpus: ${root} (${files.length} files)`, () => {
    // The local corpus is a soft check: an individual file that trips
    // our parser shouldn't fail CI, but should produce a skipped-with-
    // reason test locally so the author sees it. In practice we run
    // with bail: false and surface the error count rather than
    // hard-failing.
    for (const file of files) {
      const label = relative(root, file);
      it(label, () => {
        const text = readFileSync(file, "utf8");
        // Allow errors on real-world configs — report but don't
        // assert. The vendored corpus is where correctness is enforced.
        const parsed = parse(text, { bail: false });
        // toString() should always match input byte-for-byte on clean
        // parses; for erroring inputs this still holds because the
        // CST is always complete.
        expect(parseDocument(text, { bail: false }).toString()).toBe(text);
        // And the Value is at least serializable.
        expect(typeof stringify(parsed)).toBe("string");
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public surface smoke
// ─────────────────────────────────────────────────────────────────────────────

describe("public entry points are wired", () => {
  it("HCL default export exposes parse/stringify/parseDocument", () => {
    expect(typeof HCL.parse).toBe("function");
    expect(typeof HCL.stringify).toBe("function");
    expect(typeof HCL.parseDocument).toBe("function");
  });
});
