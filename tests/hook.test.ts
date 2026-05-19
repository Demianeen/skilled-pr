import { describe, expect, test } from "vitest";
import { Readable } from "node:stream";
import {
  extractSkillName,
  slugifySkill,
  buildReminder,
  buildHookOutput,
  readStdin,
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
  // buildReminder now requires a prompt - the config parser refuses to load
  // a config without one, so this function can rely on it being present.
  // Helper to avoid repeating a placeholder prompt in every test.
  const PROMPT = "Render markdown with a header and a list of findings.";

  test("includes the skill name verbatim", () => {
    expect(buildReminder("coderabbit:review", PROMPT)).toContain("`coderabbit:review`");
  });

  test("includes the derived findings + summary paths", () => {
    const r = buildReminder("coderabbit:review", PROMPT);
    expect(r).toContain(".review/findings-coderabbit-review.json");
    expect(r).toContain(".review/summary-coderabbit-review.md");
  });

  test("includes the attest command with all three flags", () => {
    const r = buildReminder("review", PROMPT);
    expect(r).toContain("skilled-pr attest --skill review");
    expect(r).toContain("--findings .review/findings-review.json");
    expect(r).toContain("--summary .review/summary-review.md");
  });

  test("includes the schema description (so the model knows the shape)", () => {
    const r = buildReminder("review", PROMPT);
    expect(r).toContain("severity");
    expect(r).toContain("error");
    expect(r).toContain("warning");
    expect(r).toContain("info");
    expect(r).toContain("path");
    expect(r).toContain("line");
  });

  test("tells the model what to do when there are no findings", () => {
    expect(buildReminder("review", PROMPT)).toContain("[]");
  });

  test("includes the exit-code-2 push-recovery instruction", () => {
    // The model needs to know how to recover when attest fails because
    // HEAD isn't on remote yet - see attest.ts pre-flight check.
    const r = buildReminder("review", PROMPT);
    expect(r).toContain("exits with code 2");
    expect(r).toContain("git push");
    expect(r).toMatch(/ask the user/i);
  });

  // -------------------------------------------------------------------------
  // summaryPrompt embedding
  // -------------------------------------------------------------------------

  test("renders a 4-step reminder (findings + summary + attest + recovery)", () => {
    const r = buildReminder("review", PROMPT);
    expect(r).toMatch(/four things in order/i);
    expect(r).toContain(".review/summary-review.md");
    expect(r).toContain("--summary .review/summary-review.md");
  });

  test("embeds the prompt verbatim in the reminder body", () => {
    const distinct = "FIND_THIS_EXACT_PHRASE_2718281828";
    const r = buildReminder("review", `Some preface. ${distinct} Some suffix.`);
    expect(r).toContain(distinct);
  });

  test("namespaced skill names get the correct slug for paths", () => {
    const r = buildReminder("coderabbit:review", PROMPT);
    expect(r).toContain(".review/findings-coderabbit-review.json");
    expect(r).toContain(".review/summary-coderabbit-review.md");
    // attest --skill keeps the original (un-slugified) skill name.
    expect(r).toContain("--skill coderabbit:review");
  });

  test("multi-line summaryPrompt is embedded with each line indented", () => {
    // Indentation matters because the prompt is nested under a numbered
    // step; without indenting, the second line would visually break out
    // of the list structure in the rendered reminder.
    const prompt = "line 1\nline 2\nline 3";
    const r = buildReminder("review", prompt);
    expect(r).toContain("   line 1");
    expect(r).toContain("   line 2");
    expect(r).toContain("   line 3");
  });
});

// ---------------------------------------------------------------------------
// buildHookOutput
// ---------------------------------------------------------------------------

describe("buildHookOutput", () => {
  // buildHookOutput now takes a required summaryPrompt (forwarded into
  // the reminder). Helper to avoid repeating it in every test.
  const PROMPT = "Render markdown with a header and a list of findings.";

  test("returns null when the event resolves to no skill", () => {
    expect(buildHookOutput({ hook_event_name: "Stop" }, ["review"], PROMPT)).toBeNull();
  });

  test("returns null when the skill isn't required", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "unrelated-skill" },
    };
    expect(buildHookOutput(event, ["review"], PROMPT)).toBeNull();
  });

  test("emits a JSON payload with hookSpecificOutput when the skill is required", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "review" },
    };
    const out = buildHookOutput(event, ["review"], PROMPT);
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
    const out = buildHookOutput(event, ["review"], PROMPT);
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
    const out = buildHookOutput(event, ["coderabbit:review"], PROMPT);
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
    expect(buildHookOutput(event, [], PROMPT)).toBeNull();
  });

  test("propagates summaryPrompt into the embedded reminder", () => {
    const event = {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "review" },
    };
    const distinct = "DISTINCT_PROMPT_PHRASE_3141592653";
    const out = buildHookOutput(event, ["review"], distinct);
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(distinct);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("--summary");
  });
});

// ---------------------------------------------------------------------------
// readStdin
//
// Migration helper: replaces Bun.stdin.text() with a Node-native event-based
// reader. Bounded on size + idle timeout so a misbehaving parent can't OOM
// or wedge the hook on the hot path (every PostToolUse:Skill and every
// UserPromptExpansion event fires this).
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
    // Force a split in the middle so we exercise the multi-chunk path.
    const mid = Math.floor(payload.length / 2);
    const stream = Readable.from([payload.slice(0, mid), payload.slice(mid)]);
    expect(await readStdin(stream)).toBe(payload);
  });

  test("handles multibyte UTF-8 across chunk boundaries", async () => {
    // 'é' is 0xC3 0xA9 in UTF-8. Split mid-codepoint to verify setEncoding
    // handles the decoder state across chunks. Node's string decoder buffers
    // partial codepoints internally; without setEncoding("utf8") we'd see U+FFFD.
    const buf = Buffer.from("café", "utf8"); // c(1) a(1) f(1) é(2) = 5 bytes
    const stream = Readable.from([buf.subarray(0, 4), buf.subarray(4)]);
    expect(await readStdin(stream)).toBe("café");
  });

  test("rejects when accumulated bytes exceed cap", async () => {
    // Generate a payload larger than the test's cap. 100 byte cap with a
    // 120-byte payload should trigger the size guard on the second chunk.
    const stream = Readable.from(["x".repeat(60), "x".repeat(60)]);
    await expect(readStdin(stream, 100, 5000)).rejects.toThrow(/exceeded max size 100 bytes/);
  });

  test("rejects when idle timeout expires (stream open, no data)", async () => {
    // PassThrough simulates a stream that's open but produces nothing.
    // The 50 ms timeout should fire quickly enough not to slow the suite.
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    // Do NOT call .end() - leaves stream open, simulating a misbehaving parent.
    await expect(readStdin(stream, 16 * 1024 * 1024, 50)).rejects.toThrow(
      /idle timeout after 50ms/,
    );
  });

  test("idle timer resets on each chunk (slow but progressing stream completes)", async () => {
    // Verify the timer is reset, not absolute. If timer were absolute, a
    // stream that takes longer than `idleTimeoutMs` overall but never
    // pauses more than `idleTimeoutMs` between chunks would falsely time out.
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    const promise = readStdin(stream, 16 * 1024 * 1024, 100);
    // Three chunks 60ms apart: total 180ms, none of the gaps > 100ms.
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
