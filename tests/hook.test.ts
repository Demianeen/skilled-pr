import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  hook,
  extractSkillName,
  extractLeadingSlashCommand,
  harnessForEvent,
  slugifySkill,
  buildHookOutput,
  readStdin,
} from "../src/hook";
import { type SkilledPRConfig } from "../src/config";
import type { PRContext } from "../src/resolve";

// Helpers ------------------------------------------------------------------

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
      execution: "subagent",
      parallel: true,
      sessionBriefing: true,
      skipPolicy: "agent-decides",
      askBeforeFiring: false,
    },
    rules: [],
    ...overrides,
  };
}

const CTX: PRContext = { branch: "feat/x" };

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

  test("Codex UserPromptSubmit with leading /command resolves the skill name", () => {
    expect(
      extractSkillName({
        hook_event_name: "UserPromptSubmit",
        prompt: "/review please look at this PR",
      }),
    ).toBe("review");
  });

  test("Codex UserPromptSubmit accepts colon-scoped commands", () => {
    expect(
      extractSkillName({
        hook_event_name: "UserPromptSubmit",
        prompt: "/coderabbit:review",
      }),
    ).toBe("coderabbit:review");
  });

  test("Codex UserPromptSubmit falls back to user_message when prompt is missing", () => {
    expect(
      extractSkillName({
        hook_event_name: "UserPromptSubmit",
        user_message: "/review",
      }),
    ).toBe("review");
  });

  test("Codex UserPromptSubmit without a leading slash returns null", () => {
    expect(
      extractSkillName({
        hook_event_name: "UserPromptSubmit",
        prompt: "please review this code",
      }),
    ).toBeNull();
  });

  test("Codex UserPromptSubmit with empty prompt returns null", () => {
    expect(
      extractSkillName({ hook_event_name: "UserPromptSubmit", prompt: "" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractLeadingSlashCommand (Codex prompt parsing)
// ---------------------------------------------------------------------------

describe("extractLeadingSlashCommand", () => {
  test("matches a plain /skill at the start", () => {
    expect(extractLeadingSlashCommand("/review")).toBe("review");
  });

  test("matches /scope:skill", () => {
    expect(extractLeadingSlashCommand("/coderabbit:review")).toBe("coderabbit:review");
  });

  test("matches /skill-with-dashes", () => {
    expect(extractLeadingSlashCommand("/my-custom-skill check this")).toBe("my-custom-skill");
  });

  test("strips leading whitespace before matching", () => {
    expect(extractLeadingSlashCommand("   /review")).toBe("review");
  });

  test("ignores a slash mid-sentence (and/or, http://)", () => {
    expect(extractLeadingSlashCommand("and/or this is fine")).toBeNull();
    expect(extractLeadingSlashCommand("see http://example.com")).toBeNull();
  });

  test("filters out builtin commands", () => {
    expect(extractLeadingSlashCommand("/help")).toBeNull();
    expect(extractLeadingSlashCommand("/clear")).toBeNull();
    expect(extractLeadingSlashCommand("/exit")).toBeNull();
    expect(extractLeadingSlashCommand("/compact")).toBeNull();
  });

  test("returns null on empty input", () => {
    expect(extractLeadingSlashCommand("")).toBeNull();
    expect(extractLeadingSlashCommand("   ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// harnessForEvent
// ---------------------------------------------------------------------------

describe("harnessForEvent", () => {
  test("PostToolUse maps to claude", () => {
    expect(harnessForEvent("PostToolUse")).toBe("claude");
  });

  test("UserPromptExpansion maps to claude", () => {
    expect(harnessForEvent("UserPromptExpansion")).toBe("claude");
  });

  test("UserPromptSubmit maps to codex", () => {
    expect(harnessForEvent("UserPromptSubmit")).toBe("codex");
  });

  test("anything else maps to null (caller bails)", () => {
    expect(harnessForEvent("Stop")).toBeNull();
    expect(harnessForEvent("SessionStart")).toBeNull();
    expect(harnessForEvent(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// slugifySkill (re-exported from resolve.ts; here only because hook.test
// historically held the tests for it)
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
// buildHookOutput (now delegates body construction to formatReminder)
// ---------------------------------------------------------------------------

describe("buildHookOutput", () => {
  test("returns null when the event resolves to no skill", () => {
    expect(buildHookOutput({ hook_event_name: "Stop" }, baseConfig(), CTX)).toBeNull();
  });

  test("returns null when the skill isn't required", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "unrelated-skill" },
    };
    expect(buildHookOutput(event, baseConfig({ requiredSkills: ["review"] }), CTX)).toBeNull();
  });

  test("emits a JSON payload with hookSpecificOutput when the skill is required", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "review" },
    };
    const out = buildHookOutput(event, baseConfig({ requiredSkills: ["review"] }), CTX);
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
    const out = buildHookOutput(event, baseConfig({ requiredSkills: ["review"] }), CTX);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptExpansion");
  });

  test("preserves the exact skill name (no slugging) in the reminder", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "coderabbit:review" },
    };
    const out = buildHookOutput(
      event,
      baseConfig({ requiredSkills: ["coderabbit:review"] }),
      CTX,
    );
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
    expect(buildHookOutput(event, baseConfig({ requiredSkills: [] }), CTX)).toBeNull();
  });

  test("propagates summaryPrompt into the embedded reminder", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "review" },
    };
    const distinct = "DISTINCT_PROMPT_PHRASE_3141592653";
    const cfg = baseConfig({ summaryPrompt: distinct });
    const out = buildHookOutput(event, cfg, CTX);
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(distinct);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("--summary");
  });

  test("Codex UserPromptSubmit path emits with the right hookEventName", () => {
    const event = {
      hook_event_name: "UserPromptSubmit",
      prompt: "/review please",
    };
    const out = buildHookOutput(event, baseConfig({ requiredSkills: ["review"] }), CTX);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("skilled-pr attest");
  });

  test("Codex UserPromptSubmit with non-required skill returns null", () => {
    const event = {
      hook_event_name: "UserPromptSubmit",
      prompt: "/unrelated-skill",
    };
    expect(buildHookOutput(event, baseConfig({ requiredSkills: ["review"] }), CTX)).toBeNull();
  });

  test("Codex /help is filtered even if 'help' is in requiredSkills", () => {
    // Defense in depth: the builtin filter in extractLeadingSlashCommand
    // runs BEFORE the requiredSkills membership check, so a
    // misconfigured config that lists "help" can't make `/help` trigger
    // the gate.
    const event = {
      hook_event_name: "UserPromptSubmit",
      prompt: "/help",
    };
    expect(buildHookOutput(event, baseConfig({ requiredSkills: ["help"] }), CTX)).toBeNull();
  });

  test("matched rule's requiredSkills replaces top-level for membership check", () => {
    // The release branch rule says "no required skills here", so even
    // though `review` is required at top-level, a PostToolUse:Skill
    // event for `review` on a release-* branch should produce no output.
    const cfg = baseConfig({
      requiredSkills: ["review"],
      rules: [
        { name: "release", match: [{ branch: "release-*" }], requiredSkills: [] },
      ],
    });
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "review" },
    };
    expect(buildHookOutput(event, cfg, { branch: "release-1.0" })).toBeNull();
    // Sanity: on a non-release branch the rule doesn't apply.
    expect(buildHookOutput(event, cfg, { branch: "main" })).not.toBeNull();
  });

  test("matched rule's summaryPrompt is embedded in the reminder body", () => {
    const cfg = baseConfig({
      requiredSkills: ["review"],
      summaryPrompt: "top-level prompt",
      rules: [
        {
          match: [{ branch: "release-*" }],
          summaryPrompt: "RULE_PROMPT_MARKER_99",
        },
      ],
    });
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "review" },
    };
    const out = buildHookOutput(event, cfg, { branch: "release-2.0" });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("RULE_PROMPT_MARKER_99");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("top-level prompt");
  });
});

// ---------------------------------------------------------------------------
// hook() PostToolUse:Bash path
// ---------------------------------------------------------------------------

describe("hook() PostToolUse:Bash path", () => {
  let tmp: string;
  let prevCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-hook-bash-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
    mkdirSync(".skilledpr");
    writeFileSync(
      ".skilledpr/config.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        requiredSkills: ["review"],
        autoReview: { trigger: "on-push" },
      }),
    );
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("emits hookSpecificOutput for git push", async () => {
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push origin feature" },
    });

    await hook(Readable.from([payload]));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("autoReview.trigger=on-push");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("/review");
  });

  test("does not emit output for unrelated Bash commands", async () => {
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });

    await hook(Readable.from([payload]));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("fails open when Bash hook config loading errors", async () => {
    writeFileSync(".skilledpr/config.jsonc", "{ broken\n");
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });

    await hook(Readable.from([payload]));

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("Invalid .skilledpr/config.jsonc");
  });
});

// ---------------------------------------------------------------------------
// readStdin
// ---------------------------------------------------------------------------

describe("readStdin", () => {
  test("empty stream returns empty string", async () => {
    const stream = Readable.from([]);
    expect(await readStdin(stream)).toBe("");
  });

  test("single chunk", async () => {
    const stream = Readable.from(["hello"]);
    expect(await readStdin(stream)).toBe("hello");
  });

  test("multiple chunks concatenated in order", async () => {
    const stream = Readable.from(["hello ", "world", "!"]);
    expect(await readStdin(stream)).toBe("hello world!");
  });

  test("real-world hook payload (JSON split across chunks)", async () => {
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "review" },
    });
    const mid = Math.floor(payload.length / 2);
    const stream = Readable.from([payload.slice(0, mid), payload.slice(mid)]);
    expect(await readStdin(stream)).toBe(payload);
  });

  test("handles multibyte UTF-8 across chunk boundaries", async () => {
    const buf = Buffer.from("café", "utf8");
    const stream = Readable.from([buf.subarray(0, 4), buf.subarray(4)]);
    expect(await readStdin(stream)).toBe("café");
  });

  test("rejects when accumulated bytes exceed cap", async () => {
    const stream = Readable.from(["x".repeat(60), "x".repeat(60)]);
    await expect(readStdin(stream, 100, 5000)).rejects.toThrow(/exceeded max size 100 bytes/);
  });

  test("rejects when idle timeout expires (stream open, no data)", async () => {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    await expect(readStdin(stream, 16 * 1024 * 1024, 50)).rejects.toThrow(
      /idle timeout after 50ms/,
    );
  });

  test("idle timer resets on each chunk (slow but progressing stream completes)", async () => {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    const promise = readStdin(stream, 16 * 1024 * 1024, 100);
    setTimeout(() => stream.write("a"), 50);
    setTimeout(() => stream.write("b"), 110);
    setTimeout(() => stream.write("c"), 170);
    setTimeout(() => stream.end(), 220);
    await expect(promise).resolves.toBe("abc");
  });

  test("propagates stream errors", async () => {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    const promise = readStdin(stream, 16 * 1024 * 1024, 5000);
    setTimeout(() => stream.destroy(new Error("simulated read error")), 10);
    await expect(promise).rejects.toThrow(/simulated read error/);
  });
});
