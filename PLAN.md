# OpenCode Intercom Implementation Plan

## Goal

Build an OpenCode-native intercom that interoperates with `pi-intercom`,
`codex-intercom`, and `claude-intercom`, without starting with MCP or a full
background-worker system.

## Best First Architecture

Use an OpenCode plugin as the primary integration point.

- OpenCode plugins can define native custom tools, so MCP is unnecessary for the
  first cut.
- The plugin can register the current OpenCode session with the existing local
  broker and expose the same tool names other agents already know.
- The broker protocol stays unchanged: length-prefixed JSON over a local socket
  under `~/.pi/agent/intercom` by default.
- This preserves cross-agent compatibility while avoiding OpenCode-specific
  orchestration decisions too early.

## Phase 1: Message Protocol Only

Implemented in this checkout as the starting point.

- Vendor the shared broker/client/framing/socket path code.
- Register an OpenCode session lazily on first intercom tool call.
- Expose native OpenCode tools:
  `intercom_whoami`, `intercom_status`, `intercom_list`,
  `intercom_set_summary`, `intercom_send`, `intercom_ask`,
  `intercom_pending`, and `intercom_reply`.
- Queue inbound messages in plugin memory.
- Track unresolved inbound asks so OpenCode can reply with `intercom_reply`.
- Inject inbound messages into OpenCode best-effort: show a TUI toast, append and
  submit the active prompt when a TUI is present, and fall back to session prompt
  enqueueing when only an active session id is known.
- Use OpenCode env vars for identity:
  `OPENCODE_INTERCOM_NAME`, `OPENCODE_INTERCOM_SESSION_ID`, and
  `OPENCODE_INTERCOM_MODEL`.

## Phase 2: Better OpenCode Session Integration

- Improve identity detection if OpenCode exposes stable session ids through the
  plugin context or SDK client.
- Publish richer status from OpenCode events when the event payload is stable.
- Verify inbound TUI append/submit behavior in a long-lived interactive OpenCode
  TUI. The non-interactive `opencode run` path receives and queues messages, but
  does not stream prompts injected after the original run starts.
- Add tests around plugin tool behavior with a mocked runtime.

## Phase 3: Background And Subagent Control

Add this only after Phase 1 is reliable.

- Evaluate `opencode-agent-intercom` for direct subagent message injection,
  status, and abort primitives.
- Evaluate `opencode-background-agents` and `opencode-orchestrator` for longer
  running wakeable-worker behavior.
- Decide whether OpenCode workers should be daemon-managed like Claude `cci`, or
  native subagent-managed through OpenCode's plugin/subagent APIs.
- Keep the wire protocol compatible even if OpenCode gets richer local control.

## Phase 4: Packaging

- Publish as `opencode-intercom` once the plugin API shape is verified against a
  real OpenCode session.
- Keep MCP out unless a concrete use case appears that native OpenCode tools do
  not cover.
- Add a small skill/command later only if it improves model behavior; do not make
  the first version depend on extra prompt surface.

## Open Questions

- Does OpenCode expose a stable current session id to plugins? If yes, prefer it
  over the current env/id fallback.
- Should inbound messages trigger a visible prompt append, a toast, or remain
  pull-based through `intercom_pending`?
- Should the initial npm package depend on `@opencode-ai/plugin`, or rely on
  OpenCode providing it at runtime? The current package declares the dependency
  and bundles everything else.
