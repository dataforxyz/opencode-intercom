import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestOpenCodeControl, startOpenCodeControlServer } from "./control.ts";

test("TUI control requests are handled by the matching OpenCode server session", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "opencode-intercom-control-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const stop = startOpenCodeControlServer({
    acceptsSession: sessionId => sessionId === "session-1",
    handle: async action => action.type === "whoami" ? { sessionId: "intercom-1" } : null,
  });
  try {
    const response = await requestOpenCodeControl("session-1", { type: "whoami" }, 1000);
    assert.deepEqual(response, { ok: true, value: { sessionId: "intercom-1" } });
  } finally {
    stop();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
