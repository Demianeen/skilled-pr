# skilled-pr

> **AI code review that actually blocks the merge.** Plug a Claude Code review skill into your GitHub PR gate without writing any CI glue.

```bash
npm i -g skilled-pr                # install (or `pnpm add -g skilled-pr`)
cd your-repo
skilled-pr init                    # writes .skilledpr.jsonc + Claude Code hooks
skilled-pr enable-gate             # adds the status check to branch protection
# Open a PR, invoke /review in Claude Code, watch the gate light up green.
```

<!-- TODO: replace with a real demo gif before launch -->
<!-- ![skilled-pr in action](./docs/demo.gif) -->

## Why this exists

Existing AI review tools (CodeRabbit, PR-Agent) run on a server somewhere, see your diff cold, and post comments after the fact. AI coding harnesses (Claude Code, Cursor) review brilliantly but have no way to enforce that the review actually ran.

skilled-pr is the bridge: when you invoke a review skill in Claude Code, a hook makes sure findings flow to GitHub and the PR gate updates. The reviewer is the same agent that wrote the code, so it has full session context — it knows WHY each change was made, not just what changed.

No servers. No API keys. No new AI costs (uses the Claude Code subscription you already pay for). Open source.

## How it works (60 seconds)

```
You invoke /review in Claude Code
        │
        ▼
PostToolUse hook fires → injects system reminder:
"after this review, write findings.json + summary.md
 and run skilled-pr attest"
        │
        ▼
Model performs the review, writes .review/findings-review.json
and .review/summary-review.md (rendered per your summaryPrompt),
runs `skilled-pr attest --skill review --findings ... --summary ...`
        │
        ▼
attest posts: one per-skill summary comment + status check
        │
        ▼
Branch protection requires the status check → PR is gated
```

Three moving pieces, no servers:

1. **`.skilledpr.jsonc`** — per-repo config: required skills, fail threshold, and the **summary prompt** that tells each skill how to render its PR comment. `init` writes a sensible default; you tune it per project.
2. **A Claude Code hook** — installed by `skilled-pr init`. Reads stdin, injects an attestation reminder when a required skill is invoked. The reminder embeds the summary prompt verbatim.
3. **`skilled-pr attest`** — takes the skill-rendered summary, posts it as one per-skill PR comment (PATCH-updated in place on re-runs via an artifact marker), and posts a `success`/`failure` commit status. No inline-per-line noise; no template engine.

The hook is the key insight: when the agent doing the review is also the agent posting the attestation, you can't fake the review having happened.

## Self-healing recovery

If `attest` fails because `HEAD` isn't on the remote (the most common error), it exits with code **2** and prints the exact retry command. The system reminder teaches the model how to recover:

> If attest exits with code 2, ask the user whether to push, then re-run the attest command above.

The model asks you, you say yes, it pushes, attest re-runs, status posts. No human intervention required to debug a cryptic "Not Found (HTTP 404)."

## Install

```bash
npm i -g skilled-pr        # or `pnpm add -g skilled-pr`
```

Requires [Node.js 22+](https://nodejs.org/) (the current LTS — older versions are out of support) and [`gh`](https://cli.github.com) authenticated with `repo` scope. If you hit shell PATH issues after install (especially on fish), see [TROUBLESHOOTING](./docs/TROUBLESHOOTING.md).

## Setup

In the repo you want to gate:

```bash
skilled-pr init           # writes .skilledpr.jsonc + .claude/settings.json hooks
skilled-pr enable-gate    # adds the Skilled PR status check to branch protection
skilled-pr doctor         # verifies everything is wired up correctly
```

That's the entire setup. Three commands. No CI workflow files to write, no secrets to manage.

## Configuration

`.skilledpr.jsonc` (JSONC — comments and trailing commas allowed):

```jsonc
{
  // Which review skills must run before merge.
  // See docs/COMPATIBLE_SKILLS.md for the list of skills that work today.
  "requiredSkills": ["review"],

  // Name shown on the GitHub status check (e.g. "Skilled PR / review").
  "statusName": "Skilled PR",

  // When to block the PR based on finding severity:
  //   "error"   - block if any finding has severity "error" (default)
  //   "warning" - block on either "error" or "warning"
  //   "none"    - always succeed if the skill attested (advisory mode)
  "failOn": "error",

  // REQUIRED. Embedded in the hook reminder; tells the skill how to render
  // `.review/summary-<skill>.md`. The file becomes the PR's artifact
  // comment verbatim. `init` writes a sensible default; tune per project.
  //
  // Useful when different skills want different summary formats - a
  // typo-check skill emitting a 'file:line: typo -> fix' table, vs a
  // security-review skill embedding CVE references and threat scenarios.
  // The calling skill already knows its domain; one hardcoded template
  // can't serve all of them.
  "summaryPrompt": "Render a markdown summary of the review for posting as a GitHub PR comment. ..."
}
```

## Compatible skills

skilled-pr is infrastructure, not a reviewer. The actual review work is done by skills you already have. Currently known to work:

| Skill | What it does |
|---|---|
| `coderabbit:review` | CodeRabbit's cloud-backed AI review |
| `gstack:review` | gstack's multi-specialist review (testing, security, perf, maintainability) |
| `gstack:cso` | Chief Security Officer mode — OWASP/STRIDE, security-only |
| `vercel-plugin:react-best-practices` | React-specific quality checks |

Full list and selection guide: [docs/COMPATIBLE_SKILLS.md](./docs/COMPATIBLE_SKILLS.md).

Want to write your own? It's ~25 lines of markdown — see [docs/SKILL_AUTHORING.md](./docs/SKILL_AUTHORING.md).

## What you see on a PR

For each required skill, two things post:

1. **A summary comment** at the PR conversation level — one per skill. The skill renders the body itself, following your `summaryPrompt` from `.skilledpr.jsonc`. A typo-check skill's summary looks nothing like a security-review skill's; one transport, many shapes. Updated in place on each re-attestation.
2. **A status check** (`Skilled PR / <skill>`) — `success` if findings don't exceed `failOn`, `failure` if they do. This is what branch protection enforces.

Re-running `attest` on the same SHA is idempotent: the summary comment is PATCH-updated in place via an HTML marker (`<!-- skilled-pr:artifact:<skill> -->`); the status check is replaced.

> Note on inline comments: earlier versions of skilled-pr posted one inline PR comment per finding. We dropped that path in favour of the consolidated per-skill summary. The reviewer is already sitting in Claude Code with full session context; the file:line speech-bubble UX duplicated information they had. On PRs requiring multiple review skills, inline comments easily ran past 30 per PR, making the conversation tab unreadable. One artifact comment per skill is now the sole PR-visible surface; the per-finding format is whatever the skill chooses to render.

## Documentation

- [docs/SCHEMA.md](./docs/SCHEMA.md) — findings.json reference
- [docs/SKILL_AUTHORING.md](./docs/SKILL_AUTHORING.md) — writing a custom review skill
- [docs/COMPATIBLE_SKILLS.md](./docs/COMPATIBLE_SKILLS.md) — skills that work today
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) — common errors and fixes
- [CHANGELOG.md](./CHANGELOG.md) — version history
- [CLAUDE.md](./CLAUDE.md) — project conventions (for contributors)

## CLI reference

```
skilled-pr init                    Set up Skilled PR in this repo
skilled-pr enable-gate             Add status checks to branch protection
skilled-pr doctor                  Diagnose your local setup
skilled-pr attest --skill <name>   Post attestation that a skill ran
                  [--findings <path>]
skilled-pr hook                    Internal: Claude Code hook entry point
```

Most users only ever run `init` and `enable-gate` directly. `attest` is invoked by the model automatically; `hook` is invoked by Claude Code itself.

## Status

Pre-1.0. Used daily inside [Minimal](https://minimal.tech). The CLI surface and findings schema may shift before 1.0; breaking changes will land with `!` in commit messages and release notes.

If you try it and something's broken, run `skilled-pr doctor` and open an [issue](https://github.com/Demianeen/skilled-pr/issues) with its output.

## License

MIT.
