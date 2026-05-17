import { describe, expect, test } from "vitest";
import {
  extractSkillName,
  slugifySkill,
  buildReminder,
  buildHookOutput,
} from "../src/hook";

// ---------------------------------------------------------------------------
// extractSkillName
// ---------------------------------------------------------------------------

describe("extractSkillName", () => {
  test("PostToolUse + tool_name=Skill → tool_input.skill", () => {
    expect(
      extractSkillName({
        hook_event_name: "PostToolUse",
        tool_name: "Skill",
        tool_input: { skill: "coderabbit:review" },
      }),
    ).toBe("coderabbit:review");
  });

  test("UserPromptExpansion → command_name", () => {
    expect(
      extractSkillName({
        hook_event_name: "UserPromptExpansion",
        command_name: "review",
      }),
    ).toBe("review");
  });

  test("PostToolUse on a non-Skill tool returns null", () => {
    expect(
      extractSkillName({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { skill: "review" } as any,
      }),
    ).toBeNull();
  });

  test("PostToolUse + Skill but missing tool_input returns null", () => {
    expect(
      extractSkillName({
        hook_event_name: "PostToolUse",
        tool_name: "Skill",
      }),
    ).toBeNull();
  });

  test("PostToolUse + Skill but empty skill string returns null", () => {
    expect(
      extractSkillName({
        hook_event_name: "PostToolUse",
        tool_name: "Skill",
        tool_input: { skill: "" },
      }),
    ).toBeNull();
  });

  test("UserPromptExpansion without command_name returns null", () => {
    expect(extractSkillName({ hook_event_name: "UserPromptExpansion" })).toBeNull();
  });

  test("unrelated events return null", () => {
    expect(extractSkillName({ hook_event_name: "Stop" })).toBeNull();
    expect(extractSkillName({ hook_event_name: "SessionStart" })).toBeNull();
    expect(extractSkillName({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// slugifySkill
// ---------------------------------------------------------------------------

describe("slugifySkill", () => {
  test("plain alphanumeric is lowercased", () => {
    expect(slugifySkill("Review")).toBe("review");
  });

  test("colon becomes a dash", () => {
    expect(slugifySkill("coderabbit:review")).toBe("coderabbit-review");
  });

  test("collapses runs of non-alnum", () => {
    expect(slugifySkill("foo___bar...baz")).toBe("foo-bar-baz");
  });

  test("strips leading and trailing dashes", () => {
    expect(slugifySkill(":review:")).toBe("review");
    expect(slugifySkill("---review---")).toBe("review");
  });

  test("handles spaces", () => {
    expect(slugifySkill("My Custom Review")).toBe("my-custom-review");
  });
});

// ---------------------------------------------------------------------------
// buildReminder
// ---------------------------------------------------------------------------

describe("buildReminder", () => {
  test("includes the skill name verbatim", () => {
    expect(buildReminder("coderabbit:review")).toContain("`coderabbit:review`");
  });

  test("includes the derived findings path", () => {
    expect(buildReminder("coderabbit:review")).toContain(
      ".review/findings-coderabbit-review.json",
    );
  });

  test("includes the attest command with both flags", () => {
    const r = buildReminder("review");
    expect(r).toContain("skilled-pr attest --skill review");
    expect(r).toContain("--findings .review/findings-review.json");
  });

  test("includes the schema description (so the model knows the shape)", () => {
    const r = buildReminder("review");
    expect(r).toContain("severity");
    expect(r).toContain("error");
    expect(r).toContain("warning");
    expect(r).toContain("info");
    expect(r).toContain("path");
    expect(r).toContain("line");
  });

  test("tells the model what to do when there are no findings", () => {
    expect(buildReminder("review")).toContain("[]");
  });

  test("includes the exit-code-2 push-recovery instruction", () => {
    // The model needs to know how to recover when attest fails because
    // HEAD isn't on remote yet — see attest.ts pre-flight check.
    const r = buildReminder("review");
    expect(r).toContain("exits with code 2");
    expect(r).toContain("git push");
    expect(r).toMatch(/ask the user/i);
  });
});

// ---------------------------------------------------------------------------
// buildHookOutput
// ---------------------------------------------------------------------------

describe("buildHookOutput", () => {
  test("returns null when the event resolves to no skill", () => {
    expect(buildHookOutput({ hook_event_name: "Stop" }, ["review"])).toBeNull();
  });

  test("returns null when the skill isn't required", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "unrelated-skill" },
    };
    expect(buildHookOutput(event, ["review"])).toBeNull();
  });

  test("emits a JSON payload with hookSpecificOutput when the skill is required", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "review" },
    };
    const out = buildHookOutput(event, ["review"]);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("review");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("skilled-pr attest");
  });

  test("UserPromptExpansion path emits with the right hookEventName", () => {
    const event = {
      hook_event_name: "UserPromptExpansion",
      command_name: "review",
    };
    const out = buildHookOutput(event, ["review"]);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptExpansion");
  });

  test("preserves the exact skill name (no slugging) in the reminder", () => {
    // The slug is for the filename. The reminder should still say
    // `coderabbit:review` so the model uses the right --skill argument.
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "coderabbit:review" },
    };
    const out = buildHookOutput(event, ["coderabbit:review"]);
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("--skill coderabbit:review");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "findings-coderabbit-review.json",
    );
  });

  test("empty requiredSkills array → never injects", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "review" },
    };
    expect(buildHookOutput(event, [])).toBeNull();
  });
});
