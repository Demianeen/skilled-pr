import { describe, expect, test } from "vitest";
import {
  parseFindings,
  findingsExceedingThreshold,
  countBySeverity,
  buildStatusDescription,
  formatArtifactComment,
  extractArtifactSkillName,
  artifactMarker,
  wrapWithArtifactMarker,
  type Finding,
} from "../src/findings";

// helper to build findings for threshold tests
const fp = (sev: Finding["severity"]): Finding => ({
  path: "a.ts",
  line: 1,
  severity: sev,
  title: "t",
  body: "b",
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

  // zod's .min(1) on path/title/body — boundary tests beyond the
  // pre-zod hand-rolled validators.
  test("rejects empty path", () => {
    const raw = JSON.stringify([{ path: "", line: 1, severity: "info", title: "t", body: "b" }]);
    expect(() => parseFindings(raw)).toThrow(/findings\[0\]\.path/);
  });

  test("rejects empty title", () => {
    const raw = JSON.stringify([{ path: "a", line: 1, severity: "info", title: "", body: "b" }]);
    expect(() => parseFindings(raw)).toThrow(/findings\[0\]\.title/);
  });

  test("rejects empty body", () => {
    const raw = JSON.stringify([{ path: "a", line: 1, severity: "info", title: "t", body: "" }]);
    expect(() => parseFindings(raw)).toThrow(/findings\[0\]\.body/);
  });

  test("array of primitives produces a path-prefixed error", () => {
    expect(() => parseFindings("[1, 2, 3]")).toThrow(/findings\[0\]/);
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
    expect(buildStatusDescription("review", [])).toBe("review: no findings");
  });

  test("single severity", () => {
    expect(buildStatusDescription("review", [fp("error")])).toBe("review: 1 error");
    expect(buildStatusDescription("review", [fp("warning")])).toBe("review: 1 warning");
  });

  test("multiple severities", () => {
    const findings = [fp("error"), fp("error"), fp("warning"), fp("info")];
    expect(buildStatusDescription("review", findings)).toBe(
      "review: 2 errors, 1 warning, 1 info",
    );
  });

  test("omits zero-count severities", () => {
    const findings = [fp("info"), fp("info")];
    expect(buildStatusDescription("review", findings)).toBe("review: 2 info");
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

// ---------------------------------------------------------------------------
// formatArtifactComment + extractArtifactSkillName
// ---------------------------------------------------------------------------

describe("formatArtifactComment", () => {
  const SHA = "aacd0dd1234567890abcdef0";

  test("zero findings → ✅ icon, 'No issues found' body", () => {
    const out = formatArtifactComment("review", SHA, [], "error");
    expect(out).toContain("✅");
    expect(out).toContain("Findings:** 0");
    expect(out).toContain("No issues found");
  });

  test("includes short SHA (7 chars) in the header, not the full one", () => {
    const out = formatArtifactComment("review", SHA, [], "error");
    expect(out).toContain("`aacd0dd`");
    expect(out).not.toContain("aacd0dd1234"); // full SHA shouldn't leak
  });

  test("includes the skill name verbatim", () => {
    const out = formatArtifactComment("coderabbit:review", SHA, [], "error");
    expect(out).toContain("`coderabbit:review`");
  });

  test("includes the artifact marker at end of body", () => {
    const out = formatArtifactComment("review", SHA, [], "error");
    expect(out).toMatch(/<!-- skilled-pr:artifact:review -->\s*$/);
  });

  test("findings within failOn threshold → ⚠️ icon, 'passing the gate' message", () => {
    const out = formatArtifactComment("review", SHA, [fp("info"), fp("info")], "error");
    expect(out).toContain("⚠️");
    expect(out).toContain("2 🔵 info");
    expect(out).toContain("none reach the");
    expect(out).toContain("passing");
    expect(out).not.toContain("blocked");
  });

  test("findings exceed failOn threshold → 🚫 icon, blocked message", () => {
    const out = formatArtifactComment("review", SHA, [fp("error"), fp("info")], "error");
    expect(out).toContain("🚫");
    expect(out).toContain("blocked");
    expect(out).toContain("failOn: error");
    expect(out).toContain("1 🔴 error");
    expect(out).toContain("1 🔵 info");
  });

  test("multiple blocking findings → pluralizes correctly", () => {
    const out = formatArtifactComment(
      "review",
      SHA,
      [fp("error"), fp("error"), fp("error")],
      "error",
    );
    expect(out).toContain("3 findings have severity");
  });

  test("single blocking finding → uses 'has' (singular)", () => {
    const out = formatArtifactComment("review", SHA, [fp("error")], "error");
    expect(out).toContain("1 finding has severity");
  });

  test("severity breakdown omits zero-count buckets", () => {
    const out = formatArtifactComment("review", SHA, [fp("info"), fp("info")], "error");
    expect(out).toContain("2 🔵 info");
    expect(out).not.toContain("🔴 error"); // shouldn't list 0-count error
    expect(out).not.toContain("🟡 warning"); // shouldn't list 0-count warning
  });

  test("failOn: warning escalates warnings to blocking", () => {
    const out = formatArtifactComment("review", SHA, [fp("warning")], "warning");
    expect(out).toContain("🚫");
    expect(out).toContain("blocked");
    expect(out).toContain("failOn: warning");
  });

  test("failOn: none never blocks", () => {
    const out = formatArtifactComment("review", SHA, [fp("error"), fp("error")], "none");
    expect(out).not.toContain("🚫");
    expect(out).not.toContain("blocked");
    // With failOn:none, the gate is passing even with errors
    expect(out).toContain("passing");
  });

  test("body has a Findings section when findings exist", () => {
    // Inline PR comments were dropped; the artifact comment is now the
    // sole PR-visible review surface, so finding details must live here.
    const out = formatArtifactComment("review", SHA, [fp("info")], "error");
    expect(out).toContain("### Findings");
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>");
  });

  test("body does NOT have a Findings section when zero findings", () => {
    const out = formatArtifactComment("review", SHA, [], "error");
    expect(out).not.toContain("### Findings");
    expect(out).not.toContain("<details>");
  });

  test("renders each finding as a collapsible <details> block with path:line + title", () => {
    const findings: Finding[] = [
      { path: "src/a.ts", line: 10, severity: "warning", title: "First", body: "B1" },
      { path: "src/b.ts", line: 20, severity: "error", title: "Second", body: "B2" },
    ];
    const out = formatArtifactComment("review", SHA, findings, "error");
    // Both findings rendered.
    expect(out).toContain("src/a.ts:10");
    expect(out).toContain("First");
    expect(out).toContain("B1");
    expect(out).toContain("src/b.ts:20");
    expect(out).toContain("Second");
    expect(out).toContain("B2");
    // Errors sorted before warnings.
    expect(out.indexOf("Second")).toBeLessThan(out.indexOf("First"));
  });

  test("includes the suggestion when a finding has one", () => {
    const findings: Finding[] = [
      {
        path: "src/a.ts",
        line: 1,
        severity: "warning",
        title: "t",
        body: "b",
        suggestion: "do X instead",
      },
    ];
    const out = formatArtifactComment("review", SHA, findings, "error");
    expect(out).toContain("**Suggestion:**");
    expect(out).toContain("do X instead");
  });

  test("escapes literal '<' in finding titles so the summary tag doesn't break", () => {
    // GitHub renders the summary as raw HTML; an un-escaped `<` would open
    // a tag and corrupt the rest of the summary text.
    const findings: Finding[] = [
      { path: "a.ts", line: 1, severity: "info", title: "fix <script> in body", body: "b" },
    ];
    const out = formatArtifactComment("review", SHA, findings, "error");
    expect(out).toContain("fix &lt;script>");
    expect(out).not.toContain("fix <script>");
  });
});

describe("extractArtifactSkillName", () => {
  test("extracts skill name from a valid artifact marker", () => {
    expect(extractArtifactSkillName("body\n<!-- skilled-pr:artifact:review -->")).toBe("review");
  });

  test("preserves plugin-namespaced skill names with colons", () => {
    expect(extractArtifactSkillName("<!-- skilled-pr:artifact:coderabbit:review -->")).toBe(
      "coderabbit:review",
    );
  });

  test("returns null for a comment without any marker", () => {
    expect(extractArtifactSkillName("just a normal comment")).toBeNull();
  });

  test("returns null for a fingerprint marker (different prefix, no collision)", () => {
    expect(extractArtifactSkillName("<!-- skilled-pr:fp:abc123def456 -->")).toBeNull();
  });

  test("returns null for malformed marker", () => {
    expect(extractArtifactSkillName("<!-- skilled-pr:other:foo -->")).toBeNull();
  });

  test("round-trips through formatArtifactComment", () => {
    const body = formatArtifactComment("plugin:my-skill", "abc1234", [], "error");
    expect(extractArtifactSkillName(body)).toBe("plugin:my-skill");
  });
});

// ---------------------------------------------------------------------------
// artifactMarker + wrapWithArtifactMarker
// ---------------------------------------------------------------------------

describe("artifactMarker", () => {
  test("renders the HTML marker for a skill", () => {
    expect(artifactMarker("review")).toBe("<!-- skilled-pr:artifact:review -->");
  });

  test("preserves plugin-namespaced skill names", () => {
    expect(artifactMarker("coderabbit:review")).toBe(
      "<!-- skilled-pr:artifact:coderabbit:review -->",
    );
  });
});

describe("wrapWithArtifactMarker", () => {
  test("appends the marker when missing", () => {
    const wrapped = wrapWithArtifactMarker("Body text.", "review");
    expect(wrapped).toContain("Body text.");
    expect(wrapped).toContain("<!-- skilled-pr:artifact:review -->");
    // Round-trips through extractArtifactSkillName so future attest runs find it.
    expect(extractArtifactSkillName(wrapped)).toBe("review");
  });

  test("is idempotent: does not append a second marker when already present", () => {
    const original = "Body text.\n\n<!-- skilled-pr:artifact:review -->";
    expect(wrapWithArtifactMarker(original, "review")).toBe(original);
  });

  test("normalises trailing whitespace so the marker sits one blank line below content", () => {
    // Skills may emit summaries with arbitrary trailing newlines. The marker
    // should land in a predictable place regardless of input shape.
    const wrapped = wrapWithArtifactMarker("Body.\n\n\n\n", "review");
    expect(wrapped).toBe("Body.\n\n<!-- skilled-pr:artifact:review -->\n");
  });

  test("works with plugin-namespaced skills", () => {
    const wrapped = wrapWithArtifactMarker("X", "coderabbit:review");
    expect(extractArtifactSkillName(wrapped)).toBe("coderabbit:review");
  });
});
