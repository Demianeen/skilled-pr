import { describe, expect, test } from "bun:test";
import {
  computeFingerprint,
  parseFindings,
  formatCommentBody,
  extractFingerprint,
  type Finding,
} from "../src/findings";

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

describe("computeFingerprint", () => {
  test("is deterministic for the same input", () => {
    const fp1 = computeFingerprint({ path: "a.ts", title: "t", body: "b" });
    const fp2 = computeFingerprint({ path: "a.ts", title: "t", body: "b" });
    expect(fp1).toBe(fp2);
  });

  test("changes when path changes", () => {
    const a = computeFingerprint({ path: "a.ts", title: "t", body: "b" });
    const b = computeFingerprint({ path: "b.ts", title: "t", body: "b" });
    expect(a).not.toBe(b);
  });

  test("changes when title changes", () => {
    const a = computeFingerprint({ path: "a.ts", title: "t1", body: "b" });
    const b = computeFingerprint({ path: "a.ts", title: "t2", body: "b" });
    expect(a).not.toBe(b);
  });

  test("ignores body characters beyond the first 20", () => {
    // Per plan: only the first 20 chars of body are part of the fingerprint.
    const a = computeFingerprint({ path: "a.ts", title: "t", body: "0123456789abcdefghij_DIFF1" });
    const b = computeFingerprint({ path: "a.ts", title: "t", body: "0123456789abcdefghij_DIFF2" });
    expect(a).toBe(b);
  });

  test("produces a 16-char hex string", () => {
    const fp = computeFingerprint({ path: "a.ts", title: "t", body: "b" });
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// parseFindings
// ---------------------------------------------------------------------------

describe("parseFindings", () => {
  test("parses a minimal valid finding", () => {
    const raw = JSON.stringify([
      { path: "src/a.ts", line: 10, severity: "warning", title: "Issue", body: "Details" },
    ]);
    const result = parseFindings(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/a.ts");
    expect(result[0].line).toBe(10);
    expect(result[0].fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(result[0].side).toBeUndefined();
    expect(result[0].suggestion).toBeUndefined();
  });

  test("parses all optional fields", () => {
    const raw = JSON.stringify([
      {
        path: "src/a.ts",
        line: 10,
        side: "LEFT",
        severity: "error",
        title: "t",
        body: "b",
        suggestion: "fix it",
      },
    ]);
    const result = parseFindings(raw);
    expect(result[0].side).toBe("LEFT");
    expect(result[0].suggestion).toBe("fix it");
  });

  test("accepts an empty array", () => {
    expect(parseFindings("[]")).toEqual([]);
  });

  test("rejects non-array top-level", () => {
    expect(() => parseFindings('{"path": "a"}')).toThrow(/must be a JSON array/);
  });

  test("rejects missing path", () => {
    const raw = JSON.stringify([{ line: 1, severity: "info", title: "t", body: "b" }]);
    expect(() => parseFindings(raw)).toThrow(/findings\[0\]\.path/);
  });

  test("rejects non-integer line", () => {
    const raw = JSON.stringify([
      { path: "a", line: 1.5, severity: "info", title: "t", body: "b" },
    ]);
    expect(() => parseFindings(raw)).toThrow(/findings\[0\]\.line/);
  });

  test("rejects line < 1", () => {
    const raw = JSON.stringify([
      { path: "a", line: 0, severity: "info", title: "t", body: "b" },
    ]);
    expect(() => parseFindings(raw)).toThrow(/findings\[0\]\.line/);
  });

  test("rejects unknown severity", () => {
    const raw = JSON.stringify([
      { path: "a", line: 1, severity: "critical", title: "t", body: "b" },
    ]);
    expect(() => parseFindings(raw)).toThrow(/severity/);
  });

  test("rejects invalid side", () => {
    const raw = JSON.stringify([
      { path: "a", line: 1, side: "MIDDLE", severity: "info", title: "t", body: "b" },
    ]);
    expect(() => parseFindings(raw)).toThrow(/side/);
  });

  test("reports the bad index in multi-finding input", () => {
    const raw = JSON.stringify([
      { path: "a", line: 1, severity: "info", title: "t", body: "b" },
      { path: "a", line: 1, severity: "info", title: "t" /* body missing */ },
    ]);
    expect(() => parseFindings(raw)).toThrow(/findings\[1\]\.body/);
  });
});

// ---------------------------------------------------------------------------
// formatCommentBody + extractFingerprint
// ---------------------------------------------------------------------------

describe("formatCommentBody", () => {
  const finding: Finding = {
    path: "src/a.ts",
    line: 10,
    severity: "warning",
    title: "Unused import",
    body: "The `foo` import is never used.",
    fingerprint: "abc123def456",
  };

  test("includes the title and body", () => {
    const out = formatCommentBody(finding, "review");
    expect(out).toContain("Unused import");
    expect(out).toContain("The `foo` import is never used.");
  });

  test("includes a fingerprint marker that round-trips", () => {
    const out = formatCommentBody(finding, "review");
    expect(out).toContain("<!-- skilled-pr:fp:abc123def456 -->");
    expect(extractFingerprint(out)).toBe("abc123def456");
  });

  test("includes the skill name attribution", () => {
    const out = formatCommentBody(finding, "coderabbit:review");
    expect(out).toContain("skill: `coderabbit:review`");
  });

  test("includes a suggestion block when provided", () => {
    const withSuggestion = { ...finding, suggestion: "Remove line 10" };
    const out = formatCommentBody(withSuggestion, "review");
    expect(out).toContain("**Suggestion:**");
    expect(out).toContain("Remove line 10");
  });

  test("omits the suggestion block when absent", () => {
    const out = formatCommentBody(finding, "review");
    expect(out).not.toContain("Suggestion");
  });

  test("renders different severity badges", () => {
    const out = (sev: Finding["severity"]) =>
      formatCommentBody({ ...finding, severity: sev }, "review");
    expect(out("error")).toContain("error");
    expect(out("warning")).toContain("warning");
    expect(out("info")).toContain("info");
  });
});

describe("extractFingerprint", () => {
  test("returns null when no marker present", () => {
    expect(extractFingerprint("just a plain comment")).toBeNull();
  });

  test("ignores malformed markers", () => {
    expect(extractFingerprint("<!-- skilled-pr:other:abc -->")).toBeNull();
  });
});
