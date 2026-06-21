# Findings schema

This is the reference for the JSON file that review skills produce and that `skilled-pr attest --findings <path>` consumes.

The shape is defined by a zod schema in [`src/findings.ts`](../src/findings.ts) (`FindingsInputSchema`). This page describes the same shape in prose so skill authors don't have to read TypeScript.

## Top level

A JSON array of finding objects. Empty array means "the skill ran and found nothing":

```json
[]
```

The file path is `.review/findings-<skill-slug>.json`. The slug is derived from the skill name: colons and other non-alphanumerics become dashes, lowercase. So `coderabbit:review` → `findings-coderabbit-review.json`.

## A single finding

```jsonc
{
  "path": "src/api/users.ts",      // required
  "line": 42,                       // required
  "severity": "error",              // required: "error" | "warning" | "info"
  "title": "SQL injection risk",    // required, short headline
  "body": "...",                    // required, full explanation (markdown)
  "suggestion": "Use a parameterized query: ...",  // optional, the proposed fix
  "side": "RIGHT"                   // optional, "LEFT" | "RIGHT", default "RIGHT"
}
```

## Fields

### `path` (required, string)

Repo-relative file path the finding applies to. Used in the artifact comment's per-finding summary (`<summary>🟡 src/api/users.ts:42 - title</summary>`) so reviewers can scan and jump.

Example: `"src/api/users.ts"` (not `"./src/api/users.ts"`, not absolute paths).

### `line` (required, integer ≥ 1)

1-based line number the finding applies to. Rendered alongside `path` in the artifact comment's per-finding summary. Status-check severity counts derive from the array regardless of line; the line itself is only display.

Earlier versions of skilled-pr posted one inline PR comment per finding and required `line` to fall inside the diff hunks (GitHub rejected anything else with HTTP 422). That constraint is gone; the field is now just metadata.

### `severity` (required, enum)

One of `"error"`, `"warning"`, `"info"`.

The user's `.skilledpr/config.jsonc` has a `failOn` field that decides which severities block the PR:

- `failOn: "error"` (default) - `error` blocks, `warning` and `info` are advisory
- `failOn: "warning"` - `error` and `warning` block, `info` is advisory
- `failOn: "none"` - nothing blocks; the gate passes as long as the skill attests

**Severity guidance:**

| Severity | Use for |
|---|---|
| `error` 🔴 | Code that will produce wrong behaviour, security holes, race conditions, missing null checks that crash on edge cases. Real bugs. |
| `warning` 🟡 | Code-quality issues: bad naming, duplicated logic, magic numbers, complexity. Real but not blocking. |
| `info` 🔵 | Suggestions, style preferences, optional improvements. The reviewer is FYI'ing. |

### `title` (required, non-empty string)

Short one-line headline. Becomes the `<summary>` text for the finding's collapsible `<details>` block in the artifact comment. Keep it scannable; the body has the room for prose.

### `body` (required, non-empty string)

Full explanation. Lives inside the `<details>` block so it's hidden until the reviewer clicks. Markdown is rendered by GitHub; code blocks, inline code, and links all work.

### `suggestion` (optional, string)

A proposed fix. If present, rendered under a `**Suggestion:**` heading inside the `<details>` block.

GitHub's native "Apply suggested change" UI only fires on inline review comments and isn't available from a regular issue comment, so the fenced `suggestion` block trick won't auto-apply here. Treat this as plain markdown content.

### `side` (optional, "LEFT" or "RIGHT", default "RIGHT")

Reserved. Previously used to disambiguate added vs deleted lines when each finding posted as an inline review comment. Currently no rendering difference; kept in the schema so existing skills don't need to remove the field. Likely revived if/when a per-line addressing mode comes back.

## Validation

skilled-pr validates the file with zod before posting anything. If validation fails, the error message names the bad index and field, e.g.:

```
findings[0].path: String must contain at least 1 character(s)
findings[2].severity: Invalid enum value. Expected "error" | "warning" | "info", received "critical"
```

The CLI exits with non-zero status without posting anything.

## How the artifact comment is built

`skilled-pr attest --skill <name> --findings <findings.json> --summary <summary.md>` posts (or PATCHes in place) one comment per skill on the PR. The comment body comes from the `--summary` file verbatim, with an HTML marker `<!-- skilled-pr:artifact:<skill> -->` auto-appended so future attest runs can find and update the same comment.

**skilled-pr does not render the body itself.** The skill renders the summary, following the `summaryPrompt` from `.skilledpr/config.jsonc`. This is by design: a typo-check skill should emit a `file:line: 'teh' -> 'the'` table, a French-translation skill should show side-by-side phrase diffs, a security-review skill should embed CVE references. One hardcoded template can't serve all of them; the skill already knows its domain.

The `findings.json` array stays the same shape regardless of summary format - it's the input to the status check (`failOn` gating uses severity counts from this array). Findings are the machine-readable record; the summary is the human-readable record.

### Default `summaryPrompt`

`init` writes a default prompt that asks for a header + severity breakdown + per-finding `<details>` blocks. Sensible starting point; tune per project. The default lives in `DEFAULT_SUMMARY_PROMPT` in `src/config.ts` (also rendered into the generated `.skilledpr/config.jsonc` for direct user editing).

Example output a skill might produce following the default prompt:

```
## ⚠️ `review` reviewed `abc1234`

**Findings:** 3 (1 🔴 error · 2 🟡 warning)

The PR is blocked because `failOn: error` is set and 1 finding has severity at or above that threshold.

<details>
<summary>🔴 <code>src/auth.ts:42</code> SQL injection in login query</summary>

The login handler concatenates the email field into the WHERE clause...

**Suggestion:**
Use parameterized queries: `db.query('SELECT ... WHERE email = $1', [email])`.

</details>

<details>
<summary>🟡 <code>src/api.ts:88</code> Missing input validation</summary>
...
</details>

<!-- skilled-pr:artifact:review -->
```

But the skill is free to ignore that shape and render anything else the prompt asks for - a markdown table, side-by-side diffs, scoped bullet lists, whatever fits the review's nature.

## Missing-artifact behavior

There's no built-in fallback. If the skill skips the summary, `attest` fails loudly:

- `findings.json` missing -> attest exits 1 with a "findings file not found" error.
- `summary.md` missing -> attest exits 1 with a hint pointing at the hook reminder being stale or the config missing `summaryPrompt`.
- `summary.md` empty -> attest exits 1; an empty artifact comment is almost always a skill bug.

This is intentional. With one code path and no fallback, "did the review run" reduces to "did attest succeed". Easier to debug, easier to trust.

## Idempotency

Re-running `attest` on the same SHA is idempotent: the artifact comment is found by marker and PATCHed in place. The status check is replaced. There are no duplicate comments per re-run.

## Minimal example

```json
[
  {
    "path": "src/auth.ts",
    "line": 47,
    "severity": "error",
    "title": "Token check returns undefined when session expires",
    "body": "If the session cookie has expired, `validateToken()` returns `undefined` (not `false`). Callers that use `if (validateToken(req))` will still treat the user as authenticated. The bug shows up on Friday afternoons when long-lived sessions hit their 7-day expiry mid-request.",
    "suggestion": "Return `false` explicitly when the token is missing or expired: `if (!token || isExpired(token)) return false;`"
  }
]
```

## Full example with all fields

```json
[
  {
    "path": "src/api/users.ts",
    "line": 42,
    "side": "RIGHT",
    "severity": "error",
    "title": "SQL injection via string interpolation",
    "body": "Line 42 builds a SQL query by string-concatenating `req.params.id`. If a user sends `/users/1';DROP TABLE users;--`, the query becomes `SELECT * FROM users WHERE id = '1';DROP TABLE users;--'`.",
    "suggestion": "Use a parameterized query: `db.query('SELECT * FROM users WHERE id = ?', [req.params.id])`"
  },
  {
    "path": "src/api/users.ts",
    "line": 88,
    "severity": "warning",
    "title": "Function is 200 lines long",
    "body": "The `processUser` function does too much in one place. Consider splitting validation, persistence, and notification into three functions."
  },
  {
    "path": "tests/api/users.test.ts",
    "line": 5,
    "severity": "info",
    "title": "Test file uses both `function` and `=>`",
    "body": "Mixed style. Other test files in this repo use arrow functions consistently."
  }
]
```

## Schema source of truth

For programmatic access, the zod schema is exported from `src/findings.ts`:

```typescript
import { FindingInputSchema, FindingsInputSchema } from "skilled-pr/findings";

const result = FindingsInputSchema.safeParse(myFindings);
if (!result.success) {
  console.error(result.error);
}
```

If you change the schema, update this file in the same diff. The `findingsSchemaForPrompt()` helper in `src/findings.ts` is the version embedded in the system reminder injected by the hook — same fields, slightly different formatting.
