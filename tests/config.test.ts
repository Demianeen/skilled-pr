import { describe, expect, test } from "vitest";
import { parseConfig, DEFAULT_SUMMARY_PROMPT } from "../src/config";

// Helper: most tests don't care about summaryPrompt; we just need a valid
// one present so the parser doesn't reject. Pass any non-empty string.
const PROMPT = '"summaryPrompt": "x"';

describe("parseConfig", () => {
  test("parses full JSONC config with comments and trailing commas", () => {
    const raw = `{
      // required skills
      "requiredSkills": ["review", "coderabbit:review"],
      "statusName": "My Check",
      ${PROMPT},
    }`;
    expect(parseConfig(raw)).toEqual({
      requiredSkills: ["review", "coderabbit:review"],
      statusName: "My Check",
      failOn: "error",
      summaryPrompt: "x",
    });
  });

  test("merges defaults for missing fields (other than summaryPrompt)", () => {
    expect(parseConfig(`{ "requiredSkills": ["a"], ${PROMPT} }`)).toEqual({
      requiredSkills: ["a"],
      statusName: "Skilled PR",
      failOn: "error",
      summaryPrompt: "x",
    });
  });

  test("user fields override defaults", () => {
    expect(parseConfig(`{ "statusName": "Custom", ${PROMPT} }`).statusName).toBe("Custom");
  });

  test("accepts the minimum valid config (just summaryPrompt + defaults for the rest)", () => {
    expect(parseConfig(`{ ${PROMPT} }`)).toEqual({
      requiredSkills: ["review"],
      statusName: "Skilled PR",
      failOn: "error",
      summaryPrompt: "x",
    });
  });

  test("accepts failOn: \"warning\"", () => {
    expect(parseConfig(`{ "failOn": "warning", ${PROMPT} }`).failOn).toBe("warning");
  });

  test("accepts failOn: \"none\"", () => {
    expect(parseConfig(`{ "failOn": "none", ${PROMPT} }`).failOn).toBe("none");
  });

  test("rejects unknown failOn values", () => {
    expect(() => parseConfig(`{ "failOn": "critical", ${PROMPT} }`)).toThrow(/failOn/);
  });

  test("rejects non-string failOn", () => {
    expect(() => parseConfig(`{ "failOn": 0, ${PROMPT} }`)).toThrow(/failOn/);
  });

  test("does not mangle // or /* */ inside strings (string-aware)", () => {
    // This is the key correctness win vs the old regex parser.
    const raw = `{ "statusName": "CI // PR review", ${PROMPT} }`;
    expect(parseConfig(raw).statusName).toBe("CI // PR review");
  });

  test("preserves /* ... */ inside strings", () => {
    const raw = `{ "statusName": "see /* old docs */ for context", ${PROMPT} }`;
    expect(parseConfig(raw).statusName).toBe("see /* old docs */ for context");
  });

  test("throws on invalid JSON with a descriptive message", () => {
    expect(() => parseConfig("{ not valid }")).toThrow(/Invalid \.skilledpr\.jsonc/);
  });

  test("throws when top-level is an array", () => {
    expect(() => parseConfig("[]")).toThrow(/top-level value must be an object/);
  });

  test("throws when top-level is a string", () => {
    expect(() => parseConfig('"just a string"')).toThrow(/top-level value must be an object/);
  });

  // ---- Migration: legacy `sha` field ----
  // The `sha` field used to be `"head" | "pushed"`. We removed it; the parser
  // must surface a clear migration error so users can fix their configs.

  test("rejects legacy `sha` field with a migration message", () => {
    expect(() => parseConfig('{ "sha": "head" }')).toThrow(/sha.*no longer supported/);
  });

  test("migration message mentions the recovery wrapper for silent-skip workflows", () => {
    // Users who relied on `sha: "pushed"` for passive-skip semantics need to
    // know how to keep that behavior in their shell.
    expect(() => parseConfig('{ "sha": "pushed" }')).toThrow(/skilled-pr attest .* \|\| true/);
  });

  // -------------------------------------------------------------------------
  // summaryPrompt (now REQUIRED, no longer optional)
  // -------------------------------------------------------------------------

  test("missing summaryPrompt throws with a helpful migration hint", () => {
    // Previously summaryPrompt was optional with a built-in fallback. Now
    // it's the only description of what the PR comment should look like
    // (skilled-pr no longer renders one itself), so it must be present.
    // Old configs need to be regenerated.
    expect(() => parseConfig("{}")).toThrow(/summaryPrompt.*required/);
  });

  test("missing summaryPrompt error tells the user how to fix it", () => {
    try {
      parseConfig("{}");
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/skilled-pr init/);
      expect(msg).toMatch(/DEFAULT_SUMMARY_PROMPT|docs\/SCHEMA\.md/);
    }
  });

  test("accepts an arbitrary non-empty summaryPrompt", () => {
    const raw = '{ "summaryPrompt": "Group findings by file; include severity badges." }';
    expect(parseConfig(raw).summaryPrompt).toBe(
      "Group findings by file; include severity badges.",
    );
  });

  test("rejects empty summaryPrompt", () => {
    expect(() => parseConfig('{ "summaryPrompt": "" }')).toThrow(/summaryPrompt/);
  });

  test("rejects non-string summaryPrompt", () => {
    expect(() => parseConfig('{ "summaryPrompt": 42 }')).toThrow(/summaryPrompt/);
    expect(() => parseConfig('{ "summaryPrompt": null }')).toThrow(/summaryPrompt/);
    expect(() => parseConfig('{ "summaryPrompt": ["a", "b"] }')).toThrow(/summaryPrompt/);
  });

  test("DEFAULT_SUMMARY_PROMPT is a non-empty string (sanity for init's default)", () => {
    // init writes this exact value into newly-created configs. If it ever
    // regressed to "" or undefined we'd ship a default that fails the
    // parser, breaking init's own output.
    expect(typeof DEFAULT_SUMMARY_PROMPT).toBe("string");
    expect(DEFAULT_SUMMARY_PROMPT.length).toBeGreaterThan(20);
  });
});
