# skilled-pr

> Open review transport for AI-native development.
> Plug an AI review skill into your PR gate without writing CI glue.

`skilled-pr` is a small CLI that turns Claude Code skills (`/review`, `/cso`,
`/security-review`, your own) into GitHub commit-status checks. It's
plug-and-play: invoke a required review skill, and Claude Code automatically
writes findings, posts them as inline PR comments, and updates the status
check that gates merge — no manual attestation step.

## How it works

Three moving pieces, no servers:

1. **`.skilledpr.jsonc`** — a per-repo config listing which skills must run
   before merge (e.g. `requiredSkills: ["review"]`).
2. **A Claude Code hook** — installed into `.claude/settings.json` by
   `skilled-pr init`. When Claude Code invokes a required skill, the hook
   injects a system reminder telling the model to: write findings to
   `.review/findings-<skill>.json`, then run `skilled-pr attest`.
3. **`skilled-pr attest`** — posts the findings as inline PR comments
   (deduped by fingerprint) and a `success`/`failure` commit status against
   `HEAD`. Severity threshold is configurable (`failOn: "error" | "warning" | "none"`).

The result: invoking `/review` in Claude Code is enough. The model handles
the rest because the hook tells it to.

## Install

Globally, so the hook can shell out to `skilled-pr` from anywhere:

```
bun add -g skilled-pr
```

Or, while developing this repo, link it into your global path:

```
bun link        # in this repo
bun link skilled-pr   # in any consumer repo
```

You also need [`gh`](https://cli.github.com) authenticated (`gh auth login`)
— `attest` shells out to it for both PR comments and commit statuses.

## Setup

In the repo you want to gate:

```
skilled-pr init
```

This:
- creates `.skilledpr.jsonc` with sensible defaults,
- merges `PostToolUse` and `UserPromptExpansion` hooks into
  `.claude/settings.json` (preserving any hooks you already had).

Then, on GitHub: **Settings → Branches → Branch protection rules**, add a rule
for `main`, check **Require status checks to pass**, and add **Skilled PR**.

## The flow, end-to-end

1. You open a PR.
2. In Claude Code, you (or the agent) run `/review` (or whichever skill you
   listed in `requiredSkills`).
3. The Skilled PR hook fires when the skill loads. It injects a system
   reminder telling the model to write findings + run
   `skilled-pr attest --skill review --findings .review/findings-review.json`.
4. The model performs the review, writes findings as a JSON array, and runs
   the attest command.
5. `attest` posts each finding as an inline PR comment (deduped across
   re-runs by a content fingerprint) and a commit status against `HEAD`.
6. If any finding's severity exceeds your `failOn` threshold, the status is
   `failure` — the PR is blocked. Otherwise `success` — the PR can merge.

If you push a new commit, the previous attestation does not carry over. The
status is per-SHA. Re-run the skill (or just `skilled-pr attest`) on the new
HEAD.

## Recovery: unpushed HEAD

GitHub rejects status posts for SHAs that aren't on the remote. So `attest`
pre-flight-checks `HEAD`, and if it isn't pushed, exits with code **2** and
prints push instructions. The system reminder tells the model to:

> If attest exits with code 2 ("HEAD is not pushed"), ask the user whether to
> push the branch. After they confirm, run `git push` and then re-run the
> attest command.

So the agentic recovery loop is built in — but pushing is gated on user
confirmation, because pushing modifies the remote.

## Findings format

Review skills write JSON arrays of findings to
`.review/findings-<skill-slug>.json`. Each finding:

```json
{
  "path": "src/foo.ts",
  "line": 42,
  "severity": "error",
  "title": "SQL injection via string concat",
  "body": "Full markdown explanation...",
  "suggestion": "Use parameterized queries.",
  "side": "RIGHT"
}
```

The exact schema (and the prose version embedded into the system reminder)
lives in [`src/findings.ts`](./src/findings.ts).

## Configuration

`.skilledpr.jsonc`:

```jsonc
{
  // Which review skills must run before merge
  "requiredSkills": ["review"],

  // The name shown on GitHub status checks
  "statusName": "Skilled PR",

  // When to fail the check based on finding severity:
  //   "error"   — fail if any finding has severity "error" (default)
  //   "warning" — fail on either "error" or "warning"
  //   "none"    — always succeed if the skill attested (advisory mode)
  "failOn": "error"
}
```

JSONC: comments and trailing commas are fine.

## Why a hook (not a CI job)?

The whole point is that the agent doing the review is the agent posting the
attestation. Putting the gate in CI puts it on the wrong side of the
boundary: CI can't tell that `/review` actually ran on this SHA — only that
*something* called the API. The hook closes that loop by binding the
attestation to the same Claude Code session that invoked the skill.

## Status

`skilled-pr` is pre-1.0 and used in anger inside Minimal. The CLI surface,
config schema, and findings schema may shift before 1.0; breaking changes
will be flagged in commits with `!` and called out in the release notes.

## License

MIT.
