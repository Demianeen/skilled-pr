# Compatible review skills

skilled-pr is **infrastructure**, not a reviewer. It works with any Claude Code skill that produces a `findings.json` in the documented schema, then runs `skilled-pr attest`. This page lists skills known to work today.

If a skill you want isn't here, you can write your own. See [SKILL_AUTHORING.md](./SKILL_AUTHORING.md) for the contract.

## Listed skills

| Skill | Source | What it does | Severity posture |
|---|---|---|---|
| `coderabbit:review` | [CodeRabbit](https://github.com/marketplace/coderabbit) | Cloud-backed AI review with polished output. | Mixed (code-quality + correctness) |
| `coderabbit:code-review` | [CodeRabbit](https://github.com/marketplace/coderabbit) | Alternative entry point for the same engine. | Same as `coderabbit:review` |
| `coderabbit:autofix` | [CodeRabbit](https://github.com/marketplace/coderabbit) | Follow-up pass that auto-applies low-risk fixes. Useful as a second skill after `coderabbit:review`. | Same |
| `gstack:review` | [gstack](https://garryslist.org/gstack/) | Multi-specialist review (testing, maintainability, security, performance). Dispatches subagents in parallel, confidence-gated. | Both, with confidence-gated suppression |
| `gstack:cso` | [gstack](https://garryslist.org/gstack/) | Chief Security Officer mode. OWASP/STRIDE, dependency supply chain, secrets archaeology. | Correctness (security-only) |
| `gstack:design-review` | [gstack](https://garryslist.org/gstack/) | Visual / UX audit. Frontend-only. | Code-quality |
| `vercel-plugin:react-best-practices` | [Vercel plugin](https://vercel.com/docs/agents) | React-specific quality checks. Triggers on TSX changes. | Code-quality |
| `vercel:vercel-agent` | [Vercel plugin](https://vercel.com/docs/agents) | Vercel's PR-review agent. Integrates with the broader Vercel deployment story. | Mixed |

## Choosing a skill

Two questions to ask:

1. **Do you want the gate to block on style?** If yes, pick a skill with "code-quality" posture (most of them). If no, prefer the correctness-only ones (`gstack:cso`) and set `failOn: error` in `.skilledpr/config.jsonc`.
2. **Do you want session-aware review or cold-diff review?** Skills that run inside Claude Code (gstack, vercel-plugin) have your session context — they know WHY each change was made. Skills that call out to cloud services (coderabbit) review the diff in isolation.

## Combining skills

Set multiple skills in `requiredSkills` to require ALL of them:

```jsonc
{
  "requiredSkills": ["coderabbit:review", "gstack:cso"]
}
```

Every required skill posts its own status check (`Skilled PR / coderabbit:review`, `Skilled PR / gstack:cso`) and its own artifact comment. Branch protection requires all of them to pass.

## Default in `skilled-pr init`

`skilled-pr init` sets `requiredSkills: ["review"]` by default. That matches gstack's `/review` skill — the most flexible option for early adopters. Swap it for whichever you actually have installed.

## Adding a skill to this list

Open a PR! If your skill produces conformant `findings.json` and runs `skilled-pr attest`, we'll list it.
