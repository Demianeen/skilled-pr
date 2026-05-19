import { describe, expect, test } from "vitest";
import { parseAttestArgs, parseInitArgs, parseFlags } from "../src/args";

// ---------------------------------------------------------------------------
// parseAttestArgs (command-specific adapter)
// ---------------------------------------------------------------------------

describe("parseAttestArgs", () => {
  test("parses --skill <value>", () => {
    expect(parseAttestArgs(["--skill", "review"])).toEqual({
      ok: true,
      skill: "review",
      findings: undefined,
    });
  });

  test("REJECTS unknown flags (previously silently ignored)", () => {
    // Before strict parsing this case returned ok:true with the unknown
    // --foo silently dropped. Now it errors so users notice typos and
    // version-mismatch issues (e.g. running an old skilled-pr with a new
    // flag that doesn't exist yet).
    const result = parseAttestArgs(["--foo", "bar", "--skill", "review"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown flag.*--foo/i);
  });

  test("REJECTS positional arguments", () => {
    const result = parseAttestArgs(["unexpected-positional", "--skill", "review"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unexpected positional/i);
  });

  test("preserves namespaced skill names", () => {
    expect(parseAttestArgs(["--skill", "coderabbit:review"])).toEqual({
      ok: true,
      skill: "coderabbit:review",
      findings: undefined,
    });
  });

  test("fails when --skill is missing", () => {
    const result = parseAttestArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--skill.*missing/i);
  });

  test("fails when --skill has no value", () => {
    const result = parseAttestArgs(["--skill"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--skill.*requires a value/i);
  });

  test("fails when --skill is followed by another flag", () => {
    const result = parseAttestArgs(["--skill", "--findings"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--skill.*requires a value/i);
  });

  // --findings tests ---------------------------------------------------------

  test("parses --skill and --findings together", () => {
    expect(parseAttestArgs(["--skill", "review", "--findings", "out.json"])).toEqual({
      ok: true,
      skill: "review",
      findings: "out.json",
    });
  });

  test("--findings is optional - absent is fine", () => {
    const result = parseAttestArgs(["--skill", "review"]);
    expect(result).toEqual({ ok: true, skill: "review", findings: undefined });
  });

  test("flag order does not matter", () => {
    expect(parseAttestArgs(["--findings", "f.json", "--skill", "review"])).toEqual({
      ok: true,
      skill: "review",
      findings: "f.json",
    });
  });

  test("fails when --findings is followed by another flag", () => {
    const result = parseAttestArgs(["--skill", "review", "--findings", "--skill"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--findings.*requires a value/i);
  });

  test("fails when --findings has no value (trailing)", () => {
    const result = parseAttestArgs(["--skill", "review", "--findings"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--findings.*requires a value/i);
  });

  // --summary tests ----------------------------------------------------------

  test("parses --summary <path>", () => {
    expect(
      parseAttestArgs(["--skill", "review", "--summary", ".review/summary-review.md"]),
    ).toEqual({
      ok: true,
      skill: "review",
      findings: undefined,
      summary: ".review/summary-review.md",
    });
  });

  test("--summary is optional - absent is fine", () => {
    expect(parseAttestArgs(["--skill", "review"]).ok).toBe(true);
    expect((parseAttestArgs(["--skill", "review"]) as { summary?: string }).summary).toBeUndefined();
  });

  test("parses all three flags together regardless of order", () => {
    const expected = {
      ok: true,
      skill: "review",
      findings: "f.json",
      summary: "s.md",
    };
    expect(
      parseAttestArgs(["--skill", "review", "--findings", "f.json", "--summary", "s.md"]),
    ).toEqual(expected);
    expect(
      parseAttestArgs(["--summary", "s.md", "--skill", "review", "--findings", "f.json"]),
    ).toEqual(expected);
  });

  test("fails when --summary has no value (trailing)", () => {
    const result = parseAttestArgs(["--skill", "review", "--summary"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--summary.*requires a value/i);
  });

  test("fails when --summary is followed by another flag", () => {
    const result = parseAttestArgs(["--skill", "review", "--summary", "--findings", "f.json"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--summary.*requires a value/i);
  });

  // --flag=value form --------------------------------------------------------

  test("accepts --skill=value form", () => {
    expect(parseAttestArgs(["--skill=review"])).toEqual({
      ok: true,
      skill: "review",
      findings: undefined,
    });
  });

  test("accepts --skill=value and --findings=path together", () => {
    expect(parseAttestArgs(["--skill=review", "--findings=out.json"])).toEqual({
      ok: true,
      skill: "review",
      findings: "out.json",
    });
  });

  test("preserves equals signs in the value (e.g. namespaced=skill)", () => {
    expect(parseAttestArgs(["--skill=coderabbit:review"])).toEqual({
      ok: true,
      skill: "coderabbit:review",
      findings: undefined,
    });
  });

  test("rejects --flag= with empty value", () => {
    const result = parseAttestArgs(["--skill="]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--skill.*requires a value/i);
  });

  test("rejects duplicate flags", () => {
    const result = parseAttestArgs(["--skill", "review", "--skill", "other"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--skill.*more than once/i);
  });
});

// ---------------------------------------------------------------------------
// parseInitArgs (command-specific adapter)
// ---------------------------------------------------------------------------

describe("parseInitArgs", () => {
  test("no args - returns ok with no harness override (auto-detect path)", () => {
    expect(parseInitArgs([])).toEqual({ ok: true, forHarness: undefined });
  });

  test("--for codex - returns the harness name", () => {
    expect(parseInitArgs(["--for", "codex"])).toEqual({
      ok: true,
      forHarness: "codex",
    });
  });

  test("--for=codex - same result as space-separated", () => {
    expect(parseInitArgs(["--for=codex"])).toEqual({
      ok: true,
      forHarness: "codex",
    });
  });

  test("rejects unknown flags (the regression we are guarding against)", () => {
    const result = parseInitArgs(["--bogus", "value"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown flag.*--bogus/i);
  });

  test("rejects --for with no value", () => {
    const result = parseInitArgs(["--for"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--for.*requires a value/i);
  });

  test("rejects --for= with empty value", () => {
    const result = parseInitArgs(["--for="]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--for.*requires a value/i);
  });

  test("rejects positional arguments", () => {
    const result = parseInitArgs(["something"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unexpected positional/i);
  });
});

// ---------------------------------------------------------------------------
// parseFlags (the shared low-level parser)
// ---------------------------------------------------------------------------

describe("parseFlags", () => {
  test("empty args with empty spec succeeds", () => {
    expect(parseFlags([], {})).toEqual({ ok: true, values: {} });
  });

  test("empty args with required flag fails", () => {
    const r = parseFlags([], { foo: "required" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--foo.*missing/i);
  });

  test("walks tokens left to right (order preserved in values)", () => {
    const r = parseFlags(["--a", "1", "--b", "2"], { a: "optional", b: "optional" });
    expect(r).toEqual({ ok: true, values: { a: "1", b: "2" } });
  });

  test("equals form and space form interleave cleanly", () => {
    const r = parseFlags(["--a=1", "--b", "2"], { a: "optional", b: "optional" });
    expect(r).toEqual({ ok: true, values: { a: "1", b: "2" } });
  });

  test("optional flags absent stay undefined", () => {
    const r = parseFlags(["--a", "1"], { a: "optional", b: "optional" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.values.a).toBe("1");
    expect(r.values.b).toBeUndefined();
  });
});
