import { describe, expect, test } from "vitest";
import { parseAttestArgs } from "../src/args";

describe("parseAttestArgs", () => {
  test("parses --skill <value>", () => {
    expect(parseAttestArgs(["--skill", "review"])).toEqual({
      ok: true,
      skill: "review",
      findings: undefined,
    });
  });

  test("tolerates extra args before --skill", () => {
    expect(parseAttestArgs(["--foo", "bar", "--skill", "review"])).toEqual({
      ok: true,
      skill: "review",
      findings: undefined,
    });
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
    const result = parseAttestArgs(["--skill", "--other"]);
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

  test("--findings is optional — absent is fine", () => {
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
    const result = parseAttestArgs(["--skill", "review", "--findings", "--other"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--findings.*requires a value/i);
  });

  test("fails when --findings has no value (trailing)", () => {
    const result = parseAttestArgs(["--skill", "review", "--findings"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--findings.*requires a value/i);
  });
});
