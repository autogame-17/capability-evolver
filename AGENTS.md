# Repository Agent Instructions

## Scope

- Follow `README.md`, localized READMEs, `SKILL.md`, and `package.json` before changing behavior.
- Keep Evolver review/solidify flows inspectable and local-first.
- Do not commit secrets, tokens, cookies, generated credentials, browser profiles, private logs, or local machine paths.

## Commands

- Install: `npm ci` when dependencies need to be installed.
- Start: `npm start`.
- Run once: `npm run run`.
- Review: `npm run review`.
- Solidify: `npm run solidify`.
- A2A helpers: use the existing `a2a:*` scripts when touching agent-to-agent export, ingest, or promote flows.

## Verification

Run the smallest script that exercises the changed flow. For docs-only changes, inspect the changed Markdown and any referenced command names.

## Git

- Preserve unrelated dirty changes.
- Do not rewrite history, delete branches, push, publish, or open PRs without explicit confirmation.
