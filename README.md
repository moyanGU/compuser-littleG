# compuser

`compuser` is a local Windows task-chain agent project focused on a reliable single-agent execution model, backend-first routing, and verifiable desktop automation flows.

## What This Repo Contains

- a single-agent query engine and runtime
- a capability-first routing layer
- a Windows-MCP adapter for desktop observation and action
- a local web panel for product-facing task submission

## Authority Documents

- architecture: [ARCHITECTURE.md](./ARCHITECTURE.md)
- development and verification guide: [DEVELOPMENT.md](./DEVELOPMENT.md)
- current support boundary: [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](./PHASE5_VERIFIED_SUPPORT_ENVELOPE.md)
- web-panel boundary: [apps/web-panel/WEB_PANEL_BOUNDARIES.md](./apps/web-panel/WEB_PANEL_BOUNDARIES.md)

## Local Setup

```powershell
npm install
npm run check
npm run build
```

## Common Commands

```powershell
npm run dev
npm run web:panel
npm run test
```

## Notes

- this repository currently uses local documentation as the source of truth for architecture and support claims
- `memory/`, `artifacts/`, `dist/`, `tmp/`, and `node_modules/` are local/generated paths and are not intended as committed source content

# compuser-littleG
