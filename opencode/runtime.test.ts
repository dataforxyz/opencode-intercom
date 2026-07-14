import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeIntercomRuntime } from "./runtime.ts";

test("inbound delivery is acknowledged when queued, before model injection completes", async () => {
  let finishInjection!: () => void;
  const injection = new Promise<void>((resolve) => { finishInjection = resolve; });
  const runtime = new OpenCodeIntercomRuntime(
    { sessionId: "receiver", name: "receiver", cwd: "/repo", model: "test", startedAt: 1 },
    "/repo",
    async () => injection,
  );
  const acknowledgements: string[] = [];
  (runtime as any).client = {
    acknowledgeMessage(deliveryId: string) {
      acknowledgements.push(deliveryId);
      return true;
    },
  };

  (runtime as any).handleIncomingMessage(
    { id: "sender", name: "sender", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
    { id: "message-1", content: { text: "hello" }, timestamp: 1 },
    "delivery-1",
  );

  assert.deepEqual(acknowledgements, ["delivery-1"]);
  finishInjection();
  await injection;
});
