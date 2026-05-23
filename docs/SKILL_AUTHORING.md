# Writing a custom review skill

skilled-pr works with any Claude Code skill that follows this contract. If the skills listed in [COMPATIBLE_SKILLS.md](./COMPATIBLE_SKILLS.md) don't fit, write your own.

This is the entire contract:

1. The skill is a Claude Code skill — a directory with a `SKILL.md` (and optionally helpers).
2. When invoked, the skill's instructions tell the model to: review the diff, write findings to `.review/findings-<slug>.json`, and run `skilled-pr attest --skill <name> --findings <path>`.
3. The findings file follows the schema in [SCHEMA.md](./SCHEMA.md).

That's it. No SDK, no API, no required dependencies. Just instructions in markdown.

## What happens in practice

When the user adds your skill to `requiredSkills` in `.skilledpr.jsonc` and invokes it:

1. Claude Code loads your `SKILL.md` into context.
2. skilled-pr's PostToolUse hook fires, injects a system reminder telling the model: "after this review, write findings to `.review/findings-<slug>.json` AND write a markdown summary to `.review/summary-<slug>.md` following this project's `summaryPrompt` (embedded verbatim in the reminder), then run `skilled-pr attest --skill ... --findings ... --summary ...`."
3. Your skill instructs the model on HOW to review (the actual review behaviour - what to look for, how to organize output).
4. The model performs the review per your instructions, writes findings.json AND summary.md, runs attest.
5. attest validates the findings against the schema, PATCH-updates the per-skill artifact summary comment on the PR with the rendered summary verbatim, and posts the status check that gates the merge.

Note: the `summaryPrompt` is per-project (in the user's `.skilledpr.jsonc`), not per-skill. Your skill produces structured findings; the project decides what the user-facing summary looks like. This means one skill can ship one canonical review behavior and projects can dress it up differently.

You don't need to know any of this when authoring. Just describe what your skill should review — skilled-pr handles the GitHub integration.

## Minimum viable SKILL.md

```markdown
---
name: my-review
description: Reviews the diff for buffer-overflow risks in C code.
---

# my-review

You are a security-focused reviewer specializing in buffer-overflow bugs in C code.

## Process

1. Run `git diff origin/main` to get the full diff.
2. For each changed C file:
   - Look for `strcpy`, `strcat`, `gets`, `sprintf` (without explicit bounds)
   - Look for `memcpy` / `memmove` where the size isn't bounded by the dest buffer
   - Flag any place where user input flows into a fixed-size stack buffer

3. For every issue you find, build a finding object per the skilled-pr schema
   (see https://github.com/Demianeen/skilled-pr/blob/main/docs/SCHEMA.md):

   - severity: "error" for exploitable overflows, "warning" for unbounded ops
     that aren't directly user-controlled, "info" for suggestions
   - path: repo-relative path to the file
   - line: the line number of the offending call
   - title: one-line summary (e.g., "strcpy with unbounded source")
   - body: explanation of the risk + how it can be exploited

4. Write the findings array to `.review/findings-my-review.json`. Empty array
   if you found nothing.

5. Run: `skilled-pr attest --skill my-review --findings .review/findings-my-review.json`

Skilled PR's hook will not inject its system reminder for you here — your skill
is what tells the model what to do. The hook only fires for the user's required
skills, and assumes your skill knows how to behave.
```

That's a complete, working review skill. Drop it in `.claude/skills/my-review/SKILL.md` and add `"my-review"` to `requiredSkills` in `.skilledpr.jsonc`.

## What the hook does and doesn't do for you

The PostToolUse hook (installed by `skilled-pr init`) ONLY fires when a skill listed in `requiredSkills` is invoked. When it fires, it injects this system reminder into the model's next turn:

> "After completing your review, write your findings to `.review/findings-<slug>.json` and run `skilled-pr attest --skill <name> --findings <path>`."

This is a reminder, not a replacement for your skill's instructions. The model still needs to know HOW to review — that's your skill's job. The hook just guarantees the findings get attested at the end.

**Your skill doesn't need to mention attest at all** if you're listed in `requiredSkills`. The hook handles that part. Your skill is just "how to review."

If you want your skill to work independently of skilled-pr (e.g., as a standalone Claude Code skill that doesn't gate PRs), include the attest instruction yourself.

## Conventions worth following

These aren't required, but skills that follow them feel "professional":

- **Confidence-gate your findings.** Don't post low-confidence guesses as `error`. Use `info` for "pattern looks suspicious but might be fine," `warning` for "high confidence quality issue," `error` for "verified bug."
- **Cite file:line, not just file.** The artifact comment's per-finding `<summary>` shows `path:line` - putting it in the title field too just duplicates it. Use the body for "why" and concrete context.
- **Suggestions over scolding.** Include a `suggestion` field when you can name a concrete fix. "X is wrong, do Y" beats "X is wrong."
- **Domain prefix the title.** A skill called `security-review` putting "SQL injection" in the title is fine. A general skill putting "[security] SQL injection" makes its category visible at a glance.

## Severity guidance

The user's `failOn` config decides what blocks merge. Be conservative with `error`:

| Severity | Bar |
|---|---|
| `error` 🔴 | "If this ships, real users will be affected." Bugs, security holes, data loss. |
| `warning` 🟡 | "This works but is a maintenance burden." Code quality, duplication, complexity. |
| `info` 🔵 | "Optional improvement, take it or leave it." Style, suggestions, alternatives. |

Resist the temptation to mark everything `error`. Skills that flag too aggressively get the gate disabled, which means YOUR skill stops running. The high bar protects the gate's authority.

## Examples in the wild

Look at the skills listed in [COMPATIBLE_SKILLS.md](./COMPATIBLE_SKILLS.md) for real-world examples. The gstack `/review` skill in particular shows a sophisticated multi-specialist pattern (dispatching subagents in parallel per concern, then merging findings).

For a minimal example, the skeleton above is a working skill — copy it, adjust the review logic, and you're shipping.

## Testing your skill

Before relying on it as a PR gate:

skilled-pr doesn't have a `--dry-run` flag yet, and `attest` always talks
to GitHub (it needs a pushed SHA to post against). To validate your
findings JSON before running for real, eyeball it against:

- [`docs/SCHEMA.md`](./SCHEMA.md) - the human-readable schema reference
- `src/findings.ts` in the source repo - the actual Zod schema

A useful end-to-end test is a throwaway PR in a sandbox repo: open it,
invoke your skill, and watch the artifact summary comment + status check
populate. If the JSON is malformed, `attest` exits non-zero with a clear
parse error pointing at the bad field.

> Want a programmatic `parseFindings` import? Open an issue - we can
> expose `skilled-pr/findings` as a separate subpath export.

If parseFindings throws, fix your output before invoking your skill on a real PR.

## Getting your skill listed

If you build something useful, open a PR to [COMPATIBLE_SKILLS.md](./COMPATIBLE_SKILLS.md). Criteria:

- Skill emits valid findings.json conformant to the schema
- Skill runs `skilled-pr attest` at the end (or relies on the hook to remind the model)
- Skill is publicly distributable (open source or installable Claude Code skill package)
- Author is willing to maintain it (respond to issues, update for schema changes)

Quality bar isn't strict — we want the ecosystem to grow.
