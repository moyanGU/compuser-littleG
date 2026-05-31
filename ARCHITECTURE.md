# compuser Architecture

## Overview

`compuser` stays aligned with the Claude Code single-agent execution model:

- A `QueryEngine` while-loop drives the session.
- The model either returns a final answer or tool calls.
- Tool execution stays separated from tool generation.
- No DAG engine or runtime swarm is introduced in Phase 1.

Phase 1 upgrades the old MVP into a safer and more verifiable platform for cross-application Windows task chains.

## Phase 1 Platform Layers

### Query Layer

Location:
- `packages/core`

Core objects:
- `QueryEngine`
- `ModelClient`

Responsibilities:
- Maintain the session loop.
- Assemble model context for each turn.
- Execute tool calls through `ToolRuntime`.
- Record routing attempts, verification state, and compact state.
- Persist structured task and routing memory after every meaningful step.

Important Phase 1 behavior:
- The engine now persists:
  - `task.current`
  - `task.plan`
  - `task.last_outcome`
  - `routing.last_attempt`
  - `routing.execution_state`
  - `compact.last_summary`
- Tool attempts are classified into:
  - `succeeded`
  - `failed`
  - `verified_failed`
  - `blocked`

### Harness Layer

Location:
- `packages/harness`

Responsibilities:
- Build compact model context.
- Maintain structured memory facts.
- Apply compact tiers and budget tracking.

Current Phase 1 implementation:
- `ContextAssembler` now returns:
  - `toolCatalog`
  - `capabilityCatalog`
  - `routingPlan`
  - `activePlan`
  - `compactState`
- `RuleBasedMicroCompactStrategy` now covers Phase 1 compact tiers:
  - compresses older tool results by whitelist
  - preserves recent tool boundaries
  - tracks token budget headroom
  - falls back to provider-backed session-memory compact when micro compact is insufficient
  - falls back to provider-backed full compact summary when the hard budget is still exceeded
- `SessionMemoryExtractor` stores stable facts instead of chat-like summaries.

Structured memory keys currently in use include:
- `task.current`
- `task.plan`
- `task.last_outcome`
- `routing.last_attempt`
- `routing.execution_state`
- `project.structure`
- `project.recent_paths`
- `preference.response_language`
- `preference.execution_path`
- `constraint.active`
- `compact.last_summary`

### Tool Platform

Location:
- `packages/tools`
- `packages/tools/runtime`

Responsibilities:
- Register tools with a uniform contract.
- Validate tool input shape before execution.
- Enforce permission checks before execution.
- Externalize oversized tool results.
- Support discoverable tools and tool search.

Phase 1 tool metadata:
- `availability: 'core' | 'discoverable'`
- `searchHints: string[]`
- `resultPolicy`
- `permissionProfile`

Large-result handling:
- Oversized tool payloads are stored under `artifacts/tool-results`.
- The runtime returns:
  - a compact preview
  - a `pointer`
- `artifacts.read_result` reads the stored payload back in slices.
- `artifacts.gc_results` reuses the same GC policy as runtime cleanup.

Hooks:
- `beforeToolCall`
- `afterToolCall`
- `beforeModelCall`
- `beforeHttpRequest`

Current real uses:
- risk annotation before Windows bridge calls
- CLI audit logging before model calls
- CLI tool-result audit logging for pointer externalization and failure classes
- rule-reviewer audit data for high-risk or review-required permission checks

### Permission Layer

Location:
- `packages/security`

Responsibilities:
- Keep generation and execution separate.
- Apply rule-based permission evaluation in code.
- Classify risk from both tool declaration and actual input.

Phase 1 modes:
- `read-only`
- `default`
- `confirm-high-risk`
- `auto`

Current classification coverage includes:
- `windows.type`
- `windows.focus_window`
- `windows.click`
- `windows.scroll`
- `windows.move_or_drag`
- `windows.shortcut`
- `windows.clipboard`
- `windows.filesystem`
- `windows.notification`
- `windows.process`
- `windows.registry`
- `windows.shell`

Shell classification:
- read-only PowerShell and search commands are auto-classified lower
- destructive commands stay high risk

Session authorization semantics:
- one-time allow
- session allow for a specific tool
- session allow for a specific risk level

Phase 1 now persists session grants inside the runtime permission checker instead of only the CLI prompt wrapper.
Phase 1 closure also adds a separate rule-based reviewer layer for high-risk or `review-required` actions, with structured `reviewStage` and `reviewSource` fields.

### Capability Layer

Location:
- `packages/capabilities`

Responsibilities:
- Prefer reusable high-level task units before raw tools.
- Encode route preference, retry policy, fallback order, and verification.

Current built-in capabilities:
- `skill.desktop.observe`
- `command.workspace.inspect_tree`
- `command.workspace.search_text`
- `command.workspace.read_text`
- `command.app.open_or_focus`
- `command.desktop.capture_and_locate`
- `command.clipboard.read_write`
- `command.browser.inspect_dom`
- `skill.cross_app.transfer_text`
- `skill.cross_app.open_observe_act_verify`

Capability result contract includes:
- `route`
- `operations`
- `verification`
- `failureClass`
- `fallbacks`

Routing behavior:
- prefer capabilities first
- prefer backend/CLI/API routes before GUI
- only retry when retry policy and failure class both allow it
- avoid exhausted or blocked paths

### Windows Adapter Layer

Location:
- `packages/adapters/windows-mcp`

Responsibilities:
- Normalize Windows-MCP behavior into stable internal objects.
- Hide transport-specific payload differences.

Normalized objects:
- `DesktopSnapshot`
- `DesktopActionResult`

Phase 1 Windows adapter coverage:
- `screenshot`
- `snapshot`
- `focus_window`
- `click`
- `type`
- `shortcut`
- `scroll`
- `move_or_drag`
- `wait`
- `clipboard`
- `app`
- `shell`
- `filesystem`
- `process`
- `notification`

`windows.app` supports:
- `launch`
- `list`
- `switch`
- `resize`

Execution strategy:
- snapshot-first for observation
- backend-first whenever a task can avoid GUI
- GUI chains should follow:
  - observe
  - focus
  - act
  - verify

### Provider Compatibility Layer

Location:
- `packages/core/ModelClient.ts`
- `apps/web-panel`

Responsibilities:
- Support `demo` and `openai-compatible` modes.
- Normalize multiple tool-call response shapes.
- validate parsed tool-call arguments against tool schema
- aggregate streaming tool calls
- expose structured request errors
- keep `web-panel` provider selection aligned with the same CLI model-option parsing path instead of a panel-only hardcoded fallback

Covered compatibility paths:
- OpenAI native tool calls
- flat Ollama-style tool calls
- generic final-text fallback
- invalid schema / invalid JSON / strict-mode tool-call shape errors

## Regression Surface

Phase 1 uses code-based regression entry points instead of a full test framework.

Current scripts:
- `npm run check`
- `npm run test`
- `npm run web:panel:shell-smoke`
- `npm run web:panel:provider-smoke`
- `npm run compact:regression`
- `npm run routing:regression`
- `npm run provider:regression`
- `npm run provider:online`
- `npm run windows:live-smoke`
- `npm run phase1:benchmark`
- `npm run discoverable:regression`
- `npm run windows-bridge:regression`
- `npm run windows:regression`
- `npm run phase4:chains`
- `npm run phase4:template-smoke`
- `npm run phase4:live-smoke`

For the web-panel specifically:
- `web:panel:shell-smoke` only validates shell/HTTP/product-surface behavior
- `web:panel:provider-smoke` is the regression layer that proves the real provider path executed and that provider failures stay visible

## Phase 5 Support Envelope

Phase 5 does not introduce a new architecture layer. The support boundary lives in [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](/E:/compuser/compuser/PHASE5_VERIFIED_SUPPORT_ENVELOPE.md).
The `phase5:*` script family is intentionally retained as historical publication and regression assets so earlier release evidence can still be replayed, but it is not the authoritative current support-surface contract.

`phase1:benchmark` covers the Phase 1 baseline task set:
1. workspace retrieval chain
2. desktop observe chain
3. cross-app transfer chain
4. fallback chain
5. large-result pointer chain
6. permission chain

## Explicit Non-Goals For Phase 1

Not implemented in this phase:
- runtime multi-agent swarm
- coordinator-only mode
- TeamMemorySync
- LLM-as-judge permission reviewer

Those modules still exist as historical regression assets, but they are not part of the current support surface. Phase 1 is intentionally focused on the single-agent platform foundation.
