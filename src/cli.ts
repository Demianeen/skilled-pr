#!/usr/bin/env bun
export {};

const command = process.argv[2];

switch (command) {
  case "attest": {
    const { attest } = await import("./attest");
    await attest(process.argv.slice(3));
    break;
  }
  case "init": {
    const { init } = await import("./init");
    await init();
    break;
  }
  case "hook": {
    const { hook } = await import("./hook");
    await hook();
    break;
  }
  case "doctor": {
    const { doctor } = await import("./doctor");
    await doctor();
    break;
  }
  case "enable-gate": {
    const { enableGate } = await import("./branch-protection");
    await enableGate();
    break;
  }
  default:
    console.log(`skilled-pr v0.1.0 — Open review transport for AI-native development

Usage:
  skilled-pr init                    Set up Skilled PR in this repo
  skilled-pr attest --skill <name>   Post attestation that a review skill ran
                       [--findings <path>]
  skilled-pr doctor                  Diagnose your local setup. Run this when
                                     something seems off — checks bun, gh,
                                     auth, repo state, config, hooks, and
                                     branch protection.
  skilled-pr enable-gate             Add the Skilled PR status checks to your
                                     default branch's protection rules. Additive
                                     — preserves any existing rules.
  skilled-pr hook                    Internal: Claude Code hook entry point.
                                     Reads a hook event on stdin and emits
                                     additionalContext if a required review
                                     skill was just invoked.

Learn more: https://github.com/Demianeen/skilled-pr`);
    break;
}
