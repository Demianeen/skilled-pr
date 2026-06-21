import { describe, expect, test } from "vitest";
import {
  parseConfig,
  generateDefaultConfig,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_BRIEFING_PROMPT,
} from "../src/config";

// v1 configs MUST carry the schemaVersion sentinel. Most tests use this
// helper prefix so they don't have to repeat the boilerplate.
const SV = `"schemaVersion": ${CURRENT_SCHEMA_VERSION}`;

describe("parseConfig", () => {
  test("parses full JSONC config with comments and trailing commas", () => {
    const raw = `{
      ${SV},
      // required skills
      "requiredSkills": ["review", "coderabbit:review"],
      "statusName": "My Check",
      "summaryPrompt": "x",
    }`;
    expect(parseConfig(raw)).toEqual({
      schemaVersion: 1,
      requiredSkills: ["review", "coderabbit:review"],
      statusName: "My Check",
      failOn: "error",
      summaryPrompt: "x",
      briefingPrompt: null,
      autoReview: {
        trigger: "manual",
        execution: "subagent",
        parallel: true,
        sessionBriefing: true,
        skipPolicy: "agent-decides",
        askBeforeFiring: false,
      },
      rules: [],
    });
  });

  test("merges defaults for missing fields", () => {
    expect(parseConfig(`{ ${SV}, "requiredSkills": ["a"] }`)).toMatchObject({
      schemaVersion: 1,
      requiredSkills: ["a"],
      statusName: "Skilled PR",
      failOn: "error",
      summaryPrompt: null,
      briefingPrompt: null,
      rules: [],
    });
  });

  test("user fields override defaults", () => {
    expect(parseConfig(`{ ${SV}, "statusName": "Custom" }`).statusName).toBe("Custom");
  });

  test("accepts the minimum valid config (just schemaVersion)", () => {
    expect(parseConfig(`{ ${SV} }`)).toMatchObject({
      schemaVersion: 1,
      requiredSkills: ["review"],
      statusName: "Skilled PR",
      failOn: "error",
      summaryPrompt: null,
      briefingPrompt: null,
    });
  });

  test("accepts failOn: \"warning\"", () => {
    expect(parseConfig(`{ ${SV}, "failOn": "warning" }`).failOn).toBe("warning");
  });

  test("accepts failOn: \"none\"", () => {
    expect(parseConfig(`{ ${SV}, "failOn": "none" }`).failOn).toBe("none");
  });

  test("rejects unknown failOn values", () => {
    expect(() => parseConfig(`{ ${SV}, "failOn": "critical" }`)).toThrow(/failOn/);
  });

  test("rejects non-string failOn", () => {
    expect(() => parseConfig(`{ ${SV}, "failOn": 0 }`)).toThrow(/failOn/);
  });

  test("does not mangle // or /* */ inside strings (string-aware)", () => {
    const raw = `{ ${SV}, "statusName": "CI // PR review" }`;
    expect(parseConfig(raw).statusName).toBe("CI // PR review");
  });

  test("preserves /* ... */ inside strings", () => {
    const raw = `{ ${SV}, "statusName": "see /* old docs */ for context" }`;
    expect(parseConfig(raw).statusName).toBe("see /* old docs */ for context");
  });

  test("throws on invalid JSON with a descriptive message", () => {
    expect(() => parseConfig("{ not valid }")).toThrow(/Invalid \.skilledpr\/config\.jsonc/);
  });

  test("throws when top-level is an array", () => {
    expect(() => parseConfig("[]")).toThrow(/top-level value must be an object/);
  });

  test("throws when top-level is a string", () => {
    expect(() => parseConfig('"just a string"')).toThrow(/top-level value must be an object/);
  });

  // ---- Migration: legacy `sha` field ----
  test("rejects legacy `sha` field with a migration message", () => {
    expect(() => parseConfig('{ "sha": "head" }')).toThrow(/sha.*no longer supported/);
  });

  test("migration message mentions the recovery wrapper for silent-skip workflows", () => {
    expect(() => parseConfig('{ "sha": "pushed" }')).toThrow(/skilled-pr attest .* \|\| true/);
  });

  // -------------------------------------------------------------------------
  // schemaVersion (the v1 sentinel)
  // -------------------------------------------------------------------------

  test("missing schemaVersion throws with a migration hint", () => {
    // v0 configs (any config without schemaVersion) are no longer parsed by
    // this CLI. The user must regenerate or run the (forthcoming) migrator.
    expect(() => parseConfig("{}")).toThrow(/schemaVersion.*required/);
  });

  test("missing schemaVersion error mentions init AND the /skilled-pr-update migration path", () => {
    try {
      parseConfig("{}");
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/skilled-pr init/);
      expect(msg).toMatch(/skilled-pr-update|migrate|migration/i);
    }
  });

  test("schemaVersion: 2 (newer than CLI) is rejected", () => {
    // Forward-compat: doctor classifies this as "config is newer than CLI"
    // and recommends upgrade; the parser itself just refuses to load.
    expect(() => parseConfig('{ "schemaVersion": 2 }')).toThrow(/schemaVersion.*must be 1/);
  });

  test("schemaVersion: 0 (older than v1) is rejected with the same shape", () => {
    expect(() => parseConfig('{ "schemaVersion": 0 }')).toThrow(/schemaVersion.*must be 1/);
  });

  // -------------------------------------------------------------------------
  // summaryPrompt (now nullable in v1)
  // -------------------------------------------------------------------------

  test("summaryPrompt defaults to null when absent", () => {
    // v1: nullable. null resolves to DEFAULT_SUMMARY_PROMPT at use-site
    // (in resolve.ts). Writing the default inline is unnecessary
    // boilerplate, so we let it default.
    expect(parseConfig(`{ ${SV} }`).summaryPrompt).toBeNull();
  });

  test("accepts an arbitrary non-empty summaryPrompt", () => {
    const raw = `{ ${SV}, "summaryPrompt": "Group findings by file; include severity badges." }`;
    expect(parseConfig(raw).summaryPrompt).toBe(
      "Group findings by file; include severity badges.",
    );
  });

  test("accepts explicit null summaryPrompt", () => {
    expect(parseConfig(`{ ${SV}, "summaryPrompt": null }`).summaryPrompt).toBeNull();
  });

  test("rejects empty summaryPrompt", () => {
    expect(() => parseConfig(`{ ${SV}, "summaryPrompt": "" }`)).toThrow(/summaryPrompt/);
  });

  test("rejects non-string non-array summaryPrompt", () => {
    expect(() => parseConfig(`{ ${SV}, "summaryPrompt": 42 }`)).toThrow(/summaryPrompt/);
    expect(() => parseConfig(`{ ${SV}, "summaryPrompt": {} }`)).toThrow(/summaryPrompt/);
  });

  test("accepts summaryPrompt as an array of lines, joined with newlines", () => {
    // The array form is the readable multi-line authoring shape; it
    // normalizes to a single joined string for everything downstream.
    expect(parseConfig(`{ ${SV}, "summaryPrompt": ["a", "", "b"] }`).summaryPrompt).toBe("a\n\nb");
    expect(parseConfig(`{ ${SV}, "summaryPrompt": ["only one line"] }`).summaryPrompt).toBe(
      "only one line",
    );
  });

  test("rejects an empty or all-blank summaryPrompt array", () => {
    expect(() => parseConfig(`{ ${SV}, "summaryPrompt": [] }`)).toThrow(/summaryPrompt/);
    expect(() => parseConfig(`{ ${SV}, "summaryPrompt": ["", ""] }`)).toThrow(/blank/);
  });

  test("rejects a summaryPrompt array containing non-strings", () => {
    expect(() => parseConfig(`{ ${SV}, "summaryPrompt": ["ok", 42] }`)).toThrow(/summaryPrompt/);
  });

  test("generateDefaultConfig inlines the default as an array that round-trips", () => {
    // init writes the built-in default inlined (line-array). Parsing that
    // generated config must reproduce the exact default string.
    const parsed = parseConfig(generateDefaultConfig());
    expect(parsed.summaryPrompt).toBe(DEFAULT_SUMMARY_PROMPT);
    expect(parsed.briefingPrompt).toBe(DEFAULT_BRIEFING_PROMPT);
  });

  test("generateDefaultConfig does not expose stack PR numbers to users", () => {
    expect(generateDefaultConfig()).not.toContain("PR #");
  });

  test("DEFAULT_SUMMARY_PROMPT is a non-empty string", () => {
    expect(typeof DEFAULT_SUMMARY_PROMPT).toBe("string");
    expect(DEFAULT_SUMMARY_PROMPT.length).toBeGreaterThan(20);
  });

  // -------------------------------------------------------------------------
  // briefingPrompt (new in v1)
  // -------------------------------------------------------------------------

  test("briefingPrompt defaults to null", () => {
    expect(parseConfig(`{ ${SV} }`).briefingPrompt).toBeNull();
  });

  test("accepts an arbitrary non-empty briefingPrompt", () => {
    expect(parseConfig(`{ ${SV}, "briefingPrompt": "custom brief" }`).briefingPrompt).toBe(
      "custom brief",
    );
  });

  test("accepts explicit null briefingPrompt", () => {
    expect(parseConfig(`{ ${SV}, "briefingPrompt": null }`).briefingPrompt).toBeNull();
  });

  test("rejects empty briefingPrompt", () => {
    expect(() => parseConfig(`{ ${SV}, "briefingPrompt": "" }`)).toThrow(/briefingPrompt/);
  });

  test("rejects non-string non-null briefingPrompt", () => {
    expect(() => parseConfig(`{ ${SV}, "briefingPrompt": 42 }`)).toThrow(/briefingPrompt/);
  });

  test("DEFAULT_BRIEFING_PROMPT is a non-empty string with slot placeholders", () => {
    expect(typeof DEFAULT_BRIEFING_PROMPT).toBe("string");
    expect(DEFAULT_BRIEFING_PROMPT.length).toBeGreaterThan(50);
    // Slots that the orchestrator fills.
    expect(DEFAULT_BRIEFING_PROMPT).toContain("{{skill}}");
    expect(DEFAULT_BRIEFING_PROMPT).toContain("{{purpose}}");
    expect(DEFAULT_BRIEFING_PROMPT).toContain("{{constraints}}");
    expect(DEFAULT_BRIEFING_PROMPT).toContain("{{decisions}}");
    expect(DEFAULT_BRIEFING_PROMPT).toContain("{{exclusions}}");
  });

  // -------------------------------------------------------------------------
  // autoReview (new in v1)
  // -------------------------------------------------------------------------

  test("autoReview defaults are applied when the block is absent", () => {
    expect(parseConfig(`{ ${SV} }`).autoReview).toEqual({
      trigger: "manual",
      execution: "subagent",
      parallel: true,
      sessionBriefing: true,
      skipPolicy: "agent-decides",
      askBeforeFiring: false,
    });
  });

  test("autoReview overrides merge with defaults", () => {
    const raw = `{ ${SV}, "autoReview": { "trigger": "on-push", "askBeforeFiring": true } }`;
    expect(parseConfig(raw).autoReview).toEqual({
      trigger: "on-push",
      execution: "subagent",
      parallel: true,
      sessionBriefing: true,
      skipPolicy: "agent-decides",
      askBeforeFiring: true,
    });
  });

  test("rejects bogus autoReview.trigger", () => {
    expect(() =>
      parseConfig(`{ ${SV}, "autoReview": { "trigger": "always" } }`),
    ).toThrow(/autoReview\.trigger/);
  });

  test("rejects non-boolean autoReview.parallel", () => {
    expect(() =>
      parseConfig(`{ ${SV}, "autoReview": { "parallel": "yes" } }`),
    ).toThrow(/autoReview\.parallel/);
  });

  test("rejects bogus autoReview.execution", () => {
    expect(() =>
      parseConfig(`{ ${SV}, "autoReview": { "execution": "remote" } }`),
    ).toThrow(/autoReview\.execution/);
  });

  test("rejects bogus autoReview.skipPolicy", () => {
    expect(() =>
      parseConfig(`{ ${SV}, "autoReview": { "skipPolicy": "never" } }`),
    ).toThrow(/autoReview\.skipPolicy/);
  });

  // -------------------------------------------------------------------------
  // rules (new in v1)
  // -------------------------------------------------------------------------

  test("rules defaults to []", () => {
    expect(parseConfig(`{ ${SV} }`).rules).toEqual([]);
  });

  test("parses a rule with one match block", () => {
    const raw = `{
      ${SV},
      "rules": [
        { "name": "release", "match": [{ "branch": "release-*" }], "failOn": "warning" }
      ]
    }`;
    const c = parseConfig(raw);
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0]).toEqual({
      name: "release",
      match: [{ branch: "release-*" }],
      failOn: "warning",
    });
  });

  test("parses a rule with multiple match keys (AND within a block)", () => {
    const raw = `{
      ${SV},
      "rules": [
        { "match": [{ "branch": "release-*", "labels": ["security"] }] }
      ]
    }`;
    expect(parseConfig(raw).rules[0].match[0]).toEqual({
      branch: "release-*",
      labels: ["security"],
    });
  });

  test("parses a rule with multiple match blocks (OR across blocks)", () => {
    const raw = `{
      ${SV},
      "rules": [
        { "match": [{ "branch": "main" }, { "branch": "release-*" }] }
      ]
    }`;
    expect(parseConfig(raw).rules[0].match).toEqual([
      { branch: "main" },
      { branch: "release-*" },
    ]);
  });

  test("accepts rule.summaryPrompt as null", () => {
    const raw = `{ ${SV}, "rules": [{ "match": [{ "branch": "x" }], "summaryPrompt": null }] }`;
    expect(parseConfig(raw).rules[0].summaryPrompt).toBeNull();
  });

  test("accepts rule.requiredSkills override", () => {
    const raw = `{ ${SV}, "rules": [{ "match": [{ "branch": "x" }], "requiredSkills": ["security:review"] }] }`;
    expect(parseConfig(raw).rules[0].requiredSkills).toEqual(["security:review"]);
  });

  test("rejects rules that aren't an array", () => {
    expect(() => parseConfig(`{ ${SV}, "rules": {} }`)).toThrow(/rules.*must be an array/);
  });

  test("rejects a rule missing match", () => {
    expect(() =>
      parseConfig(`{ ${SV}, "rules": [{ "name": "x" }] }`),
    ).toThrow(/rules\[0\]\.match/);
  });

  test("rejects a match block with a non-string branch", () => {
    expect(() =>
      parseConfig(`{ ${SV}, "rules": [{ "match": [{ "branch": 42 }] }] }`),
    ).toThrow(/branch.*non-empty string/);
  });

  test("rejects a match block with non-string labels", () => {
    expect(() =>
      parseConfig(`{ ${SV}, "rules": [{ "match": [{ "labels": [1, 2] }] }] }`),
    ).toThrow(/labels.*array of strings/);
  });

  test("rejects a rule.failOn value that isn't an allowed enum", () => {
    expect(() =>
      parseConfig(`{ ${SV}, "rules": [{ "match": [{ "branch": "x" }], "failOn": "critical" }] }`),
    ).toThrow(/rules\[0\]\.failOn/);
  });
});
