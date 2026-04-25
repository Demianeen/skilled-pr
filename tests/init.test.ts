import { describe, expect, test } from "bun:test";
import { mergeSkilledPRHooks, type ClaudeSettings } from "../src/init";

const SKILLED_PR_CMD = "skilled-pr hook";

// Helper: count entries whose hooks include `skilled-pr hook`.
function countSkilledPREntries(s: ClaudeSettings, event: string): number {
  return (s.hooks?.[event] ?? []).filter((e) =>
    e.hooks.some((h) => h.command === SKILLED_PR_CMD),
  ).length;
}

describe("mergeSkilledPRHooks", () => {
  test("from null settings, adds both PostToolUse and UserPromptExpansion entries", () => {
    const out = mergeSkilledPRHooks(null);
    expect(out.hooks?.PostToolUse?.length).toBe(1);
    expect(out.hooks?.UserPromptExpansion?.length).toBe(1);
    expect(out.hooks?.PostToolUse?.[0].matcher).toBe("Skill");
    expect(out.hooks?.UserPromptExpansion?.[0].matcher).toBe("");
  });

  test("the skilled-pr entry uses command `skilled-pr hook` of type `command`", () => {
    const out = mergeSkilledPRHooks(null);
    const entry = out.hooks?.PostToolUse?.[0];
    expect(entry?.hooks[0].type).toBe("command");
    expect(entry?.hooks[0].command).toBe(SKILLED_PR_CMD);
  });

  test("preserves existing settings keys outside of hooks", () => {
    const existing: ClaudeSettings = {
      hooks: {},
      env: { FOO: "bar" } as unknown as ClaudeSettings["env"],
      permissions: { allow: ["Bash(npm:*)"] } as unknown as ClaudeSettings["permissions"],
    };
    const out = mergeSkilledPRHooks(existing);
    expect((out as any).env).toEqual({ FOO: "bar" });
    expect((out as any).permissions).toEqual({ allow: ["Bash(npm:*)"] });
  });

  test("preserves existing hooks for events we don't touch", () => {
    const existing: ClaudeSettings = {
      hooks: {
        Notification: [
          { matcher: "", hooks: [{ type: "command", command: "say hello" }] },
        ],
      },
    };
    const out = mergeSkilledPRHooks(existing);
    expect(out.hooks?.Notification?.length).toBe(1);
    expect(out.hooks?.Notification?.[0].hooks[0].command).toBe("say hello");
  });

  test("appends to existing PostToolUse hooks (does not replace)", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "prettier --write" }],
          },
        ],
      },
    };
    const out = mergeSkilledPRHooks(existing);
    expect(out.hooks?.PostToolUse?.length).toBe(2);
    // user's prettier hook still there
    expect(
      out.hooks?.PostToolUse?.some((e) =>
        e.hooks.some((h) => h.command === "prettier --write"),
      ),
    ).toBe(true);
    // skilled-pr's hook also there
    expect(countSkilledPREntries(out, "PostToolUse")).toBe(1);
  });

  test("idempotent: re-running does not duplicate skilled-pr entries", () => {
    const once = mergeSkilledPRHooks(null);
    const twice = mergeSkilledPRHooks(once);
    expect(countSkilledPREntries(twice, "PostToolUse")).toBe(1);
    expect(countSkilledPREntries(twice, "UserPromptExpansion")).toBe(1);
  });

  test("idempotent across events: prior PostToolUse entry doesn't suppress UserPromptExpansion add", () => {
    // Edge case: settings already has the PostToolUse skilled-pr hook but
    // not the UserPromptExpansion one (e.g., partial install). The merge
    // should add the missing one without touching the existing.
    const partial: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          { matcher: "Skill", hooks: [{ type: "command", command: SKILLED_PR_CMD }] },
        ],
      },
    };
    const out = mergeSkilledPRHooks(partial);
    expect(countSkilledPREntries(out, "PostToolUse")).toBe(1);
    expect(countSkilledPREntries(out, "UserPromptExpansion")).toBe(1);
  });

  test("does not mutate the input settings object", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "log-bash" }] },
        ],
      },
    };
    const before = JSON.stringify(existing);
    mergeSkilledPRHooks(existing);
    expect(JSON.stringify(existing)).toBe(before);
  });
});
