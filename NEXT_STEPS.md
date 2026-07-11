# Next Steps

## 1. Build

```bash
cd /home/dxyz/src/github.com/dataforxyz/agent-intercom-opencode
npm run build
```

## 2. Start A Long-Lived OpenCode Receiver

```bash
OPENCODE_INTERCOM_DEBUG=1 \
OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","plugin":["/home/dxyz/src/github.com/dataforxyz/agent-intercom-opencode/dist/plugin.mjs"],"permission":{"bash":"allow"}}' \
OPENCODE_INTERCOM_NAME=opencode-live-test \
OPENCODE_INTERCOM_SESSION_ID=opencode-live-test \
opencode run --auto --format json "Run bash command sleep 120. Then output done. Do not call any intercom tools."
```

`OPENCODE_INTERCOM_DEBUG=1` is optional but useful while validating. It writes
inject-path diagnostics to `/tmp/intercom-inject.log`.

## 3. Confirm It Registered From Pi

```bash
PI_INTERCOM_SESSION_ID=pi-list-test \
pi --no-extensions --extension /home/dxyz/src/github.com/dataforxyz/agent-intercom-pi/index.ts --no-skills --mode json --print "Use the intercom tool with action list once. Output only the tool result."
```

Look for `opencode-live-test` in the session list.

## 4. Send From Pi To OpenCode

```bash
PI_INTERCOM_SESSION_ID=pi-send-test \
pi --no-extensions --extension /home/dxyz/src/github.com/dataforxyz/agent-intercom-pi/index.ts --no-skills --mode json --print "Use the intercom tool with action send to send this exact message to opencode-live-test: hello from pi live test. Output only the tool result."
```

## 5. Verify OpenCode Received It

Use one or more of these:

```bash
opencode export <session-id>
```

Check the long-lived receiver output/log for:

- injected prompt text
- a new turn triggered from the prompt
- exactly one injected inbound prompt turn for that message

Expected proven run-mode behavior now:

- if the receiver is busy, the plugin uses `session.promptAsync`
- `/tmp/intercom-inject.log` should show that path with HTTP `204`
- `opencode export <session-id>` should later show the inbound prompt as a new
  user message after the original `sleep` turn finishes
- the inbound prompt should appear exactly once

## 6. Verify Reply Back To Pi

From an OpenCode session with the plugin loaded:

```text
Use intercom_pending.
If the Pi message expects a reply, use intercom_reply.
Otherwise use intercom_send to send a message back to pi-send-test.
```

## 7. Inspect The Debug Log

```bash
cat /tmp/intercom-inject.log
```

Look for one of these delivery paths:

- `message.delivered` with path `session.promptAsync`
- `message.delivered` with path `queue.flush.prompt`

There should not be duplicate delivery records for the same `messageID`.

## 8. Interactive TUI Follow-Up

Goal:
validate the visible UX in a real OpenCode TUI now that headless run-mode wake
is proven.

What to confirm:

- incoming toast appears
- prompt text is appended visibly
- submitted turn starts automatically
- reply can be sent back with `intercom_reply` or `intercom_send`
