# Changelog

## Unreleased

- Queue and acknowledge inbound messages before long headless model turns, using `session.promptAsync` for both idle and busy server sessions.
- Support persistent `opencode serve` peers without broker delivery timeouts disconnecting otherwise healthy receivers.

## 0.2.0

- Upgrade the shared broker/client transport to strict intercom protocol v3.
- Add receiver acknowledgements and sender delivery IDs.
- Add durable sender outbox replay and incompatible-broker replacement.
- Add broker-confirmed ask defer/cancel behavior and late-reply support.
- Add the optional OpenCode TUI entry with Alt+I contact copying.
