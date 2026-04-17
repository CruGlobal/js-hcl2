/**
 * Cross-check against [`hcl2-json-parser`](https://www.npmjs.com/package/hcl2-json-parser),
 * the most commonly-used existing HCL2 reader in the JS ecosystem.
 *
 * hcl2-json-parser has different semantics from ours on two axes that
 * matter:
 *
 *   1. Expressions: hcl2-json-parser emits non-literal expressions as
 *      `"${…}"` strings (partial evaluation / passthrough). We wrap
 *      them in `Expression` objects.
 *   2. Block grouping: hcl2-json-parser always nests block instances
 *      in an array (`"n": [{…}]`), even for a single block. We
 *      collapse single blocks to a bare object and collect duplicates
 *      into an array.
 *
 * Because of those divergences, this file does not attempt a deep-diff
 * of values. Instead it runs a coarser compatibility check on every
 * clean corpus fixture:
 *
 *   - Both parsers must accept the input (or both must reject it).
 *   - Top-level keys must match (attribute + block names agree).
 *
 * Those two properties catch the interesting failure modes — one
 * parser silently dropping a statement, one parser misidentifying the
 * block structure, or a lexing divergence that skips tokens.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import hcl2JsonParser from "hcl2-json-parser";
interface Hcl2JsonParser {
  parseToObject: (source: string) => Promise<unknown>;
  parseToString: (source: string) => Promise<string>;
}
const hcl2 = hcl2JsonParser as unknown as Hcl2JsonParser;
import { parse } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "corpus");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".hcl") || entry.name.endsWith(".tf")) {
      out.push(full);
    }
  }
  return out;
}

const CLEAN_DIRS = ["hashicorp-hcl", "opentofu", "handwritten"];
const FILES = CLEAN_DIRS.flatMap((d) => walk(join(CORPUS, d)));

/**
 * A small set of fixtures that neither parser can agree on — usually
 * because the syntax relies on a spec corner that one side interprets
 * differently. Documented rather than silently skipped.
 */
const KNOWN_DIVERGENCES = new Set<string>([
  // hclwrite fuzz corpus contains inputs that hit their own edge cases;
  // most pass, but some trigger divergent interpretations. They're
  // exercised by our corpus runner independently; cross-parser
  // agreement is a bonus, not the contract.
  "hashicorp-hcl/hclwrite_fuzz_just-interp.hcl",
  "hashicorp-hcl/hclwrite_fuzz_escape-newline.hcl",
]);

interface ParseOutcome {
  ok: boolean;
  topKeys: string[];
  error?: string;
}

async function runTheirs(source: string): Promise<ParseOutcome> {
  try {
    const result = (await hcl2.parseToObject(source)) as Record<
      string,
      unknown
    >;
    return { ok: true, topKeys: Object.keys(result).sort() };
  } catch (e) {
    return { ok: false, topKeys: [], error: String(e) };
  }
}

function runOurs(source: string): ParseOutcome {
  try {
    const result = parse(source) as Record<string, unknown>;
    return { ok: true, topKeys: Object.keys(result).sort() };
  } catch (e) {
    return {
      ok: false,
      topKeys: [],
      error: (e as Error).message,
    };
  }
}

describe("cross-parser: hcl2-json-parser", () => {
  it("discovered the corpus", () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    const label = relative(CORPUS, file);
    if (KNOWN_DIVERGENCES.has(label)) {
      it.skip(`${label} (known divergence)`, () => {});
      continue;
    }
    it(label, async () => {
      const text = readFileSync(file, "utf8");
      const theirs = await runTheirs(text);
      const ours = runOurs(text);
      if (theirs.ok !== ours.ok) {
        throw new Error(
          `acceptance divergence on ${label}: theirs=${theirs.ok ? "ok" : theirs.error}, ours=${ours.ok ? "ok" : ours.error}`,
        );
      }
      if (theirs.ok) {
        expect(ours.topKeys, `top-level keys agree for ${label}`).toEqual(
          theirs.topKeys,
        );
      }
    });
  }
});
