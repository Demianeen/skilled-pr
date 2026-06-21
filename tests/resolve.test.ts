import { describe, expect, test } from "vitest";
import {
  DEFAULT_BRIEFING_PROMPT,
  DEFAULT_SUMMARY_PROMPT,
  type SkilledPRConfig,
} from "../src/config";
import {
  formatReminder,
  matchesAuthor,
  matchesBranch,
  matchesLabels,
  matchesRule,
  resolveProfile,
  slugifySkill,
  type PRContext,
  type ResolvedProfile,
} from "../src/resolve";

// Base config helper — gives us a known shape we can spread per-test.
function baseConfig(overrides: Partial<SkilledPRConfig> = {}): SkilledPRConfig {
  return {
    schemaVersion: 1,
    requiredSkills: ["review"],
    statusName: "Skilled PR",
    failOn: "error",
    summaryPrompt: null,
    briefingPrompt: null,
    autoReview: {
      trigger: "manual",
      execution: "main-agent",
      parallel: true,
      sessionBriefing: false,
      skipPolicy: "agent-decides",
      askBeforeFiring: false,
    },
    rules: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// matchesBranch
// ---------------------------------------------------------------------------

describe("matchesBranch", () => {
  test("exact match", () => {
    expect(matchesBranch("main", "main")).toBe(true);
    expect(matchesBranch("main", "develop")).toBe(false);
  });

  test("wildcard suffix glob", () => {
    expect(matchesBranch("release-*", "release-1.2.3")).toBe(true);
    expect(matchesBranch("release-*", "release-")).toBe(true);
    expect(matchesBranch("release-*", "main")).toBe(false);
  });

  test("wildcard in the middle", () => {
    expect(matchesBranch("feat/*/done", "feat/auth/done")).toBe(true);
    expect(matchesBranch("feat/*/done", "feat/done")).toBe(false);
  });

  test("anchored on both ends (no partial match)", () => {
    expect(matchesBranch("release-*", "pre-release-1.0")).toBe(false);
    expect(matchesBranch("release-*", "release-1-extra")).toBe(true);
  });

  test("regex metacharacters in pattern are escaped (treated literally)", () => {
    // `release-please--branch--main--v1.0.0` is what release-please uses.
    // Dots must not act as regex `.` matchers.
    expect(matchesBranch("release-please--*", "release-please--branch--main--v1.0.0")).toBe(true);
    expect(matchesBranch("foo.bar", "fooxbar")).toBe(false);
    expect(matchesBranch("foo.bar", "foo.bar")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchesAuthor
// ---------------------------------------------------------------------------

describe("matchesAuthor", () => {
  test("exact match", () => {
    expect(matchesAuthor("Demianeen", "Demianeen")).toBe(true);
  });

  test("case-sensitive", () => {
    expect(matchesAuthor("Demianeen", "demianeen")).toBe(false);
  });

  test("undefined actual → never matches", () => {
    expect(matchesAuthor("anyone", undefined)).toBe(false);
  });

  test("preserves dashes / brackets (bot accounts)", () => {
    expect(matchesAuthor("dependabot[bot]", "dependabot[bot]")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchesLabels
// ---------------------------------------------------------------------------

describe("matchesLabels", () => {
  test("subset semantics: required labels must all be present", () => {
    expect(matchesLabels(["security"], ["security", "p0"])).toBe(true);
    expect(matchesLabels(["security", "p0"], ["security"])).toBe(false);
  });

  test("empty required matches anything (vacuously true)", () => {
    expect(matchesLabels([], ["any", "label"])).toBe(true);
    expect(matchesLabels([], [])).toBe(true);
  });

  test("undefined actual → never matches (no label data)", () => {
    expect(matchesLabels(["security"], undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchesRule (OR across blocks, AND within a block)
// ---------------------------------------------------------------------------

describe("matchesRule", () => {
  test("single block with single key", () => {
    expect(
      matchesRule({ match: [{ branch: "main" }] }, { branch: "main" }),
    ).toBe(true);
    expect(
      matchesRule({ match: [{ branch: "main" }] }, { branch: "develop" }),
    ).toBe(false);
  });

  test("AND within a block: all keys must match", () => {
    const rule = { match: [{ branch: "main", author: "alice" }] };
    expect(matchesRule(rule, { branch: "main", author: "alice" })).toBe(true);
    expect(matchesRule(rule, { branch: "main", author: "bob" })).toBe(false);
    expect(matchesRule(rule, { branch: "develop", author: "alice" })).toBe(false);
  });

  test("OR across blocks: any block matching is a hit", () => {
    const rule = { match: [{ branch: "main" }, { branch: "release-*" }] };
    expect(matchesRule(rule, { branch: "main" })).toBe(true);
    expect(matchesRule(rule, { branch: "release-1.0" })).toBe(true);
    expect(matchesRule(rule, { branch: "develop" })).toBe(false);
  });

  test("labels: ALL required labels must be present", () => {
    const rule = { match: [{ labels: ["security", "p0"] }] };
    expect(
      matchesRule(rule, { branch: "x", labels: ["security", "p0", "extra"] }),
    ).toBe(true);
    expect(matchesRule(rule, { branch: "x", labels: ["security"] })).toBe(false);
  });

  test("empty match array never matches", () => {
    expect(matchesRule({ match: [] }, { branch: "any" })).toBe(false);
  });

  test("empty match block matches anything (matches all branches)", () => {
    // An empty `{}` block is technically valid; useful for "catch-all"
    // rules placed at the end of the rules array.
    expect(matchesRule({ match: [{}] }, { branch: "any" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveProfile
// ---------------------------------------------------------------------------

describe("resolveProfile", () => {
  const CTX_MAIN: PRContext = { branch: "main" };
  const CTX_RELEASE: PRContext = { branch: "release-1.0" };

  test("no rules → top-level values + null prompts resolved to defaults", () => {
    const profile = resolveProfile(baseConfig(), CTX_MAIN);
    expect(profile).toEqual<ResolvedProfile>({
      matchedRuleName: null,
      requiredSkills: ["review"],
      failOn: "error",
      summaryPrompt: DEFAULT_SUMMARY_PROMPT,
      briefingPrompt: DEFAULT_BRIEFING_PROMPT,
      execution: "main-agent",
      sessionBriefing: false,
      skipPolicy: "agent-decides",
    });
  });

  test("first matching rule wins", () => {
    const cfg = baseConfig({
      rules: [
        { name: "release", match: [{ branch: "release-*" }], failOn: "warning" },
        { name: "wildcard", match: [{}], failOn: "none" },
      ],
    });
    expect(resolveProfile(cfg, CTX_RELEASE).matchedRuleName).toBe("release");
    expect(resolveProfile(cfg, CTX_RELEASE).failOn).toBe("warning");
    // For a non-release branch, the catch-all "wildcard" matches.
    expect(resolveProfile(cfg, CTX_MAIN).matchedRuleName).toBe("wildcard");
    expect(resolveProfile(cfg, CTX_MAIN).failOn).toBe("none");
  });

  test("rule's requiredSkills override the top-level", () => {
    const cfg = baseConfig({
      requiredSkills: ["review"],
      rules: [
        {
          name: "stricter",
          match: [{ branch: "main" }],
          requiredSkills: ["review", "gstack:cso"],
        },
      ],
    });
    expect(resolveProfile(cfg, CTX_MAIN).requiredSkills).toEqual([
      "review",
      "gstack:cso",
    ]);
  });

  test("rule with empty requiredSkills produces empty resolved skills", () => {
    // Explicit empty override = "skip required reviews for this context"
    const cfg = baseConfig({
      requiredSkills: ["review"],
      rules: [{ name: "bot", match: [{ author: "dependabot[bot]" }], requiredSkills: [] }],
    });
    expect(
      resolveProfile(cfg, { branch: "deps/bump", author: "dependabot[bot]" }).requiredSkills,
    ).toEqual([]);
  });

  test("rule.summaryPrompt: null resolves to DEFAULT_SUMMARY_PROMPT", () => {
    const cfg = baseConfig({
      summaryPrompt: "top-level custom",
      rules: [{ match: [{ branch: "main" }], summaryPrompt: null }],
    });
    expect(resolveProfile(cfg, CTX_MAIN).summaryPrompt).toBe(DEFAULT_SUMMARY_PROMPT);
  });

  test("rule.summaryPrompt: string overrides top-level", () => {
    const cfg = baseConfig({
      summaryPrompt: "top-level custom",
      rules: [{ match: [{ branch: "main" }], summaryPrompt: "rule custom" }],
    });
    expect(resolveProfile(cfg, CTX_MAIN).summaryPrompt).toBe("rule custom");
  });

  test("rule.summaryPrompt absent falls back to top-level", () => {
    const cfg = baseConfig({
      summaryPrompt: "top-level custom",
      rules: [{ match: [{ branch: "main" }], failOn: "warning" }],
    });
    expect(resolveProfile(cfg, CTX_MAIN).summaryPrompt).toBe("top-level custom");
  });

  test("top-level summaryPrompt: null still resolves to default", () => {
    const cfg = baseConfig({ summaryPrompt: null });
    expect(resolveProfile(cfg, CTX_MAIN).summaryPrompt).toBe(DEFAULT_SUMMARY_PROMPT);
  });

  test("top-level briefingPrompt: null resolves to DEFAULT_BRIEFING_PROMPT", () => {
    expect(resolveProfile(baseConfig(), CTX_MAIN).briefingPrompt).toBe(
      DEFAULT_BRIEFING_PROMPT,
    );
  });

  test("top-level briefingPrompt: string is preserved", () => {
    const cfg = baseConfig({ briefingPrompt: "custom session brief" });
    expect(resolveProfile(cfg, CTX_MAIN).briefingPrompt).toBe("custom session brief");
  });

  test("release-please--* glob example from the planning conversation", () => {
    // Sanity: the canonical release-please pattern resolves cleanly.
    const cfg = baseConfig({
      rules: [
        {
          name: "release-please skips review",
          match: [{ branch: "release-please--*" }],
          requiredSkills: [],
        },
      ],
    });
    expect(
      resolveProfile(cfg, { branch: "release-please--branches--main--v1.0.0" }).requiredSkills,
    ).toEqual([]);
  });

  test("author exact match drives the rule", () => {
    const cfg = baseConfig({
      rules: [
        {
          name: "dependabot bypass",
          match: [{ author: "dependabot[bot]" }],
          requiredSkills: [],
        },
      ],
    });
    expect(
      resolveProfile(cfg, { branch: "deps/bump", author: "dependabot[bot]" }).requiredSkills,
    ).toEqual([]);
    // Different author → no match → top-level applies.
    expect(
      resolveProfile(cfg, { branch: "deps/bump", author: "alice" }).requiredSkills,
    ).toEqual(["review"]);
  });

  test("labels subset drives the rule", () => {
    const cfg = baseConfig({
      rules: [
        {
          name: "security-labeled",
          match: [{ labels: ["security"] }],
          requiredSkills: ["review", "gstack:cso"],
        },
      ],
    });
    expect(
      resolveProfile(cfg, { branch: "x", labels: ["security", "p0"] }).requiredSkills,
    ).toEqual(["review", "gstack:cso"]);
    // Required label absent → no match → top-level.
    expect(
      resolveProfile(cfg, { branch: "x", labels: ["p0"] }).requiredSkills,
    ).toEqual(["review"]);
  });
});

// ---------------------------------------------------------------------------
// slugifySkill
// ---------------------------------------------------------------------------

describe("slugifySkill (re-exported helper)", () => {
  test("colon becomes dash", () => {
    expect(slugifySkill("coderabbit:review")).toBe("coderabbit-review");
  });
  test("lowercases", () => {
    expect(slugifySkill("REVIEW")).toBe("review");
  });
  test("collapses runs of non-alnum", () => {
    expect(slugifySkill("foo___bar")).toBe("foo-bar");
  });
});

// ---------------------------------------------------------------------------
// formatReminder
// ---------------------------------------------------------------------------

describe("formatReminder", () => {
  // Default profile: inline (main-agent) execution. Tests for the
  // subagent variant override `execution` explicitly below.
  const baseProfile: ResolvedProfile = {
    matchedRuleName: null,
    requiredSkills: ["review"],
    failOn: "error",
    summaryPrompt: "Render markdown.",
    briefingPrompt: DEFAULT_BRIEFING_PROMPT,
    execution: "main-agent",
    sessionBriefing: false,
    skipPolicy: "agent-decides",
  };

  test("includes the skill name verbatim", () => {
    expect(formatReminder(baseProfile, "coderabbit:review", "claude")).toContain(
      "`coderabbit:review`",
    );
  });

  test("uses the slugified path", () => {
    const r = formatReminder(baseProfile, "coderabbit:review", "claude");
    expect(r).toContain(".review/findings-coderabbit-review.json");
    expect(r).toContain(".review/summary-coderabbit-review.md");
  });

  test("attest command preserves the un-slugified skill name in --skill", () => {
    const r = formatReminder(baseProfile, "coderabbit:review", "claude");
    expect(r).toContain("--skill coderabbit:review");
  });

  test("embeds the resolved summaryPrompt verbatim", () => {
    const distinct = "FIND_THIS_EXACT_PHRASE_2718281828";
    const profile = { ...baseProfile, summaryPrompt: `prefix ${distinct} suffix` };
    expect(formatReminder(profile, "review", "claude")).toContain(distinct);
  });

  test("indents multi-line summaryPrompt for the nested list step", () => {
    const profile = { ...baseProfile, summaryPrompt: "line 1\nline 2" };
    const r = formatReminder(profile, "review", "claude");
    expect(r).toContain("   line 1");
    expect(r).toContain("   line 2");
  });

  test("includes the 4-step recovery instruction including exit code 2", () => {
    const r = formatReminder(baseProfile, "review", "claude");
    expect(r).toMatch(/four things in order/i);
    expect(r).toContain("exits with code 2");
    expect(r).toContain("git push");
    expect(r).toMatch(/ask the user/i);
  });

  test("references the v1 config path", () => {
    const r = formatReminder(baseProfile, "review", "claude");
    expect(r).toContain(".skilledpr/config.jsonc");
  });

  test("identical body for claude vs codex harness today (variance is plumbed but not used yet)", () => {
    // Forward compat: signature accepts harness so we can vary later
    // without churning every call site. Today the two paths produce
    // identical output.
    const claude = formatReminder(baseProfile, "review", "claude");
    const codex = formatReminder(baseProfile, "review", "codex");
    expect(claude).toBe(codex);
  });

  test("includes the findings schema description", () => {
    const r = formatReminder(baseProfile, "review", "claude");
    expect(r).toContain("severity");
    expect(r).toContain("path");
    expect(r).toContain("line");
  });

  test("tells the model how to encode 'no findings'", () => {
    expect(formatReminder(baseProfile, "review", "claude")).toContain("[]");
  });
});

describe("formatReminder — subagent execution mode", () => {
  const subagentProfile: ResolvedProfile = {
    matchedRuleName: null,
    requiredSkills: ["review"],
    failOn: "error",
    summaryPrompt: "Render markdown.",
    briefingPrompt: DEFAULT_BRIEFING_PROMPT,
    execution: "subagent",
    sessionBriefing: true,
    skipPolicy: "agent-decides",
  };

  test("instructs Claude users to spawn via Claude Code's Task tool", () => {
    const r = formatReminder(subagentProfile, "review", "claude");
    expect(r).toContain("autoReview.execution=subagent");
    expect(r).toContain("Claude Code's Task tool");
    expect(r).toContain("Use a general-purpose subagent");
    expect(r).not.toContain("subagent_type:");
    expect(r).not.toContain("model: opus");
  });

  test("instructs Codex users to spawn via Codex agent delegation", () => {
    const r = formatReminder(subagentProfile, "review", "codex");
    expect(r).toContain("autoReview.execution=subagent");
    expect(r).toContain("Codex's agent delegation tool");
    expect(r).not.toContain("Task / Agent tool");
    expect(r).not.toContain("subagent_type:");
    expect(r).not.toContain("model: opus");
  });

  test("includes the briefing template when sessionBriefing=true", () => {
    const r = formatReminder(subagentProfile, "review", "claude");
    expect(r).toContain("BRIEFING (background, not conclusions)");
    expect(r).toContain("{{purpose}}");
    expect(r).toContain("{{constraints}}");
    expect(r).toContain("{{decisions}}");
    expect(r).toContain("{{exclusions}}");
    expect(r).toContain("Before spawning the subagent, fill each {{slot}}");
    expect(r.indexOf("Before spawning the subagent")).toBeLessThan(
      r.indexOf("The subagent's prompt should include"),
    );
    expect(r).not.toContain("git diff <base>");
    // {{skill}} is substituted by the reminder builder before embedding,
    // so the rendered text should not contain the literal placeholder.
    expect(r).not.toContain("{{skill}}");
  });

  test("includes review target guidance instead of asking the subagent to guess the base", () => {
    const r = formatReminder(subagentProfile, "review", "codex");
    expect(r).toContain("REVIEW TARGET");
    expect(r).toContain("base branch, PR number, or compare range is unclear");
    expect(r).toContain("Do not guess `origin/main` on stacked PRs");
    expect(r).not.toContain("git diff <base>");
  });

  test("omits the briefing template when sessionBriefing=false", () => {
    const profile = { ...subagentProfile, sessionBriefing: false };
    const r = formatReminder(profile, "review", "claude");
    expect(r).not.toContain("BRIEFING");
    expect(r).not.toContain("{{purpose}}");
  });

  test("still tells the subagent to write findings + summary + run attest", () => {
    const r = formatReminder(subagentProfile, "review", "claude");
    expect(r).toContain(".review/findings-review.json");
    expect(r).toContain(".review/summary-review.md");
    expect(r).toContain("skilled-pr attest --skill review");
  });

  test("embeds the resolved summaryPrompt for the subagent to follow", () => {
    const profile = {
      ...subagentProfile,
      summaryPrompt: "MY_DISTINCT_SUMMARY_INSTRUCTION_42",
    };
    const r = formatReminder(profile, "review", "claude");
    expect(r).toContain("MY_DISTINCT_SUMMARY_INSTRUCTION_42");
  });

  test("tells the subagent to NOT push from inside the subagent on exit-code-2", () => {
    const r = formatReminder(subagentProfile, "review", "claude");
    expect(r).toContain("do NOT push from inside the subagent");
  });

  test("instructs the orchestrator to trust the subagent's findings file as the record", () => {
    const r = formatReminder(subagentProfile, "review", "claude");
    expect(r).toContain("trust the subagent's findings file as the record");
  });
});
