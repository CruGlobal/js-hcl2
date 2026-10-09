/**
 * Error recovery with `bail: false` must always finish and keep every
 * source token in the CST.
 *
 * These tests live in their own file because the bug they cover was an
 * endless loop: a `}` with no block to close made the body parser report
 * an error, recover without moving, and try again, until the error list
 * ran the worker out of memory. A regression takes this file's worker
 * down without touching the rest of the suite.
 */

import { describe, expect, it } from "vitest";
import { HCLParseError, parse as parseValue, parseDocument } from "../../src/index.js";
import { parse } from "../../src/parser/parser.js";
import { print } from "../../src/parser/print.js";
import { SourceFile } from "../../src/source.js";

function recover(input: string) {
  return parse(new SourceFile(input), { bail: false });
}

describe("bail: false recovery always finishes", () => {
  it.each([
    ["a file that is only '}'", "}\n"],
    ["'}' with no trailing newline", "}"],
    ["several stray '}'", "}}}\n"],
    ["'}' between attributes", "a = 1\n}\nb = 2\n"],
    ["'}' after a closed block", "b {\n}\n}\n"],
    ["'}' followed by more on its line", "} a = 1\n"],
    ["invalid character in an object", "a = { @k = 1 }\n"],
    ["invalid character in a nested object", "a = { b = { @k = 1 } }\nc = 2\n"],
    ["invalid character in a block body", "b {\n  @ = 1\n}\n"],
  ])("finishes and stays lossless: %s", (_ctx, input) => {
    const result = recover(input);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(print(result.body)).toBe(input);
  });

  it("reports a stray '}' once and keeps parsing after it", () => {
    const result = recover("a = 1\n}\nb = 2\n");
    expect(result.errors.map((e) => e.message)).toEqual([
      "expected an attribute or block, got RBRACE",
    ]);
    expect(result.body.attributes.map((a) => a.name)).toEqual(["a", "b"]);
  });

  it("keeps the tokens it skips to reach the end of a line", () => {
    const input = "oops\nfoo = 1\nbar baz = 2\n";
    const result = recover(input);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.body.attributes.map((a) => a.name)).toEqual(["foo"]);
    expect(print(result.body)).toBe(input);
  });

  it.each([
    ["unclosed interpolation in a heredoc", "a = [<<EOT\n${&*/1"],
    ["unclosed interpolation in a quoted string", 'a = "${=b:${"\n'],
    ["if directive with no endif", 'a = "%{ if x }in"%{ endif }\n'],
    ["for directive with no endfor", 'a = "%{ for v in vs }x"\nb = 1\n'],
  ])("keeps unexpected tokens in a template body: %s", (_ctx, input) => {
    const result = recover(input);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(print(result.body)).toBe(input);
  });

  it.each([
    ["an if with no endif", 'a = "%{ if x }in"\nb = 2\n'],
    ["a for with no endfor", 'a = "%{ for v in vs }x"\nb = 1\n'],
    ["an if with no endif in a heredoc", "a = <<EOT\n%{ if x }in\nEOT\nb = 1\n"],
  ])("stops an open directive at the end of its template: %s", (_ctx, input) => {
    const result = recover(input);
    expect(result.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^unexpected end of template/),
    ]);
    expect(result.body.attributes.map((a) => a.name)).toEqual(["a", "b"]);
    expect(print(result.body)).toBe(input);
  });

  it("throws one aggregate error from parse() and parseDocument()", () => {
    for (const run of [
      () => parseValue("a = 1\n}\nb = 2\n", { bail: false }),
      () => parseDocument("a = 1\n}\nb = 2\n", { bail: false }),
      () => parseValue("a = { @k = 1 }\n", { bail: false }),
      () => parseDocument("a = { @k = 1 }\n", { bail: false }),
    ]) {
      expect(run).toThrow(HCLParseError);
    }
  });
});
