import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  test("parses full JSONC config with comments and trailing commas", () => {
    const raw = `{
      // required skills
      "requiredSkills": ["review", "coderabbit:review"],
      "statusName": "My Check",
    }`;
    expect(parseConfig(raw)).toEqual({
      requiredSkills: ["review", "coderabbit:review"],
      statusName: "My Check",
      failOn: "error",
    });
  });

  test("merges defaults for missing fields", () => {
    expect(parseConfig('{ "requiredSkills": ["a"] }')).toEqual({
      requiredSkills: ["a"],
      statusName: "Skilled PR",
      failOn: "error",
    });
  });

  test("user fields override defaults", () => {
    expect(parseConfig('{ "statusName": "Custom" }').statusName).toBe("Custom");
  });

  test("returns defaults for empty object", () => {
    expect(parseConfig("{}")).toEqual({
      requiredSkills: ["review"],
      statusName: "Skilled PR",
      failOn: "error",
    });
  });

  test("accepts failOn: \"warning\"", () => {
    expect(parseConfig('{ "failOn": "warning" }').failOn).toBe("warning");
  });

  test("accepts failOn: \"none\"", () => {
    expect(parseConfig('{ "failOn": "none" }').failOn).toBe("none");
  });

  test("rejects unknown failOn values", () => {
    expect(() => parseConfig('{ "failOn": "critical" }')).toThrow(/failOn/);
  });

  test("rejects non-string failOn", () => {
    expect(() => parseConfig('{ "failOn": 0 }')).toThrow(/failOn/);
  });

  test("does not mangle // or /* */ inside strings (string-aware)", () => {
    // This is the key correctness win vs the old regex parser.
    const raw = `{ "statusName": "CI // PR review" }`;
    expect(parseConfig(raw).statusName).toBe("CI // PR review");
  });

  test("preserves /* ... */ inside strings", () => {
    const raw = `{ "statusName": "see /* old docs */ for context" }`;
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
  // summaryPrompt
  // -------------------------------------------------------------------------

  test("summaryPrompt is undefined by default (built-in artifact body used)", () => {
    expect(parseConfig('{}').summaryPrompt).toBeUndefined();
  });

  test("accepts a non-empty summaryPrompt string", () => {
    const raw = '{ "summaryPrompt": "Group findings by file; include severity badges." }';
    expect(parseConfig(raw).summaryPrompt).toBe(
      "Group findings by file; include severity badges.",
    );
  });

  test("rejects an empty summaryPrompt string", () => {
    // An empty prompt is almost certainly a typo (the user meant to write
    // something and didn't); bailing loud beats silently ignoring it.
    expect(() => parseConfig('{ "summaryPrompt": "" }')).toThrow(/summaryPrompt/);
  });

  test("rejects a non-string summaryPrompt", () => {
    expect(() => parseConfig('{ "summaryPrompt": 42 }')).toThrow(/summaryPrompt/);
    expect(() => parseConfig('{ "summaryPrompt": null }')).toThrow(/summaryPrompt/);
    expect(() => parseConfig('{ "summaryPrompt": ["a", "b"] }')).toThrow(/summaryPrompt/);
  });
});
