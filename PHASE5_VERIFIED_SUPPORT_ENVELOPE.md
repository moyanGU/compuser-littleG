# Phase 5 Verified Support Envelope

This document now serves two purposes:
- it freezes the support envelope that may be claimed from the current verified template surface
- it records that the current published Phase 5 scorecard has passed the frozen `95%+` claim gate on this exact machine and endpoint

Phase 5 still does not add a new runtime layer or a new template family. It remains a support-envelope and evidence-publication phase.

The purpose of this document is to keep support claims truthful, repeatable, and bounded to the evidence already present in the repository without widening from one verified local setup to a general platform claim.

Release-facing product rule:
- ordinary-user recommendations, scorecard display, and release claim wording must all resolve back to the same frozen support matrix
- ordinary-user product wording must stay inside this exact boundary: current machine, current Windows-MCP endpoint, frozen five templates, and browser/Codex/WeChat-like chat windows only

## 0. Current Published Claim Status

The current published scorecard artifact is:
- [phase5-latest.json](/E:/compuser/compuser/artifacts/scorecard/phase5-latest.json)
- the artifact currently records endpoint `http://127.0.0.1:8010/mcp`

The current published claim result is:
- `overallClaimGate = pass`
- `total_runs = 100`
- `pass = 100`
- `verification_failed = 0`
- `environment_unready = 0`
- `transport_error = 0`
- `provider_error = 0`
- `permission_blocked = 0`
- `execution_failed = 0`
- `routing_failed = 0`

Template-level published result:
- each frozen template currently has `20/20 pass`
- each frozen template currently has `claimGate = pass`
- each frozen family currently has `claimGate = pass`

This means `compuser` may now conservatively present a `95%+ verified support` claim, but only inside the frozen support envelope described below.

## 1. Frozen Support Matrix

The current verified Phase 4 template family is:

| Template | Chain Regression | Template Smoke | Live Smoke | Frozen Claim |
| --- | --- | --- | --- | --- |
| `skill.browser.editor_chat_reply_template` | covered by `phase4:chains` | covered by `phase4:template-smoke` | covered by `phase4:live-smoke` on the current machine and current endpoint | supported only on the current machine and current Windows-MCP endpoint as a verified browser -> editor -> chat reply template targeting the local Codex window or a WeChat-like chat window |
| `skill.browser.doc_desktop_deliver_template` | covered by `phase4:chains` | covered by `phase4:template-smoke` | covered by `phase4:live-smoke` on the current machine and current endpoint | supported only on the current machine and current Windows-MCP endpoint as a verified browser -> editor -> desktop delivery template into the local Codex window |
| `skill.file.browser_form_submit_template` | covered by `phase4:chains` | covered by `phase4:template-smoke` | covered by `phase4:live-smoke` on the current machine and current endpoint | supported only on the current machine and current Windows-MCP endpoint as a verified file -> browser submit or delivery template through the current verified browser window |
| `skill.multi_window.compare_summarize_deliver_template` | covered by `phase4:chains` | covered by `phase4:template-smoke` | covered by `phase4:live-smoke` on the current machine and current endpoint | supported only on the current machine and current Windows-MCP endpoint as a verified multi-window compare -> summarize -> deliver template when at least two supported windows are available and the delivery target is Codex or a WeChat-like chat window |
| `skill.browser.extract_transform_post_template` | covered by `phase4:chains` | covered by `phase4:template-smoke` | covered by `phase4:live-smoke` on the current machine and current endpoint | supported only on the current machine and current Windows-MCP endpoint as a verified browser extract -> transform -> transfer template into the local Codex window or a WeChat-like chat window |

Frozen matrix rules:
- `phase4:chains` is the contract-level regression source for wrapper behavior, routing policy, chain state, failure reason, recovery action, and recovery point preservation.
- `phase4:template-smoke` is the repeatable scorecard source for aggregate status counting across the current template family.
- `phase4:live-smoke` is the environment-backed verification source for the current machine plus its current Windows-MCP endpoint only.
- Live verification does not widen the claim to all Windows environments, all endpoints, or all desktop targets. It proves support only for the current verified setup and the documented browser/Codex/WeChat-like target class.
- Stable WeChat login is currently manual-confirmation-required on this machine; live smoke may observe the login branch, but it does not convert that branch into an autonomous supported claim.

## 2. Claim Gate

Phase 5 support claims must pass this gate:

1. The claimed template must be present in the frozen template family above.
2. The template must remain covered by `phase4:chains`.
3. The template must remain covered by `phase4:template-smoke`.
4. If the claim uses the words `verified`, `live`, or `supported on Windows`, it must also be backed by `phase4:live-smoke` on the current machine and current Windows-MCP endpoint.
5. Environment-dependent skips or failures must stay classified as environment or infrastructure limits, not upgraded into broader product claims.
6. If the claim refers to a target surface, it must stay inside the verified browser/Codex/WeChat-like window set.

Allowed claim style:
- "Supported in the current Phase 4 template surface."
- "Verified on the current machine with the current Windows-MCP live-smoke endpoint."
- "Environment-sensitive and only claimable when the documented prerequisites are met."
- "Recommended in the product panel only because it is part of the frozen verified support matrix."

Disallowed claim style:
- claiming support for templates outside the frozen five-template list
- claiming endpoint-backed `phase4:template-smoke` coverage when the current runner is still stub-backed
- claiming universal Windows reliability from a single verified local environment
- claiming support for remote machines or a different Windows-MCP endpoint without re-verification
- claiming support for ambiguous targets when the environment cannot confirm browser text, window identity, or delivery target
- claiming support for arbitrary desktop applications outside the browser/Codex/WeChat-like window set
- showing non-verified templates in the ordinary-user recommended product UI

## 3. Frozen Scorecard Semantics

The frozen Phase 5 scorecard vocabulary is the Phase 4 template-smoke summary vocabulary:

- `total_runs`: total scenario executions counted by the summary
- `pass`: verified scenario success
- `skip`: scenario intentionally not attempted because the environment could not safely support the flow
- `verification_failed`: template wrapper or nested verified-chain assertion failed
- `environment_unready`: the environment lacked safe prerequisites for the requested flow
- `transport_error`: endpoint or transport path failed before a trustworthy template outcome could be established
- `provider_error`: provider-backed execution failed outside template semantics
- `routing_failed`: the nested chain surfaced a routing failure
- `execution_failed`: the nested chain surfaced an execution failure
- `permission_blocked`: permission mode blocked required actions

Semantic rules:
- `pass` is the only success bucket.
- `environment_unready`, `transport_error`, `provider_error`, and `permission_blocked` do not count as support success.
- `routing_failed`, `execution_failed`, and `verification_failed` are regression-class failures, not support evidence.
- `skip` is allowed for environment-gated live smoke, but the current stub-backed `phase4:template-smoke` runner should normally not need it.
- `missing_dependency` may appear as live-smoke preflight output, but it is not part of the frozen template-smoke scorecard fields.

## 4. Exclusion Scope

Phase 5 does not claim support for:

- any template outside the five-template Phase 4 family
- any new runtime, orchestration, or multi-agent behavior
- non-Windows desktop environments
- read-only permission mode for live delivery flows
- arbitrary browser pages that do not expose stable extractable text
- ambiguous multi-instance desktop targets that cannot be confirmed by stable window identity
- desktop targets other than the current machine browser window, the local Codex window, or a WeChat-like chat window with stable identity
- remote machines or separately managed Windows sessions
- Windows-MCP endpoints other than the currently verified local endpoint
- endpoint-backed `phase4:template-smoke` execution beyond command-line compatibility for accepted flags
- generalized success-rate percentages detached from the current commands and environment assumptions

## 5. Environment Assumptions

The frozen support envelope assumes:

- the repository is run from `E:\compuser\compuser`
- live smoke uses the current reachable Windows-MCP endpoint for this machine, defaulting to `http://127.0.0.1:8010/mcp`
- the published claim endpoint must be read from the published scorecard artifact itself; if runtime defaults later move to a different local endpoint, product wording must not silently move with them until a new artifact is published
- permission mode for live delivery is not `read-only`
- browser-backed scenarios use a visible browser window with stable extractable text available at the time of execution
- Codex-targeted delivery refers to the local Codex desktop window on the current machine
- chat-targeted delivery refers only to a WeChat-like chat window with stable title or anchor evidence on the current machine
- multi-window scenarios have at least two distinct confirmable windows
- desktop delivery is safer when a dedicated editor or target window title is preserved instead of rediscovering a generic multi-instance target

Current verified environment note:
- the Phase 4 live-smoke lessons file records the earlier stabilization close
- the current published Phase 5 scorecard extends that evidence to `20` full suite runs / `100` total verified passes on the same Windows environment and the same local Windows-MCP endpoint
- the current published scorecard refresh was executed with `--per-run-timeout-ms 600000`, `--restart-windows-mcp-on-failure`, and `--desktop-reset-between-runs` so long-run desktop drift and transient live-smoke hangs are absorbed at the runner-control layer instead of being silently ignored
- the currently published artifact still points at `http://127.0.0.1:8010/mcp`; if runtime defaults later move again, product wording must not silently move with them until a new artifact is published

## 6. Product Publication Defaults

The current product-facing defaults are:

- scorecard JSON is published to `E:\compuser\compuser\artifacts\scorecard\phase5-latest.json`
- the local web panel default session id is `local-web-panel-session`
- the local web panel default port is `4317`

Release-prep product smoke should verify:

1. `/product/support-matrix`
2. `/product/scorecard-summary`
3. `/system/windows-mcp/status`
4. `/session/:id/state`
5. `/session/task`
6. scorecard artifact presence and basic shape
7. alignment between support matrix and recommended templates

## 7. Frozen Support Statement

Phase 5 freezes a truthful support statement for the current repository state:

- the five Phase 4 templates are the complete supported template family
- support is grounded in chain regression, repeatable template-smoke scorecards, and current-machine/current-endpoint live smoke
- the ordinary-user product claim is limited to browser, Codex, and WeChat-like chat windows on that current machine
- claims must stay conditional on the documented environment assumptions and exclusion scope
- stable login remains outside the autonomous claim surface until it can be verified without manual confirmation
- the currently published `phase5-latest.json` artifact satisfies the frozen claim gate, so the product surface may display a conservative `95%+ verified support` statement for this exact environment and support matrix
