# Web Panel Boundaries

## Purpose

`apps/web-panel` is the product-facing local control surface for the verified
single-agent desktop orchestration flow. It does not introduce a new runtime.
It adapts the existing CLI/runtime stack into a local HTTP panel.

## Entry Layer

- `server.ts`
- `serverRuntime.ts`

Responsibilities:

- start the local HTTP server
- assemble the shared runtime dependencies
- expose small shared read helpers such as Windows-MCP status and scorecard reads

Non-responsibilities:

- no task-state mutation logic
- no template decision logic
- no route-by-route branching logic

## Dispatch Layer

- `requestDispatcher.ts`

Responsibilities:

- map HTTP method + path to the correct flow
- translate request payloads into typed flow inputs
- preserve response status codes and payload shapes
- forward provider/runtime configuration without silently rewriting it to a panel-only default
- keep shell smoke and real-provider smoke separate so panel HTTP coverage is not mistaken for provider execution coverage

Non-responsibilities:

- no runtime construction
- no direct Windows-MCP orchestration logic
- no duplicated session-state transition logic

## Flow Layer

- `sessionOrchestration.ts`
- `templateLaunchFlow.ts`
- `systemProductFlow.ts`
- `sessionControlFlow.ts`

Responsibilities:

- own state transitions for one coherent product flow each
- return explicit result objects for dispatcher mapping
- surface provider/runtime failures back into session state so the panel shows a visible failure instead of a silent hang

Non-responsibilities:

- no HTTP response writing
- no static asset serving
- no server bootstrap

## Support Layer

- `httpTypes.ts`
- `taskSubmission.ts`
- `uploads.ts`
- `permissionPrompt.ts`
- `serviceStatus.ts`
- `templateRecommendations.ts`
- `sessionStore.ts`
- `panelState.ts`
- `panelTypes.ts`

Responsibilities:

- payload parsing
- state shaping
- helper views and support types

## Current Contract Rule

When adding new web-panel behavior:

1. If it changes HTTP path handling only, prefer `requestDispatcher.ts`.
2. If it changes one product flow's state machine, prefer the matching flow module.
3. If it changes runtime wiring, prefer `serverRuntime.ts`.
4. Do not put new task or template state transitions back into `server.ts`.
