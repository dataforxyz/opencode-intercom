import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOpenCodeControlServer, type OpenCodeControlAction } from "./control.ts";
import tuiModule from "./tui.ts";

test("TUI registers native commands and sends through the server-owned control bridge", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "opencode-intercom-tui-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handled: OpenCodeControlAction[] = [];
  const stop = startOpenCodeControlServer({
    acceptsSession: sessionId => sessionId === "host-session",
    async handle(action) {
      handled.push(action);
      if (action.type === "list") {
        return [{ id: "peer-1", name: "Peer", cwd: "/tmp/project", model: "pi", pid: 1, startedAt: 1, lastActivity: 1 }];
      }
      return { ok: true };
    },
  });

  let commands: any[] = [];
  let rendered: any;
  const toasts: any[] = [];
  const dialog = {
    setSize() {},
    clear() {},
    replace(render: () => unknown) { rendered = render(); },
  };
  const api: any = {
    route: { current: { name: "session", params: { sessionID: "host-session" } } },
    command: { register(callback: () => any[]) { commands = callback(); } },
    ui: {
      dialog,
      DialogSelect(props: unknown) { return { kind: "select", props }; },
      DialogPrompt(props: unknown) { return { kind: "prompt", props }; },
      toast(input: unknown) { toasts.push(input); },
    },
  };

  try {
    await tuiModule.tui(api, undefined, {} as never);
    assert.equal(commands[0].slash.name, "intercom");
    assert.equal(commands[0].keybind, "alt+m");
    assert.equal(commands[1].slash.name, "intercom-id");
    assert.equal(commands[1].keybind, "alt+i");

    await commands[0].onSelect(dialog);
    assert.equal(rendered.kind, "select");
    rendered.props.onSelect(rendered.props.options[0]);
    assert.equal(rendered.kind, "prompt");
    await rendered.props.onConfirm("hello from OpenCode");

    assert.deepEqual(handled, [
      { type: "list" },
      { type: "send", to: "peer-1", message: "hello from OpenCode" },
    ]);
    assert.match(toasts.at(-1).message, /Message sent to Peer/);
  } finally {
    stop();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
