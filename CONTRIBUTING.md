# Contributing to compuser-littleG

Thanks for contributing.

This repository is intentionally scoped around a local Windows development workflow and a documented support boundary. Please keep changes small, explicit, and easy to verify.

## Before You Change Code

- read [README.md](./README.md) for the project overview
- read [ARCHITECTURE.md](./ARCHITECTURE.md) for the current architecture boundary
- read [DEVELOPMENT.md](./DEVELOPMENT.md) for commands and verification guidance
- read [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](./PHASE5_VERIFIED_SUPPORT_ENVELOPE.md) before changing product wording, support claims, or scorecard-facing behavior
- read [apps/web-panel/WEB_PANEL_BOUNDARIES.md](./apps/web-panel/WEB_PANEL_BOUNDARIES.md) before moving responsibilities across web-panel modules

## Development Setup

```powershell
npm install
npm run check
npm run build
```

Useful local commands:

```powershell
npm run dev
npm run web:panel
npm run test
```

## Change Style

- prefer the smallest change that solves the problem
- do not widen product or support claims casually
- prefer backend-first or non-GUI validation when possible
- do not mix unrelated refactors into a feature or bugfix change
- update docs only when they need to stay aligned with the real implementation

## Verification

Choose the smallest feedback loop that matches your change.

Fast default:

```powershell
npm run check
npm run test
```

For larger or release-facing changes, use the verification matrix in [DEVELOPMENT.md](./DEVELOPMENT.md).

Important guardrails:

- do not run more than one live suite against the same Windows-MCP endpoint at the same time
- do not run `build` concurrently with dist-consuming live scripts
- treat current-machine live smoke as environment-sensitive, not as general platform proof

## Repo Boundaries

Generated and local runtime paths should stay out of commits:

- `node_modules/`
- `dist/`
- `artifacts/`
- `tmp/`
- `memory/`

Current source layout:

```text
apps/
packages/
fixtures/
tests/
docs/
```

## Pull Requests

Good pull requests in this repository usually:

- explain the problem briefly
- keep the implementation scoped
- describe the verification actually run
- call out any support-boundary or documentation impact

If a change affects architecture, runtime boundaries, support claims, or web-panel responsibilities, update the relevant authority document in the same change.
