import { describe, expect, test } from "bun:test";
import {
  computeFingerprint,
  parseFindings,
  formatCommentBody,
  extractFingerprint,
  findingsExceedingThreshold,
  countBySeverity,
  buildStatusDescription,
  type Finding,
} from "../src/findings";

// helper to build findings for threshold tests
const fp = (sev: Finding["severity"]): Finding => ({
  path: "a.ts",
  line: 1,
  severity: sev,
  title: "t",
  body: "b",
  fingerprint: `fp-${sev}`,
});

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

// ---------------------------------------------------------------------------
// findingsExceedingThreshold
// ---------------------------------------------------------------------------

describe("findingsExceedingThreshold", () => {
  test("failOn=error blocks only errors", () => {
    const findings = [fp("error"), fp("warning"), fp("info")];
    const blocks = findingsExceedingThreshold(findings, "error");
    expect(blocks.map((f) => f.severity)).toEqual(["error"]);
  });

  test("failOn=warning blocks errors + warnings", () => {
    const findings = [fp("error"), fp("warning"), fp("info")];
    const blocks = findingsExceedingThreshold(findings, "warning");
    expect(blocks.map((f) => f.severity)).toEqual(["error", "warning"]);
  });

  test("failOn=none blocks nothing", () => {
    const findings = [fp("error"), fp("warning"), fp("info")];
    expect(findingsExceedingThreshold(findings, "none")).toEqual([]);
  });

  test("empty findings always pass regardless of policy", () => {
    expect(findingsExceedingThreshold([], "error")).toEqual([]);
    expect(findingsExceedingThreshold([], "warning")).toEqual([]);
    expect(findingsExceedingThreshold([], "none")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countBySeverity
// ---------------------------------------------------------------------------

describe("countBySeverity", () => {
  test("tallies each severity", () => {
    const findings = [fp("error"), fp("error"), fp("warning"), fp("info")];
    expect(countBySeverity(findings)).toEqual({ error: 2, warning: 1, info: 1 });
  });

  test("zero counts for absent severities", () => {
    expect(countBySeverity([fp("info")])).toEqual({ error: 0, warning: 0, info: 1 });
    expect(countBySeverity([])).toEqual({ error: 0, warning: 0, info: 0 });
  });
});

// ---------------------------------------------------------------------------
// buildStatusDescription
// ---------------------------------------------------------------------------

describe("buildStatusDescription", () => {
  test("no --findings flag ⇒ legacy phrasing", () => {
    expect(buildStatusDescription("review", null)).toBe("Reviewed by review");
  });

  test("empty findings array ⇒ explicit 'no findings'", () => {
    expect(buildStatusDescription("review", [])).toBe("review — no findings");
  });

  test("single severity", () => {
    expect(buildStatusDescription("review", [fp("error")])).toBe("review — 1 error");
    expect(buildStatusDescription("review", [fp("warning")])).toBe("review — 1 warning");
  });

  test("multiple severities", () => {
    const findings = [fp("error"), fp("error"), fp("warning"), fp("info")];
    expect(buildStatusDescription("review", findings)).toBe(
      "review — 2 errors, 1 warning, 1 info",
    );
  });

  test("omits zero-count severities", () => {
    const findings = [fp("info"), fp("info")];
    expect(buildStatusDescription("review", findings)).toBe("review — 2 info");
  });

  test("stays under GitHub's 140-char status-description limit for 10x findings of each kind", () => {
    const findings = [
      ...Array.from({ length: 10 }, () => fp("error")),
      ...Array.from({ length: 10 }, () => fp("warning")),
      ...Array.from({ length: 10 }, () => fp("info")),
    ];
    expect(buildStatusDescription("a-skill-with-a-long-name:review", findings).length).toBeLessThanOrEqual(140);
  });
});
