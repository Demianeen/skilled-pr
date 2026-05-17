import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeSkilledPRHooks, writeFileWithMkdir, type ClaudeSettings } from "../src/init";

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

  test("does not share the PostToolUse array reference with the input", () => {
    // Defense against a future refactor where we accidentally mutate
    // entries in-place: the output's array should be a fresh object.
    const existing: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "log-bash" }] },
        ],
      },
    };
    const out = mergeSkilledPRHooks(existing);
    expect(out.hooks!.PostToolUse).not.toBe(existing.hooks!.PostToolUse);
  });
});

// ---------------------------------------------------------------------------
// writeFileWithMkdir
//
// Critical migration helper: replaces Bun.write's auto-mkdir behaviour for
// `.claude/settings.json` (the .claude/ dir doesn't exist in a fresh repo).
// Also atomic via tmp + rename so a Ctrl-C mid-write doesn't corrupt the
// user's settings.json on subsequent runs.
// ---------------------------------------------------------------------------

describe("writeFileWithMkdir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-init-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("writes when parent directory exists", () => {
    const target = join(tmp, "file.txt");
    writeFileWithMkdir(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  test("creates missing parent directory (single level)", () => {
    // Replicates the fresh-repo `.claude/settings.json` case.
    const target = join(tmp, ".claude", "settings.json");
    writeFileWithMkdir(target, "{}");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  test("creates deeply nested directories recursively", () => {
    const target = join(tmp, "a", "b", "c", "deep.txt");
    writeFileWithMkdir(target, "x");
    expect(readFileSync(target, "utf8")).toBe("x");
  });

  test("overwrites an existing file", () => {
    const target = join(tmp, "f.txt");
    writeFileWithMkdir(target, "first");
    writeFileWithMkdir(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  test("does not leave a .tmp file behind on success (atomic rename completed)", () => {
    // Atomic write pattern: write to <path>.tmp, then rename. After a
    // successful call only the final path exists, no stray .tmp.
    const target = join(tmp, "settings.json");
    writeFileWithMkdir(target, "{}");
    const entries = readdirSync(tmp);
    expect(entries).toContain("settings.json");
    expect(entries.find((e) => e.endsWith(".tmp"))).toBeUndefined();
  });

  test("dirname === '.' (bare filename) does not call mkdir", () => {
    // dirname returns "." for paths with no directory component. The
    // helper must skip the mkdir for this case, otherwise it would
    // try to mkdir(".", recursive:true) which is a no-op but signals
    // brittle assumptions about the input shape.
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      writeFileWithMkdir("bare.txt", "hello");
      expect(readFileSync(join(tmp, "bare.txt"), "utf8")).toBe("hello");
    } finally {
      process.chdir(cwd);
    }
  });

  test("preserves a pre-existing file at the destination directory (mkdir is idempotent)", () => {
    const sibling = join(tmp, "subdir", "sibling.txt");
    writeFileWithMkdir(sibling, "first");
    // Second write to a different file in the same dir should not blow away
    // the first one. Catches a bug where mkdirSync(..., {recursive:false})
    // would throw on existing dirs.
    const second = join(tmp, "subdir", "second.txt");
    writeFileWithMkdir(second, "another");
    expect(readFileSync(sibling, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("another");
  });

  test("rejects a literal .tmp shadow file left by a prior crash (renameSync overwrites cleanly)", () => {
    // If a prior crashed run left behind <path>.tmp, the next successful
    // write should overwrite it during the atomic-rename step. renameSync
    // is replace-by-default on POSIX and Windows, so the shadow file
    // shouldn't survive.
    const target = join(tmp, "settings.json");
    writeFileSync(target + ".tmp", "stale partial write");
    writeFileWithMkdir(target, "fresh content");
    expect(readFileSync(target, "utf8")).toBe("fresh content");
    expect(existsSync(target + ".tmp")).toBe(false);
  });
});
