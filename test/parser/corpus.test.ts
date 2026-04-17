import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { print } from "../../src/parser/print.js";
import { SourceFile } from "../../src/source.js";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, "..", "corpus", "hashicorp-hcl");

const KNOWN_INVALID = new Set<string>([
  // Intentionally ill-formed specsuite fixtures. Keep them out of the
  // clean-parse bar; we'll use them for error-recovery testing later.
  "specsuite_tests_structure_attributes_unexpected.hcl",
  "specsuite_tests_structure_attributes_singleline_bad.hcl",
  "specsuite_tests_structure_blocks_single_oneline_invalid.hcl",
  "specsuite_tests_structure_blocks_single_unclosed.hcl",
]);

const fixtures = readdirSync(CORPUS_DIR)
  .filter((name) => name.endsWith(".hcl"))
  .filter((name) => !KNOWN_INVALID.has(name))
  .sort();

describe("hashicorp/hcl corpus", () => {
  it("discovered at least 5 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of fixtures) {
    it(`parses without errors: ${file}`, () => {
      const text = readFileSync(join(CORPUS_DIR, file), "utf8");
      const result = parse(new SourceFile(text, file), { bail: false });
      expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    });

    it(`round-trips: ${file}`, () => {
      const text = readFileSync(join(CORPUS_DIR, file), "utf8");
      const result = parse(new SourceFile(text, file), { bail: false });
      expect(print(result.body)).toBe(text);
    });
  }
});
