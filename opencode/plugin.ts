import { appendFileSync } from "fs";
import { tool, type Plugin } from "@opencode-ai/plugin";
import { OpenCodeIntercomRuntime, formatAttachments, type PendingInboundMessage } from "./runtime.ts";
import { validateAskTimeoutMs } from "../config.ts";

const INJECT_LOG_PATH = "/tmp/intercom-inject.log";

interface PendingInjectEntry {
  entry: PendingInboundMessage;
}

function resultText(result: { content: Array<{ type: "text"; text: string }>; isError?: boolean }): string {
  const text = result.content.map(part => part.text).join("\n");
  if (result.isError) {
    throw new Error(text);
  }
  return text;
}

function listScope(value: string | undefined): "machine" | "directory" | "repo" {
  if (value === undefined) return "machine";
  if (value === "machine" || value === "directory" || value === "repo") return value;
  throw new Error('scope must be one of "machine", "directory", or "repo"');
}

export const OpenCodeIntercomPlugin: Plugin = async ({ client, directory }) => {
  let activeSessionID = process.env.OPENCODE_SESSION_ID?.trim() || undefined;
  let activeSessionStatus = "idle";
  let flushingInjectQueue = false;
  const pendingInjectQueue: PendingInjectEntry[] = [];
  const deliveredMessageIDs = new Set<string>();
  const canUseTuiInjection = Boolean(process.stdin.isTTY || process.stdout.isTTY);
  const debugInject = process.env.OPENCODE_INTERCOM_DEBUG === "1";

  function logInject(step: string, details: Record<string, unknown>): void {
    if (!debugInject) {
      return;
    }
    try {
      appendFileSync(INJECT_LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), step, ...details })}\n`);
    } catch {
      // Ignore logging failures to avoid breaking message delivery.
    }
  }

  function formatError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      };
    }
    return { value: error };
  }

  async function logResult(step: string, result: {
    data?: unknown;
    error?: unknown;
    response?: Response;
  }, details: Record<string, unknown> = {}): Promise<void> {
    const responseBody = result.response
      ? await result.response.clone().text().catch(() => undefined)
      : undefined;
    logInject(step, {
      ...details,
      ok: result.error === undefined,
      status: result.response?.status,
      data: result.data,
      error: result.error,
      responseBody,
    });
  }

  function setActiveSession(sessionID: unknown): void {
    if (typeof sessionID === "string" && sessionID.trim()) {
      activeSessionID = sessionID;
    }
  }

  function formatInboundPrompt(entry: PendingInboundMessage): string {
    const from = entry.from.name || entry.from.id;
    const replyHint = entry.message.expectsReply
      ? `\n\nThis message expects a reply. Use intercom_reply with reply_to "${entry.message.id}" after you respond.`
      : "";
    return [
      `Incoming intercom message from ${from} (${entry.from.model}, ${entry.from.cwd}):`,
      "",
      entry.message.content.text + formatAttachments(entry.message.content.attachments),
      replyHint,
    ].join("\n");
  }

  async function resolveActiveSessionID(): Promise<string | undefined> {
    if (activeSessionID) {
      return activeSessionID;
    }

    const sessionList = await client.session.list({ query: { directory } }).catch((error) => {
      logInject("session.list.error", { error: formatError(error) });
      return undefined;
    });
    if (sessionList) {
      await logResult("session.list", sessionList);
    }
    const sessions = sessionList?.data;
    if (!sessions?.length) {
      return undefined;
    }

    const latestSession = sessions.reduce((latest, session) => {
      if (session.time.created > latest.time.created) {
        return session;
      }
      if (session.time.created === latest.time.created && session.time.updated > latest.time.updated) {
        return session;
      }
      return latest;
    });
    setActiveSession(latestSession.id);
    logInject("session.resolve", { sessionID: latestSession.id, sessionCount: sessions.length });
    return latestSession.id;
  }

  function enqueuePendingInject(entry: PendingInboundMessage, reason: string): void {
    if (deliveredMessageIDs.has(entry.message.id)) {
      logInject("queue.skip_delivered", { reason, messageID: entry.message.id });
      return;
    }
    if (pendingInjectQueue.some((queued) => queued.entry.message.id === entry.message.id)) {
      logInject("queue.skip_duplicate", { reason, messageID: entry.message.id });
      return;
    }
    pendingInjectQueue.push({ entry });
    logInject("queue.enqueue", { reason, messageID: entry.message.id, queueLength: pendingInjectQueue.length });
  }

  function markDelivered(messageID: string, path: string): void {
    deliveredMessageIDs.add(messageID);
    const queueIndex = pendingInjectQueue.findIndex((queued) => queued.entry.message.id === messageID);
    if (queueIndex >= 0) {
      pendingInjectQueue.splice(queueIndex, 1);
    }
    logInject("message.delivered", { messageID, path, queueLength: pendingInjectQueue.length });
  }

  async function flushPendingInjectQueue(trigger: string): Promise<void> {
    if (flushingInjectQueue || !pendingInjectQueue.length) {
      return;
    }

    const sessionID = await resolveActiveSessionID();
    if (!sessionID) {
      logInject("queue.flush.skip", { trigger, reason: "no_session_id", queueLength: pendingInjectQueue.length });
      return;
    }

    flushingInjectQueue = true;
    logInject("queue.flush.start", { trigger, sessionID, queueLength: pendingInjectQueue.length });
    try {
      while (pendingInjectQueue.length) {
        const queued = pendingInjectQueue[0];
        const entry = queued.entry;
        if (deliveredMessageIDs.has(entry.message.id)) {
          pendingInjectQueue.shift();
          logInject("queue.flush.skip_delivered", { trigger, messageID: entry.message.id });
          continue;
        }
        const prompt = formatInboundPrompt(entry);
        let result;
        try {
          result = await client.session.prompt({
            path: { id: sessionID },
            query: { directory },
            body: {
              parts: [{ type: "text", text: prompt }],
            },
          });
        } catch (error) {
          logInject("queue.flush.prompt.throw", {
            trigger,
            sessionID,
            messageID: entry.message.id,
            error: formatError(error),
          });
          break;
        }

        await logResult("queue.flush.prompt", result, {
          trigger,
          sessionID,
          messageID: entry.message.id,
        });
        if (result.error !== undefined) {
          break;
        }
        markDelivered(entry.message.id, "queue.flush.prompt");
      }
    } finally {
      logInject("queue.flush.end", { trigger, remaining: pendingInjectQueue.length });
      flushingInjectQueue = false;
    }
  }

  async function injectInbound(entry: PendingInboundMessage): Promise<void> {
    const from = entry.from.name || entry.from.id;
    const prompt = formatInboundPrompt(entry);
    if (deliveredMessageIDs.has(entry.message.id)) {
      logInject("inject.skip_delivered", { messageID: entry.message.id });
      return;
    }
    const busy = activeSessionStatus !== "idle";
    logInject("inject.start", {
      messageID: entry.message.id,
      from,
      activeSessionID,
      activeSessionStatus,
    });

    if (busy) {
      // In opencode run, append/submit may report success without creating a
      // durable follow-up turn, so keep an idle-flush fallback queued.
      enqueuePendingInject(entry, "session_busy_pre_tui");
    }

    logInject("inject.mode", {
      messageID: entry.message.id,
      canUseTuiInjection,
      busy,
    });

    try {
      const toastResult = await client.tui.showToast({
        body: {
          title: `Intercom from ${from}`,
          message: entry.message.content.text.slice(0, 240),
          variant: entry.message.expectsReply ? "warning" : "info",
          duration: 8000,
        },
        query: { directory },
      });
      await logResult("inject.toast", toastResult, { messageID: entry.message.id });
    } catch (error) {
      logInject("inject.toast.throw", { messageID: entry.message.id, error: formatError(error) });
    }

    if (canUseTuiInjection) {
      try {
        const appended = await client.tui.appendPrompt({
          body: { text: prompt },
          query: { directory },
        });
        await logResult("inject.append", appended, { messageID: entry.message.id });
        if (appended.data === true) {
          try {
            const submitResult = await client.tui.submitPrompt({ query: { directory } });
            await logResult("inject.submit", submitResult, { messageID: entry.message.id });
            if (!busy) {
              markDelivered(entry.message.id, "tui.submit");
              return;
            }
          } catch (error) {
            logInject("inject.submit.throw", { messageID: entry.message.id, error: formatError(error) });
          }
        }
      } catch (error) {
        logInject("inject.append.throw", { messageID: entry.message.id, error: formatError(error) });
      }
    } else {
      logInject("inject.tui_skipped", { messageID: entry.message.id, reason: "headless" });
    }

    const sessionID = await resolveActiveSessionID();
    if (!sessionID) {
      logInject("inject.no_session", { messageID: entry.message.id });
      return;
    }

    logInject("inject.session_target", {
      messageID: entry.message.id,
      sessionID,
      activeSessionStatus,
      busy,
    });

    if (busy) {
      try {
        const asyncResult = await client.session.promptAsync({
          path: { id: sessionID },
          query: { directory },
          body: {
            parts: [{ type: "text", text: prompt }],
          },
        });
        await logResult("inject.promptAsync", asyncResult, { messageID: entry.message.id, sessionID });
        if (asyncResult.error === undefined && asyncResult.response?.ok) {
          markDelivered(entry.message.id, "session.promptAsync");
        }
      } catch (error) {
        logInject("inject.promptAsync.throw", {
          messageID: entry.message.id,
          sessionID,
          error: formatError(error),
        });
      }
      return;
    }

    try {
      const promptResult = await client.session.prompt({
        path: { id: sessionID },
        query: { directory },
        body: {
          parts: [{ type: "text", text: prompt }],
        },
      });
      await logResult("inject.prompt", promptResult, { messageID: entry.message.id, sessionID });
      if (promptResult.error !== undefined) {
        enqueuePendingInject(entry, "prompt_error");
      } else if (promptResult.response?.ok) {
        markDelivered(entry.message.id, "session.prompt");
      }
    } catch (error) {
      logInject("inject.prompt.throw", {
        messageID: entry.message.id,
        sessionID,
        error: formatError(error),
      });
      enqueuePendingInject(entry, "prompt_throw");
    }
  }

  const runtime = new OpenCodeIntercomRuntime(undefined, directory, injectInbound);
  void runtime.connect().catch((error) => {
    console.error("Failed to start OpenCode intercom listener:", error);
  });

  return {
    dispose: async () => {
      await runtime.disconnect();
    },

    tool: {
      intercom_whoami: tool({
        description: "Show this OpenCode session's intercom identity.",
        args: {},
        async execute(_args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.whoami());
        },
      }),

      intercom_status: tool({
        description: "Show local intercom connection status and pending message counts.",
        args: {},
        async execute(_args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.status());
        },
      }),

      intercom_list: tool({
        description: "List local Pi, Codex, Claude, and OpenCode intercom sessions.",
        args: {
          scope: tool.schema.string().optional().describe('Filter sessions: "machine", "directory", or "repo".'),
          include_self: tool.schema.boolean().optional().describe("Include this OpenCode session in the result."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.list(listScope(args.scope), args.include_self ?? false));
        },
      }),

      intercom_set_summary: tool({
        description: "Publish a short discoverable status for this OpenCode session.",
        args: {
          summary: tool.schema.string().describe("Short status shown to other intercom sessions."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.setSummary(args.summary));
        },
      }),

      intercom_send: tool({
        description: "Send a non-blocking message to another local intercom session.",
        args: {
          to: tool.schema.string().describe("Target session name, id, or unique id prefix."),
          message: tool.schema.string().describe("Message text to send."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.send(args.to, args.message));
        },
      }),

      intercom_ask: tool({
        description: "Ask another local intercom session a blocking question and wait briefly for a reply.",
        args: {
          to: tool.schema.string().describe("Target session name, id, or unique id prefix."),
          message: tool.schema.string().describe("Question text to send."),
          timeout_ms: tool.schema.number().optional().describe("Reply timeout in milliseconds, max 120000."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          const timeoutMs = args.timeout_ms === undefined
            ? undefined
            : validateAskTimeoutMs(args.timeout_ms);
          return resultText(await runtime.ask(args.to, args.message, undefined, timeoutMs));
        },
      }),

      intercom_pending: tool({
        description: "Read queued inbound intercom messages and unresolved asks.",
        args: {
          mark_read: tool.schema.boolean().optional().describe("Mark unread messages as read after returning them."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.pending(args.mark_read ?? false));
        },
      }),

      intercom_reply: tool({
        description: "Reply to a pending inbound intercom ask.",
        args: {
          message: tool.schema.string().describe("Reply text."),
          to: tool.schema.string().optional().describe("Optional sender name/id if there are multiple pending asks."),
          reply_to: tool.schema.string().optional().describe("Optional message id from intercom_pending."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.reply(args.message, args.to, args.reply_to));
        },
      }),
    },

    event: async ({ event }) => {
      const properties = (event as { properties?: Record<string, unknown> }).properties;
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = properties?.info as { id?: unknown } | undefined;
        setActiveSession(info?.id);
      } else {
        setActiveSession(properties?.sessionID);
      }

      if (event.type === "session.idle") {
        activeSessionStatus = "idle";
        await runtime.setSummary("idle");
        await flushPendingInjectQueue("session.idle");
      } else if (event.type === "session.status") {
        const status = typeof properties?.status === "string" ? properties.status : "active";
        activeSessionStatus = status;
        await runtime.setSummary(status);
      }
    },
  };
};

export default OpenCodeIntercomPlugin;
