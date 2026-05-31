# Development Guide

This document is the local development and verification runbook.

- architecture authority: [ARCHITECTURE.md](/E:/compuser/compuser/ARCHITECTURE.md)
- product/support-claim authority: [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](/E:/compuser/compuser/PHASE5_VERIFIED_SUPPORT_ENVELOPE.md)
- web-panel boundary authority: [WEB_PANEL_BOUNDARIES.md](/E:/compuser/compuser/apps/web-panel/WEB_PANEL_BOUNDARIES.md)

## Current Goal

Phase 1 is about making `compuser` a reliable single-agent platform for complex Windows task chains:

- backend-first when possible
- structured observe/act/verify behavior
- explicit fallback paths
- permission-aware execution
- replayable regression coverage

Phase 4 is the active follow-on for success-rate baselines and template lift: reuse verified chains, expose them as stable high-level task templates, and keep regression plus smoke coverage aligned for:

- browser -> editor -> IM/chat
- filesystem -> browser -> desktop app
- multi-window observe -> route -> deliver -> verify

Phase 4 keeps the template surface high-level only. The goal is a truthful first success-rate baseline, not a new runtime layer or a rewrite of earlier phase contracts.

Phase 5 is a documentation freeze over that verified Phase 4 surface. The authoritative support boundary lives in [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](/E:/compuser/compuser/PHASE5_VERIFIED_SUPPORT_ENVELOPE.md).

Current published/support status:
- the authoritative claim boundary, frozen support matrix, exclusion scope, and current published result live in [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](/E:/compuser/compuser/PHASE5_VERIFIED_SUPPORT_ENVELOPE.md)
- the current published artifact is [phase5-latest.json](/E:/compuser/compuser/artifacts/scorecard/phase5-latest.json)
- the local web panel must keep its recommended templates and product wording aligned to that frozen envelope
- `npm run windows:wechat-live-smoke` remains a state-aware gate probe on the current machine only; it does not widen support to stable login, receive, or send behavior
- release claims should follow the published artifact endpoint until a newer scorecard is generated and published

## Core Commands

Build and static verification:

```powershell
npm run check
```

Build compiled output:

```powershell
npm run build
```

Run the local dev entry:

```powershell
npm run dev
```

Run the Phase 1 baseline regression:

```powershell
npm run phase1:benchmark
```

Run discoverable-tool regression:

```powershell
npm run discoverable:regression
```

Run compact regression:

```powershell
npm run compact:regression
```

Run Windows Phase 1 regression:

```powershell
npm run windows:regression
```

Run Windows-MCP bridge regression:

```powershell
npm run windows-bridge:regression
```

Run routing regression:

```powershell
npm run routing:regression
```

Run provider compatibility regression:

```powershell
npm run provider:regression
```

Run provider online smoke:

```powershell
npm run provider:online
```

Run Windows live smoke:

```powershell
npm run windows:live-smoke
```

Run Phase 4 chain regression:

```powershell
npm run phase4:chains
```

Run Phase 4 template smoke with repeatable statistics:

```powershell
npm run phase4:template-smoke -- --runs 3 --endpoint http://127.0.0.1:8010/mcp --permission-mode auto
```

Run Phase 4 live smoke:

```powershell
npm run phase4:live-smoke -- --endpoint http://127.0.0.1:8010/mcp --permission-mode auto
```

Publish a scorecard summary for the web panel:

```powershell
npm run phase5:scorecard -- --runs 3 --cooldown-ms 5000 --max-total-minutes 20 --endpoint http://127.0.0.1:8010/mcp --permission-mode auto --json-out E:\compuser\compuser\artifacts\scorecard\phase5-latest.json
```

Refresh the full conservative claim gate sample:

```powershell
npm run phase5:scorecard -- --runs 20 --cooldown-ms 8000 --max-total-minutes 90 --endpoint http://127.0.0.1:8010/mcp --permission-mode auto --json-out E:\compuser\compuser\artifacts\scorecard\phase5-latest.json
```

Run the release-facing product smoke:

```powershell
npm run product:smoke
```

Run the local product panel:

```powershell
npm run web:panel
```

Run recovery regression:

```powershell
npm run recovery:regression
```

Run standalone result GC daemon:

```powershell
npm run result-gc:daemon
```

## Verification Matrix

Use the smallest feedback loop that matches the change surface. Do not default to live smoke when a module-level check is enough.

Web-panel structure freeze:
- the web-panel HTTP entry and runtime-wiring boundary is documented in [WEB_PANEL_BOUNDARIES.md](/E:/compuser/compuser/apps/web-panel/WEB_PANEL_BOUNDARIES.md)
- keep module ownership aligned to that document; do not move bootstrap/runtime/dispatcher/flow responsibilities back across file boundaries
- default panel paths now come from one source in `apps/web-panel/defaults.ts`; do not reintroduce ad-hoc path joins in dispatcher or server entrypoints

### Fast Feedback

Safe defaults for handler, flow, dispatcher, panel copy, and most non-live logic work. These commands do not intentionally launch desktop apps or browser windows.

| Command | Purpose | Typical Cost | Launches windows / touches desktop |
| --- | --- | --- | --- |
| `npm run check` | Typecheck only; catch interface drift and compile-time breakage | fast | no |
| `npm run test` | Minimal core tests plus `windows-bridge` regression and web-panel module regressions | fast | no |
| `npm run web:panel:module-regression` | Run `requestDispatcher`, `sessionControlFlow`, `systemProductFlow`, and `templateLaunchFlow` regressions directly | fast | no |
| `npm run phase4:chains` | Local template wiring regression for the frozen Phase 4 template family | fast | no |
| `npm run discoverable:regression` | Capability discovery guardrails | fast | no |
| `npm run compact:regression` | Compact/session-memory regression | fast | no |
| `npm run routing:regression` | Routing state regression | fast | no |
| `npm run provider:regression` | Provider payload compatibility regression | fast | no |
| `npm run windows-bridge:regression` | Windows-MCP bridge protocol regression | fast | no |
| `npm run windows:regression` | Windows adapter normalization regression with local assertions only | fast | no |

### Medium Feedback

Use these when changing product-facing panel behavior, support-matrix reads, or repeatable smoke logic. These commands may start a local Node server, but they should not intentionally manipulate desktop windows.

| Command | Purpose | Typical Cost | Launches windows / touches desktop |
| --- | --- | --- | --- |
| `npm run product:verify` | Build plus product smoke and real-provider web-panel smoke for release-facing panel/support-matrix assertions | medium | no desktop windows; starts local panel server |
| `npm run web:panel:shell-smoke` | Local web-panel shell/HTTP smoke; does not prove real provider execution | medium | no desktop windows; starts local panel server |
| `npm run web:panel:provider-smoke` | Local web-panel real-provider smoke with explicit provider pass-through and failure visibility assertions | medium | no desktop windows; starts local panel server |
| `npm run product:smoke` | Product-facing support/surface smoke against built panel | medium | no desktop windows; starts local panel server |
| `npm run phase4:template-smoke -- --runs 3` | Repeatable stub-backed template smoke for baseline statistics | medium | no |

### Slow / Live Feedback

Run these only when the change actually touches endpoint-backed runtime behavior, desktop routing, or release evidence. They may launch services, focus windows, inspect the desktop, or leave visible side effects if interrupted.

| Command | Purpose | Typical Cost | Launches windows / touches desktop |
| --- | --- | --- | --- |
| `npm run provider:online` | Live model/provider smoke | slow | no desktop windows; requires reachable model endpoint |
| `npm run windows:live-smoke` | Real Windows-MCP live smoke on the current machine | slow | yes |
| `npm run phase4:live-smoke -- --endpoint http://127.0.0.1:8010/mcp --permission-mode auto` | Frozen Phase 4 live verification on the current machine/current endpoint | slow | yes |
| `npm run windows:wechat-live-smoke` | WeChat gate probe on the current machine only | slow | yes |
| `npm run phase5:scorecard -- --runs 3 ...` | Publish/update scorecard evidence for the frozen support claim | slow | usually yes when endpoint-backed flows are exercised |
| `npm run phase5:template-smoke` | Template-family stub-backed smoke for Phase 5 evidence collection | slow | no |
| `npm run phase5:live-smoke` | Current machine/current endpoint live release verification | slow | yes |
| `npm run phase4:chains` + slow commands above | Use fast chain regression first, then live verification only for changed surfaces | staged | mixed |

Live-run guardrails:
- do not run more than one live suite against the same Windows-MCP endpoint at the same time
- do not run `build` concurrently with dist-consuming live scripts
- shared desktop interference is real: manually opened apps, taskbar changes, or extra windows can invalidate focus/route assumptions during live smoke
- `windows:wechat-live-smoke` reporting `manual_confirmation_required` is an environment state on this machine, not by itself a product regression

## Product Release Defaults

- published scorecard JSON: `E:\compuser\compuser\artifacts\scorecard\phase5-latest.json`
- local panel default session id: `local-web-panel-session`
- local panel default port: `4317`

## Local Configuration Overrides

The current machine defaults remain unchanged. Use environment variables only when you need to point the same build at a different local workspace or a different already-verified local endpoint.

- `COMPUSER_WORKSPACE_ROOT`
  Overrides the inferred repo root used by CLI and web-panel runtime path defaults.
  Default on the current machine: `E:\compuser\compuser`
- `COMPUSER_WINDOWS_MCP_ENDPOINT`
  Overrides the Windows-MCP endpoint for `web:panel`, `ordinary-user-launcher`, and most live/smoke runners that already accept endpoint overrides.
  Default on the current machine: `http://127.0.0.1:8010/mcp`
- `COMPUSER_WINDOWS_MCP_SERVICE_CONFIG_PATH`
  Overrides the persisted Windows-MCP service config file path.
  Default on the current machine: `E:\compuser\compuser\memory\windows-mcp-service.json`
- `COMPUSER_PRODUCT_SCORECARD_PATH`
  Overrides the scorecard JSON file that the web-panel server reads at startup.
  Default on the current machine: `E:\compuser\compuser\artifacts\scorecard\phase5-latest.json`
- `COMPUSER_PRODUCT_SCORECARD_DISPLAY_PATH`
  Overrides the product-facing path string shown in panel governance cards.
  Default value shown in the panel: `artifacts/scorecard/phase5-latest.json`

Example:

```powershell
$env:COMPUSER_WORKSPACE_ROOT='E:\alt\compuser'
$env:COMPUSER_WINDOWS_MCP_ENDPOINT='http://127.0.0.1:8011/mcp'
$env:COMPUSER_PRODUCT_SCORECARD_PATH='E:\alt\compuser\artifacts\scorecard\phase5-latest.json'
npm run product:verify
```

This does not widen the support claim. It only lets the same local product surface point at a different local workspace or a different already-verified local endpoint.

Provider default note:
- the web-panel product surface now defaults to `openai-compatible`, not `demo`
- `npm run dev` now also defaults to `openai-compatible`, not `demo`
- if `COMPUSER_MODEL_PROVIDER` is left unset, task submission will use the same provider family by default and surface missing provider config as an explicit task failure instead of silently falling back to demo behavior
- use `COMPUSER_MODEL_PROVIDER=demo` only for explicit local demo/testing scenarios
- `npm run web:panel:shell-smoke` only validates shell/HTTP/product-surface behavior; real provider validation must come from `npm run web:panel:provider-smoke` or `npm run product:verify`

Release note:
- runtime defaults may move independently from published evidence; before refreshing any public claim, compare the current runtime endpoint with the endpoint recorded inside the published scorecard artifact
- if they differ, either regenerate/publish the scorecard for the current endpoint or keep product wording anchored to the existing artifact endpoint

## Product Release Checklist

1. `npm run build`
2. `npm run web:panel:shell-smoke`
3. `npm run product:smoke`
4. `npm run web:panel:provider-smoke`
5. `npm run phase5:scorecard -- --runs 1 --cooldown-ms 1000 --max-total-minutes 5 --endpoint http://127.0.0.1:8010/mcp --permission-mode auto --json-out E:\compuser\compuser\artifacts\scorecard\phase5-latest.json`
   Verification: confirm the generated artifact endpoint matches the endpoint you intend to claim publicly
6. Confirm the product panel recommended templates still come only from the verified support matrix
7. Confirm public support wording still matches [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](/E:/compuser/compuser/PHASE5_VERIFIED_SUPPORT_ENVELOPE.md)

Current delivery-note reference:
- use [真实可用交付说明-2026-05-31.md](/E:/compuser/compuser/docs/真实可用交付说明-2026-05-31.md) when handing off the current "real provider by default" remediation without refreshing the published Phase 5 claim

## Phase 1 Benchmark Set

The baseline benchmark script lives at:
- [phase1-benchmark-regression.ts](/E:/compuser/compuser/apps/cli/phase1-benchmark-regression.ts)

It covers these fixed scenarios:

1. Workspace retrieval chain
   Verification: inspect tree, search text, and read file all succeed.
2. Desktop observe chain
   Verification: snapshot-first observation and window focus both succeed.
3. Cross-app transfer chain
   Verification: focus + clipboard + paste flow returns verified success.
4. Fallback chain
   Verification: backend-first capability fails, safer fallback path succeeds.
5. Large-result pointer chain
   Verification: oversized result is externalized and read back through pointer tooling.
6. Permission chain
   Verification: high-risk action is denied while read-only shell is allowed.
7. Permission session-grant chain
   Verification: a tool-scoped approval is reused without prompting again in the same session.

## Provider Regression Fixtures

Regression fixtures are stored under:
- `fixtures/model-regression`
- `fixtures/model-online-smoke`

`provider:regression` validates:
- OpenAI tool-call payloads
- flat Ollama-compatible tool-call payloads
- generic final-text payloads
- strict-mode shape failures
- tool schema validation failures

`provider:online` validates:
- final answer path
- single tool-call path
- full compact live call
- session-memory compact live call

`web-panel` provider wiring validates:
- the panel forwards the configured provider into the same CLI model-option builder used by `npm run dev`
- provider misconfiguration surfaces as an explicit panel task failure instead of silently falling back to `demo`
- shell smoke is intentionally separate from provider smoke; do not treat shell smoke as proof that the real provider path executed

`discoverable:regression` validates:
- discoverable tools are blocked before `tools.search`
- discoverable tools execute after discovery

`compact:regression` validates:
- microcompact pointer retention
- session-memory compact trigger
- full compact trigger
- provider-backed session-memory structured fact carry-through
- compact failure downgrade and circuit-break pause

`windows:regression` validates:
- new Windows tool normalization
- `windows.app` list-mode normalization
- browser DOM observation path
- open/observe/act/verify task chain
- GUI four-stage operations and recovery markers

`windows-bridge:regression` validates:
- JSON `structuredContent`
- text content blocks
- SSE JSON-RPC bridge responses
- focus-window pre-snapshot and post-action verification normalization
- interactive-element fallback after window-switch failure

## Live Windows Smoke

For real Windows-MCP validation, start a Windows-MCP server first.

Example:

```powershell
uvx windows-mcp serve --transport streamable-http --host 127.0.0.1 --port 8010
```

Then run the local dev entry against the endpoint.

Recommended manual smoke cases:
- `snapshot`
- `focus_window`
- `clipboard`
- `app switch`

Automated local smoke cases:
- `npm run windows:live-smoke`
- `npm run provider:online`

Current Windows live smoke coverage:
- `windows.snapshot` normalization
- `windows.focus_window`
- `skill.desktop.observe`
- `windows.clipboard` and `command.clipboard.read_write`
- `windows.app` list/switch
- `command.desktop.capture_and_locate`

Current provider live smoke coverage:
- final answer path
- single tool-call path
- full compact call
- session-memory compact call

## Phase 4 Success-Rate Baseline

Phase 4 keeps the template surface high-level and uses repeated smoke runs to establish a truthful baseline.

Current Phase 4 template list:
- `skill.browser.editor_chat_reply_template`
- browser -> verified editor staging -> verified IM/chat delivery
- `skill.browser.doc_desktop_deliver_template`
- browser -> editor staging -> final desktop app delivery
- `skill.file.browser_form_submit_template`
- local file read/transform -> browser-target submit or delivery
- `skill.multi_window.compare_summarize_deliver_template`
- multi-window observe -> route -> summarize -> deliver -> verify
- `skill.browser.extract_transform_post_template`
- browser extract -> transform -> post/transfer to desktop target

Phase 4 environment prerequisites:
- `phase4:template-smoke` does not require a live Windows-MCP endpoint; it uses stubbed nested-chain executions to validate template wiring and summary classification
- a reachable Windows-MCP endpoint is required only for endpoint-backed live smoke work
- browser and desktop windows must be available for the specific template when live smoke is enabled
- permission mode other than `read-only` is required for live delivery flows

Expected `skip` cases:
- the current `phase4:template-smoke` baseline runner should normally not emit `skip`; any skip-style classification is reserved for future endpoint-backed smoke runs
- browser-driven live smoke may report `environment_unready` when the active browser page does not expose stable extractable text
- filesystem -> browser -> desktop delivery may report `environment_unready` when no suitable route target or final target is confirmable
- multi-window delivery may report `environment_unready` when fewer than two distinct confirmable windows are available

Regression failures:
- `verification_failed` means the template wrapper or its underlying verified chain failed an assertion
- `execution_failed` and `routing_failed` are regression-class outcomes when surfaced by the nested chain
- `transport_error`, `provider_error`, and `permission_blocked` are infrastructure or environment failures, not template success
- `environment_unready` is expected only when the environment cannot safely support the requested template flow

Phase 4 smoke summary fields:
- `total_runs`
- `pass`
- `skip`
- `verification_failed`
- `environment_unready`
- `transport_error`
- `provider_error`
- `routing_failed`
- `execution_failed`
- `permission_blocked`

Current Phase 4 script state:
- `phase4:chains` is implemented and runs local regression assertions for all current Phase 4 templates
- `phase4:template-smoke` is implemented as the first repeatable success-rate baseline runner and supports `--runs`
- `phase4:template-smoke` currently uses a local stub-backed runtime, so endpoint flags are accepted for command-line compatibility but are not yet consumed
- `phase4:live-smoke` is implemented as the current machine/current-endpoint live verification runner for the frozen Phase 4 template family
- `phase5:chains`, `phase5:template-smoke`, and `phase5:live-smoke` are intentionally retained as historical publication/regression assets; keep them for auditability and earlier release replay, but do not treat them as the authoritative current support-surface contract
- current support claims should use the Phase 5 documentation gate in [PHASE5_VERIFIED_SUPPORT_ENVELOPE.md](/E:/compuser/compuser/PHASE5_VERIFIED_SUPPORT_ENVELOPE.md)

Recommended Phase 4 commands:

```powershell
npm run phase4:chains
npm run phase4:template-smoke -- --runs 3
npm run phase4:live-smoke -- --endpoint http://127.0.0.1:8010/mcp --permission-mode auto
```

## Phase 1 Expectations For Code Changes

When adding or changing behavior in this phase:

- keep the `QueryEngine` while-loop model
- prefer capability-first routing
- prefer backend/CLI/API before GUI
- keep tool execution schema-validated
- classify failures into stable categories
- update docs and regression coverage in the same change

## Important Paths

Key implementation files:
- [QueryEngine.ts](/E:/compuser/compuser/packages/core/QueryEngine.ts)
- [ModelClient.ts](/E:/compuser/compuser/packages/core/ModelClient.ts)
- [ContextAssembler.ts](/E:/compuser/compuser/packages/harness/context/ContextAssembler.ts)
- [SessionMemoryExtractor.ts](/E:/compuser/compuser/packages/harness/memory/SessionMemoryExtractor.ts)
- [CompactStrategy.ts](/E:/compuser/compuser/packages/harness/compact/CompactStrategy.ts)
- [ToolRuntime.ts](/E:/compuser/compuser/packages/tools/runtime/ToolRuntime.ts)
- [PermissionPolicy.ts](/E:/compuser/compuser/packages/security/PermissionPolicy.ts)
- [BuiltinCapabilities.ts](/E:/compuser/compuser/packages/capabilities/BuiltinCapabilities.ts)
- [WindowsMcpAdapter.ts](/E:/compuser/compuser/packages/adapters/windows-mcp/WindowsMcpAdapter.ts)
- [WindowsTools.ts](/E:/compuser/compuser/packages/adapters/windows-mcp/WindowsTools.ts)

CLI exports and developer entry points:
- [main.ts](/E:/compuser/compuser/apps/cli/main.ts) re-exports the CLI app surface for importers; it is not the runnable local dev entry
- [dev.ts](/E:/compuser/compuser/apps/cli/dev.ts)
- [compact-regression.ts](/E:/compuser/compuser/apps/cli/compact-regression.ts)
- [discoverable-tools-regression.ts](/E:/compuser/compuser/apps/cli/discoverable-tools-regression.ts)
- [routing-state-regression.ts](/E:/compuser/compuser/apps/cli/routing-state-regression.ts)
- [provider-regression.ts](/E:/compuser/compuser/apps/cli/provider-regression.ts)
- [provider-online-smoke.ts](/E:/compuser/compuser/apps/cli/provider-online-smoke.ts)
- [phase1-benchmark-regression.ts](/E:/compuser/compuser/apps/cli/phase1-benchmark-regression.ts)
- [windows-bridge-regression.ts](/E:/compuser/compuser/apps/cli/windows-bridge-regression.ts)
- [windows-phase1-regression.ts](/E:/compuser/compuser/apps/cli/windows-phase1-regression.ts)

## Known Phase 1 Limits

Still intentionally out of scope:
- multi-agent runtime
- coordinator mode
- LLM-as-judge permissions
- exhaustive real Windows live coverage in CI

The target in this phase is a trustworthy single-agent foundation, not feature-maximal surface area.
