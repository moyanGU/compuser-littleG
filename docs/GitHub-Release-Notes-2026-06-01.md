# GitHub Release Notes（2026-06-01）

## Title

`compuser-littleG` release update: CI enabled, real-provider default flow stabilized, and Phase 5 published evidence refreshed

## Summary

This release tightens the repository around one practical goal: make the current supported `compuser` surface more truthful, more verifiable, and easier to publish with confidence.

It includes two connected updates:

- GitHub Actions CI is now enabled for the default `check` and `test` path
- the real-provider-by-default remediation has been carried through to refreshed published Phase 5 evidence on the current verified machine and endpoint

This release does not widen the support envelope. It makes the current declared surface more honest and more operationally usable.

## What Changed

### 1. GitHub Actions CI is now in place

- added `.github/workflows/ci.yml`
- the repository now runs `npm run check` and `npm run test` on push and pull request events
- `CONTRIBUTING.md` now explicitly points contributors at the same verification path used in CI

Why this matters:

- default repository health is now visible from GitHub
- contributor expectations and CI expectations are aligned
- fast regression coverage is no longer only a local convention

### 2. Real provider is now the practical default path for user-facing entry points

The recent remediation work has already moved `web-panel` and `npm run dev` onto the real provider path by default instead of silently falling back to `demo`.

This release packages that work with its release-facing evidence and documentation alignment:

- provider failures remain explicitly visible instead of looking like success
- shell smoke and provider smoke remain clearly separated
- the published delivery note now reflects the real current state instead of the interim “remediation done but published evidence not yet refreshed” position

### 3. Phase 5 published evidence has been refreshed

The published scorecard artifact has been refreshed at:

- [phase5-latest.json](/E:/compuser/compuser/artifacts/scorecard/phase5-latest.json)

Published result:

- `overallClaimGate = pass`
- `total_runs = 100`
- `pass = 100`
- `verification_failed = 0`
- `transport_error = 0`
- `provider_error = 0`

This means the repository may conservatively present `95%+ verified support`, but only inside the already frozen support envelope:

- current machine
- current local Windows-MCP endpoint
- frozen five-template surface
- verified browser / local Codex / WeChat-like target set only

### 4. Release evidence harness was corrected, not broadened

During the evidence refresh, the multi-window live smoke harness was found to be too strict: it incorrectly assumed the template must always land on the primary target window.

That assumption was wrong for the actual template semantics. The harness now accepts any valid routed target from the allowed comparison set.

Why this matters:

- the fix removes a false release blocker
- it does not loosen product behavior
- it keeps the published scorecard aligned with the real template contract instead of an accidental harness assumption

## Validation

The release-facing work was validated with:

```powershell
npm run build
npm run dev:regression
npm test
npm run provider:regression
npm run web:panel:provider-smoke
npm run product:verify
npm run phase5:live-smoke -- --runs 1 --endpoint http://127.0.0.1:8010/mcp --permission-mode auto
npm run phase5:scorecard -- --runs 20 --cooldown-ms 1000 --max-total-minutes 90 --per-run-timeout-ms 600000 --restart-windows-mcp-on-failure --desktop-reset-between-runs --endpoint http://127.0.0.1:8010/mcp --permission-mode auto --json-out E:\compuser\compuser\artifacts\scorecard\phase5-latest.json
```

## Scope Boundaries

This release does not claim:

- support beyond the frozen five-template Phase 4/Phase 5 surface
- universal Windows reliability
- arbitrary desktop target support
- support for remote machines or different Windows-MCP endpoints without re-verification
- expansion of the provider system beyond `demo` and `openai-compatible`

## Key Files

- [DEVELOPMENT.md](/E:/compuser/compuser/DEVELOPMENT.md)
- [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](/E:/compuser/compuser/PHASE5_VERIFIED_SUPPORT_ENVELOPE.md)
- [真实可用交付说明-2026-05-31.md](/E:/compuser/compuser/docs/真实可用交付说明-2026-05-31.md)
- [apps/cli/phase4-live-smoke.ts](/E:/compuser/compuser/apps/cli/phase4-live-smoke.ts)
- [.github/workflows/ci.yml](/E:/compuser/compuser/.github/workflows/ci.yml)

## Short Version

This release makes the current `compuser` surface easier to trust:

- CI now checks the default offline gate on GitHub
- real-provider entry points stay explicit and non-silent on failure
- the published Phase 5 evidence has been refreshed to a clean `100 / 100 pass`
- support wording remains bounded to the same frozen verified envelope
