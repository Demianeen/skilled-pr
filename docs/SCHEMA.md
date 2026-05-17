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

Repo-relative file path of the line being commented on. Must be a file that exists in the diff GitHub knows about — otherwise GitHub rejects the inline comment.

Example: `"src/api/users.ts"` (not `"./src/api/users.ts"`, not absolute paths).

### `line` (required, integer ≥ 1)

The line number in the diff to attach the comment to. **1-based.** GitHub will reject lines that aren't part of the changed-lines set in the PR (i.e., lines outside the diff hunks).

If you want to comment on a line that's been deleted (vs. added), set `side: "LEFT"`. Default `"RIGHT"` means "the new version of the file."

### `severity` (required, enum)

One of `"error"`, `"warning"`, `"info"`.

The user's `.skilledpr.jsonc` has a `failOn` field that decides which severities block the PR:

- `failOn: "error"` (default) — `error` blocks, `warning` and `info` are advisory
- `failOn: "warning"` — `error` and `warning` block, `info` is advisory
- `failOn: "none"` — nothing blocks; the gate passes as long as the skill attests

**Severity guidance:**

| Severity | Use for |
|---|---|
| `error` 🔴 | Code that will produce wrong behaviour, security holes, race conditions, missing null checks that crash on edge cases. Real bugs. |
| `warning` 🟡 | Code-quality issues: bad naming, duplicated logic, magic numbers, complexity. Real but not blocking. |
| `info` 🔵 | Suggestions, style preferences, optional improvements. The reviewer is FYI'ing. |

### `title` (required, non-empty string)

Short one-line headline. Becomes the first line of the inline comment, bolded with the severity badge.

### `body` (required, non-empty string)

Full explanation. Markdown is rendered by GitHub. Code blocks work, inline code works, links work.

### `suggestion` (optional, string)

A proposed fix. If present, rendered under a `**Suggestion:**` block in the inline comment.

For "I want GitHub's suggestion-block UI" (the one with "Apply suggested change" button), include a fenced `suggestion` block inside the body — that's GitHub-native syntax, separate from this field:

````
\`\`\`suggestion
fixed code here
\`\`\`
````

### `side` (optional, "LEFT" or "RIGHT", default "RIGHT")

Which side of the diff the comment attaches to.

- `"RIGHT"` (default) — the added/modified line. Use this 99% of the time.
- `"LEFT"` — the deleted line. Use only when commenting on something that was removed.

## Validation

skilled-pr validates the file with zod before posting anything. If validation fails, the error message names the bad index and field, e.g.:

```
findings[0].path: String must contain at least 1 character(s)
findings[2].severity: Invalid enum value. Expected "error" | "warning" | "info", received "critical"
```

The CLI exits with non-zero status without posting anything.

## Dedupe

You don't need to do anything for dedupe — skilled-pr handles it. Each finding gets a fingerprint computed as:

```
SHA256(path + ":" + title + ":" + first_20_chars_of_body)
```

(truncated to 16 hex chars for readable HTML comment markers)

On re-run, attest fetches the PR's existing inline comments, extracts fingerprints from their `<!-- skilled-pr:fp:<hash> -->` markers, and skips findings whose fingerprint is already there.

This means:
- Re-running attest on the same SHA is idempotent
- Updating a finding's `body` past the first 20 characters won't trigger a re-post
- Changing the `title` or `path` WILL trigger a re-post (new fingerprint)

If you want to evolve a finding's wording without re-posting, append to the body (keep the first 20 chars stable).

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
