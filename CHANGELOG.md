# Changelog

All notable changes to `skilled-pr` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ⚠ BREAKING CHANGES

- **Config moved to `.skilledpr/config.jsonc` (v1 schema).** The
  per-repo config now lives at `.skilledpr/config.jsonc` instead of
  `.skilledpr.jsonc` at the repo root, and carries a required
  `"schemaVersion": 1` sentinel. Loading the legacy root file
  hard-errors with a migration hint. PR #2 will ship an automated
  migrator; until then, run `skilled-pr init` to regenerate.

### Added

- **`schemaVersion` + JSON Schema.** The v1 config ships a JSON
  Schema (`.skilledpr/schema.json`, copied from the CLI's bundled
  `schema/v1.json`) so editors with `$schema`-aware JSON support
  (VSCode, IntelliJ, nvim) get autocompletion and field validation
  out of the box.

- **`skilled-pr migrate --plan` / `--apply`.** Walks a user from any
  stale state (older config, drifted bundled `schema.json`) to what
  the installed CLI expects. Each step is atomic + idempotent so a
  partial run leaves the project recoverable. Foundation for future
  schema bumps.

- **`/skilled-pr-update` skill installed by `init`.** Bundled skill
  template at `templates/skilled-pr-update.skill.md`; init copies it
  into each detected harness's skills directory (`.claude/skills/...`
  for Claude Code, `.codex/skills/...` for Codex). The skill walks
  the full upgrade flow: detect package manager, run the install
  upgrade, `migrate --plan/--apply`, then `doctor` to verify.

- **`skilled-pr ci-resolve` for CI-side rule evaluation.** New
  subcommand that resolves the active profile for a PR and (with
  `--post`) writes a bypass `success` or pending+CTA status to
  GitHub. Designed to run inside a workflow; tested locally via
  `--pr <num> [--json]`.

- **Bundled bypass workflow.** `skilled-pr enable-gate` now also
  writes `.github/workflows/skilled-pr-bypass.yml` (version-pinned
  to the CLI that wrote it). The workflow fires on pull_request
  events and runs `ci-resolve --post`. PRs that match a rule with
  `requiredSkills: []` auto-succeed via CI; PRs that need a review
  get a pending status with a CTA description until `attest` runs.
  No AI runs in CI — only the rule resolver. The migrator detects
  pin drift after a CLI upgrade and offers `--apply` to refresh.

- **`autoReview.trigger=on-push` (Claude Code).** When set, the agent
  running `git push` via the Bash tool triggers a reminder to invoke
  the required review skill(s). Detection handles `cd <path> && git
  push` chdir prefixes; rejects `--dry-run`. The reminder adapts to
  `autoReview.skipPolicy`:
    - `agent-decides` (default): tells the agent to choose between
      net-new work (review) and fix-up (skip with a loud
      `⏭️  Skilled PR auto-review: skipped` block to the user).
    - `always-fire`: unconditionally invoke required skills.
  `init` installs the PostToolUse:Bash hook conditionally when
  `autoReview.trigger=on-push` is set in config. Codex is skipped (no
  PostToolUse:Bash equivalent); Codex users continue with manual
  invocation.

- **`autoReview.execution=subagent`.** Default execution mode in v1.
  When the agent loads a required review skill, the reminder no
  longer tells it to do the review inline — instead it instructs the
  orchestrator to spawn an `Agent()` (Task tool) call per required
  skill. The subagent does the review work and runs `attest` itself.
  This decouples review correctness from orchestrator bias and lets
  multiple skills run in parallel cleanly.

- **`autoReview.sessionBriefing` slot template.** With
  `sessionBriefing=true` (default), the subagent's prompt includes
  a briefing template asking the orchestrator to fill `{{purpose}}`,
  `{{constraints}}`, `{{decisions}}`, `{{exclusions}}` slots from
  conversation context. Empty slots use `"(none stated)"`. Set to
  `false` to spawn cold-context subagents (review from diff only).
- **Per-context `rules`.** Each rule's `match` array OR's together;
  keys within a single block (`branch` glob, `author` exact match,
  `labels` subset) AND together. Optional override fields
  (`requiredSkills`, `failOn`, `summaryPrompt`) fall back to top-level
  defaults when absent. First matching rule wins. Enables patterns
  like "stricter review on release branches", "dependabot bypass",
  "security-labeled PRs require additional skills".
- **`skilled-pr show`.** Inspects the active config + resolved profile
  for the current (or a hypothetical) PR context. With a positional
  field name (`show summaryPrompt`), prints type/default/source/value
  for that field plus the description from the JSON schema. With
  `--reminder`, prints the literal reminder body the hook would
  inject.
- **`briefingPrompt`.** Slot-fill template used by the upcoming
  auto-review feature (PR #4) to relay session context to a reviewing
  subagent. Defaults to a built-in template; override to customise.
- **`autoReview` config block.** Optional settings consumed by PR #4
  (trigger, execution mode, parallelism, skip policy, askBeforeFiring).
  Parses cleanly in v1 even though enforcement lands later.
- **`pnpm bench` / `pnpm bench:check`.** Hook hot-path benchmarks
  plus a p95-under-10ms perf budget test. Inline path measures at
  ~0.005ms mean vs ~222ms for a hypothetical CLI-subprocess design
  (~49,000x faster), which is why skilled-pr's hook is in-process.
- **`init --install-mode {local|global|skip}`.** Controls whether
  init installs skilled-pr itself (and which package manager to use,
  detected by lockfile). Interactive prompt when stdin is a TTY;
  non-interactive defaults: local if `package.json` is present, else
  global.

### Changed

- **Doctor checks v1 fields.** New classifiers: `classifySchemaVersion`,
  `classifyBundledSchema`, `classifyRulePatterns`,
  `classifyReferencedSkills`. The config check now also detects the
  legacy root file and surfaces a migration error.
- **Reminder builder extracted to `src/resolve.ts`.** `formatReminder`
  and `resolveProfile` are now pure library code consumed by the hook,
  `show`, attest (for rule-aware failOn), and the perf bench fixture.

## [0.4.0](https://github.com/Demianeen/skilled-pr/compare/v0.3.0...v0.4.0) (2026-05-23)


### Features

* strict CLI arg parsing (reject unknown flags, support --flag=value) ([#12](https://github.com/Demianeen/skilled-pr/issues/12)) ([d47df0e](https://github.com/Demianeen/skilled-pr/commit/d47df0e4019438208f6fc0deb0fb8bcbda968f53))

## [0.3.0](https://github.com/Demianeen/skilled-pr/compare/v0.2.0...v0.3.0) (2026-05-19)


### ⚠ BREAKING CHANGES

* skilled-pr now requires Node.js 22+ instead of Bun. Users who installed via `bun add -g skilled-pr` and don't have Node on PATH will get "command not found" after upgrading. Reinstall via `npm i -g skilled-pr` (or `pnpm add -g skilled-pr`) on a system with Node 22+. Runtime behaviour and CLI surface are unchanged.

### Build System

* migrate from Bun to Node + pnpm + vitest + tsup ([#5](https://github.com/Demianeen/skilled-pr/issues/5)) ([0b84e61](https://github.com/Demianeen/skilled-pr/commit/0b84e614980e5b3e959a39535b13d82ff9583583))

## [0.2.0](https://github.com/Demianeen/skilled-pr/compare/v0.1.0...v0.2.0) (2026-05-17)


### ⚠ BREAKING CHANGES

* the `sha: "head" | "pushed"` field is removed.

### Features

* add skilled-pr attest and init commands ([#1](https://github.com/Demianeen/skilled-pr/issues/1)) ([4102eca](https://github.com/Demianeen/skilled-pr/commit/4102ecafe4cfb15dfecd5eed37da23d4e8952f90))
* plug-and-play attestation via Claude Code hooks ([#2](https://github.com/Demianeen/skilled-pr/issues/2)) ([c8d6c4c](https://github.com/Demianeen/skilled-pr/commit/c8d6c4c606699a193c77f136f2c62efcb209c564))
* release CI, doctor, enable-gate, artifact summaries, docs ([#3](https://github.com/Demianeen/skilled-pr/issues/3)) ([9119cee](https://github.com/Demianeen/skilled-pr/commit/9119cee75f504ab82897a26ff1048737890d3b62))

## [Unreleased]

### Added

- **Plug-and-play attestation via Claude Code hooks.** `skilled-pr init` now
  merges a `PostToolUse:Skill` and `UserPromptExpansion` hook into
  `.claude/settings.json`. When a required review skill is invoked, the hook
  injects a system reminder telling Claude to write findings and run
  `skilled-pr attest` — no manual step.
- **Inline PR comments via `--findings`.** `skilled-pr attest --findings <path>`
  reads a JSON array of findings (`{ path, line, severity, title, body, ... }`),
  posts each as an inline PR review comment, and dedupes against existing
  comments by content fingerprint (SHA-256 of path/title/body prefix).
- **Severity-gated status state.** `failOn` config (`"error" | "warning" | "none"`)
  controls whether findings flip the commit-status check from `success` to
  `failure`. Status description includes severity counts.
- **`skilled-pr hook` subcommand.** Internal entry point for the Claude Code
  hook contract. Reads a hook event on stdin, decides whether the invoked
  skill is required, emits `additionalContext` if so. Always exits 0 — a
  broken hook is a silent no-op, never a stalled session.
- **Agentic recovery for unpushed HEAD.** `attest` pre-flight-checks that
  `HEAD` is on the remote and exits with code **2** (distinct from generic
  exit 1) when it isn't. The injected system reminder tells the model to ask
  the user before pushing, then re-run the attest command.

### Changed

- **Single-source-of-truth findings schema.** `findingsSchemaForPrompt()` is
  derived from the same zod schema that validates findings input, so prompt
  drift is structurally prevented.

### Removed

- **`config.sha` field (BREAKING).** The `sha` field in `.skilledpr.jsonc`
  used to control whether unpushed-HEAD attestation skipped silently or
  failed loudly. Both modes hit the same GitHub constraint (status posts to
  unknown SHAs are 404'd), so the field didn't actually let you "attest an
  unpushed commit" — it just controlled error verbosity. Now `attest` always
  fails loudly with exit code 2, which the agentic recovery loop relies on.
  Existing configs with a `sha` field will error with a migration message;
  remove the field. For silent-skip semantics, wrap the call:
  `skilled-pr attest ... || true`.

## [0.1.0] — 2026-04-19

### Added

- Initial release: `skilled-pr attest --skill <name>` posts a GitHub
  commit-status check against `HEAD`.
- `skilled-pr init` scaffolds `.skilledpr.jsonc` with sensible defaults.
- JSONC config parser (comments + trailing commas) backed by
  `microsoft/jsonc-parser`.
