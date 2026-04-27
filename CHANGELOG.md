# Changelog

All notable changes to `skilled-pr` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
