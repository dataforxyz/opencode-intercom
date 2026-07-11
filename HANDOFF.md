# OpenCode Intercom Handoff

## Repo

`/home/dxyz/src/github.com/dataforxyz/agent-intercom-opencode`

## Current State

The package exists and builds.

Important files:

- `opencode/plugin.ts`
- `opencode/runtime.ts`
- `README.md`
- `PLAN.md`
- `NEXT_STEPS.md`

Package status:

- `npm run build` passes
- `npm test` passes (27 broker tests)

## What Is Implemented

OpenCode-native plugin tools:

- `intercom_whoami`
- `intercom_status`
- `intercom_list`
- `intercom_set_summary`
- `intercom_send`
- `intercom_ask`
- `intercom_pending`
- `intercom_reply`

Shared broker protocol:

- vendored from the existing intercom repos
- interoperates with Pi/Codex/Claude protocol

Inbound handling:

- plugin now auto-connects to broker on startup
- inbound messages queue in runtime memory
- inbound injection now has a proven headless run-mode path:
  - show toast
  - if real TUI is present, try `appendPrompt` + `submitPrompt`
  - if the session is busy, use `session.promptAsync(...)` as the primary path
  - if busy-path delivery was not confirmed, queue and flush on `session.idle`
  - delivered message IDs are tracked so a message is injected at most once
- plugin disconnects in `dispose`

## Important Code Facts

### `opencode/plugin.ts`

- `runtime.connect()` is now called immediately on plugin startup
- `activeSessionID` now has three sources:
  1. `OPENCODE_SESSION_ID` if present
  2. plugin tool/event context
  3. fallback lookup of the newest OpenCode session in the current directory
- debug logging is gated behind `OPENCODE_INTERCOM_DEBUG=1` and writes to
  `/tmp/intercom-inject.log`
- `injectInbound()` currently:
  1. shows toast
  2. uses TUI append/submit only when running with a real TTY
  3. for busy sessions in headless/run mode, calls `session.promptAsync`
  4. if that path does not confirm delivery, keeps a fallback queue
  5. flushes queued fallback messages with `session.prompt` on `session.idle`
  6. marks delivered message IDs so the same inbound message cannot inject twice

### `opencode/runtime.ts`

- `OpenCodeIntercomRuntime` accepts `onInboundMessage`
- incoming broker messages call that hook
- runtime still supports queued fallback via `intercom_pending`

## What Has Been Proven

### Proven

- real `opencode run` loads the plugin
- real `pi --print` loads `pi-intercom`
- OpenCode tool calls work
- Pi tool calls work
- OpenCode can register on startup without calling an intercom tool first

Strong proof:

A fresh OpenCode receiver that did not call any intercom tool appeared in Pi's
`intercom list` as `opencode-auto-listen-smoke`.

That proves startup registration/listening works.

## What Is Proven Now

Run-mode wake after idle is now proven end-to-end.

Specifically proven:

1. Pi sends to a live long-lived OpenCode receiver while its original turn is
   still busy.
2. `session.promptAsync` receives the busy-time delivery attempt.
3. The receiver completes its original `sleep` turn.
4. The inbound prompt appears in `opencode export` as a real new user turn.
5. The receiver produces exactly one injected inbound prompt turn for that
   message.

Strong proof:

- `/tmp/intercom-inject.log` showed:
  - `inject.promptAsync` with HTTP `204`
  - `message.delivered` with path `session.promptAsync`
- `opencode export` for the verified receiver session contained exactly one
  inbound user message:
  - `Incoming intercom message from subagent-chat-019f3fe5 ... exactly once proof from pi`

That proves headless `opencode run` wake/injection can work.

## Key Findings

Important behavior discovered during debugging:

- In headless `opencode run`, `tui.appendPrompt` / `tui.submitPrompt` can return
  success without creating a durable exported turn.
- For headless busy sessions, `session.promptAsync` is the correct primary path.
- Queue-on-busy plus idle-flush is still useful as a fallback, but it must not
  run for messages already confirmed delivered.
- Delivered message IDs must be tracked to prevent double-injection.

## Why Previous Test Went Sideways

This was not always a plugin bug.

At least one failed send was because the target session had already exited:

- Pi tried to send to `opencode-auto-listen-smoke`
- broker returned `Session not found`

So some failures were just bad timing with short-lived `opencode run`
receivers.

Also, the previous assistant repeatedly issued empty `bash` calls. Ignore that;
it was not evidence about the plugin.

## Best Next Tests

The most important run-mode proof is done. Remaining validation is now about UX
and cleanup, not core feasibility.

### Receiver

Start a long-lived OpenCode run with plugin loaded and no intercom tool call
required:

```bash
OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","plugin":["/home/dxyz/src/github.com/dataforxyz/agent-intercom-opencode/dist/plugin.mjs"],"permission":{"bash":"allow"}}' \
OPENCODE_INTERCOM_NAME=opencode-live-test \
OPENCODE_INTERCOM_SESSION_ID=opencode-live-test \
opencode run --auto --format json "Run bash command sleep 120. Then output done. Do not call any intercom tools."
```

### Confirm It Registered

From Pi or any intercom-capable session, list sessions and confirm
`opencode-live-test` is present before sending.

### Send From Pi

Use real Pi intercom send while receiver is definitely still alive.

### What To Inspect

Useful things to validate next:

- interactive TUI UX: toast + visible prompt append + auto-submit
- reply flow from injected context with `intercom_reply` / `intercom_send`
- whether any edge cases still need fallback flush if `promptAsync` fails

Useful commands:

- `opencode export <sessionID>`
- inspect the long-lived receiver's JSON event stream/log
- if needed, use `intercom_pending` inside the same OpenCode session to
  separate "received but not injected" from "not received"

## Remaining Gaps

The main remaining gap is not core wakeup anymore. It is polish / broader UX:

- verify the same behavior in a real interactive OpenCode TUI
- verify reply-back flow from the injected turn
- keep an eye on whether any provider/model combination behaves differently from
  the verified `claude-fable-5` run-mode proof

## Bottom Line

Current status is:

- protocol: working
- startup registration: working
- queueing: working
- headless run-mode wake after idle: working and proven
- exactly-once delivery for the verified busy-time `promptAsync` path: working
- interactive TUI wake/reply UX: still worth validating
