# compuser-littleG

`compuser-littleG` is a local Windows task-chain agent project focused on a reliable single-agent execution model, backend-first routing, and verifiable desktop automation flows.

It is designed as a practical agent runtime for complex desktop tasks, with an emphasis on:

- single-agent execution instead of a multi-agent runtime
- backend-first routing when a task can avoid GUI automation
- explicit observe -> act -> verify behavior for desktop actions
- replayable regression coverage and support-boundary documentation

## What It Includes

- a query engine and tool runtime under `packages/core` and `packages/tools`
- a capability-first routing layer under `packages/capabilities`
- a Windows-MCP adapter for desktop observation and action under `packages/adapters/windows-mcp`
- a local web panel for task submission under `apps/web-panel`
- regression and smoke runners under `apps/cli`

## Current Scope

This repository is intentionally centered on a Windows local-development workflow.

Current project direction and support language are defined by the documents below:

- architecture authority: [ARCHITECTURE.md](./ARCHITECTURE.md)
- development and verification runbook: [DEVELOPMENT.md](./DEVELOPMENT.md)
- current support boundary: [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](./PHASE5_VERIFIED_SUPPORT_ENVELOPE.md)
- web-panel boundary: [apps/web-panel/WEB_PANEL_BOUNDARIES.md](./apps/web-panel/WEB_PANEL_BOUNDARIES.md)

The project does not claim a general desktop-agent support surface beyond what is explicitly frozen in those files.

## Quick Start

Install dependencies and run the smallest safe checks first:

```powershell
npm install
npm run check
npm run build
```

Useful local entry points:

```powershell
npm run dev
npm run web:panel
npm run test
```

## Verification

The fastest general-purpose validation path is:

```powershell
npm run check
npm run test
```

For additional project-specific verification commands, use [DEVELOPMENT.md](./DEVELOPMENT.md).

## Repository Layout

```text
apps/
  cli/        regression runners, smoke runners, local entry points
  web-panel/  local product-facing panel
packages/
  core/       query engine and model runtime
  capabilities/
  tools/
  security/
  adapters/
fixtures/     provider regression fixtures
tests/        minimal targeted tests
docs/         delivery and operator-facing notes
```

## Notes

- this repository currently uses local documentation as the source of truth for architecture and support claims
- `memory/`, `artifacts/`, `dist/`, `tmp/`, and `node_modules/` are local/generated paths and are not intended as committed source content
