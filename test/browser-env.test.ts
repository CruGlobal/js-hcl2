/**
 * @vitest-environment happy-dom
 *
 * Smoke test verifying the library runs in a browser-like environment
 * — no reliance on Node-only globals (process / Buffer / fs / etc.).
 * happy-dom provides a minimal DOM implementation that matches how
 * real browsers expose globals; anything the library code accidentally
 * depended on that only exists in Node would crash here.
 *
 * Not a replacement for a real-browser smoke check (that would need
 * Playwright or similar); it is a faster, cheaper guard against
 * Node-only accidents creeping into `src/`. See docs/milestones.md M9
 * for the scope call that selected this option.
 */

import { describe, expect, it } from "vitest";
import HCL, { parse, parseDocument, stringify } from "../src/index.js";
import type { Value } from "../src/index.js";

describe("runs in a browser-like environment (happy-dom)", () => {
  it("exposes window and document globals from happy-dom", () => {
    // Sanity: the environment actually *is* happy-dom, not the vitest
    // default node environment.
    const g = globalThis as unknown as Record<string, unknown>;
    expect(typeof g.window).toBe("object");
    expect(typeof g.document).toBe("object");
  });


  it("parses HCL into a Value", () => {
    const v = parse('name = "demo"\nport = 8080\nenabled = true\n');
    expect(v).toEqual({ name: "demo", port: 8080, enabled: true });
  });

  it("stringifies a Value back to HCL", () => {
    const out = stringify({ a: 1, b: [1, 2, 3], c: "hi" });
    expect(out).toBe('a = 1\nb = [1, 2, 3]\nc = "hi"\n');
  });

  it("parseDocument round-trips byte-identically", () => {
    const src = 'resource "t" "n" {\n  acl = "private"\n}\n';
    const doc = parseDocument(src);
    expect(doc.toString()).toBe(src);
  });

  it("parses heredocs + unicode + interpolation in the browser env", () => {
    const src = 'greeting = "hello ${name}"\nbody = <<EOT\n日本語\nEOT\n';
    const doc = parseDocument(src);
    expect(doc.toString()).toBe(src);
    const v = doc.toValue() as Record<string, Value>;
    expect(v.body).toBe("日本語\n");
  });

  it("exposes the default HCL namespace", () => {
    expect(HCL.parse).toBe(parse);
    expect(HCL.stringify).toBe(stringify);
    expect(HCL.parseDocument).toBe(parseDocument);
  });
});
