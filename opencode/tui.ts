import type { TuiDialogStack, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { SessionInfo } from "../types.ts";
import { copyText } from "./contact.ts";
import { requestOpenCodeControl } from "./control.ts";

function activeSessionId(api: TuiPluginApi): string | undefined {
  if (api.route.current.name !== "session") return undefined;
  const sessionId = api.route.current.params.sessionID;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined;
}

function toastError(api: TuiPluginApi, message: string): void {
  api.ui.toast({ title: "Intercom", message, variant: "error", duration: 5000 });
}

async function withActiveSession(
  api: TuiPluginApi,
  action: (sessionId: string) => Promise<void>,
): Promise<void> {
  const sessionId = activeSessionId(api);
  if (!sessionId) {
    toastError(api, "Open a session before using Intercom.");
    return;
  }
  await action(sessionId);
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return typeof session.id === "string"
    && typeof session.cwd === "string"
    && typeof session.model === "string";
}

async function showIntercom(api: TuiPluginApi, dialog: TuiDialogStack): Promise<void> {
  await withActiveSession(api, async sessionId => {
    const response = await requestOpenCodeControl(sessionId, { type: "list" });
    if (!response.ok) {
      toastError(api, response.error ?? "Could not list intercom sessions.");
      return;
    }
    const sessions = Array.isArray(response.value) ? response.value.filter(isSessionInfo) : [];
    if (!sessions.length) {
      api.ui.toast({ title: "Intercom", message: "No other intercom sessions are connected.", variant: "info" });
      return;
    }

    dialog.setSize("large");
    dialog.replace(() => api.ui.DialogSelect<SessionInfo>({
      title: "Send an intercom message",
      placeholder: "Search sessions",
      options: sessions.map(session => ({
        title: session.name || session.id,
        value: session,
        description: `${session.id.slice(0, 8)} · ${session.model} · ${session.cwd}`,
        footer: session.status || "idle",
      })),
      onSelect(option) {
        const target = option.value;
        dialog.replace(() => api.ui.DialogPrompt({
          title: `Message ${target.name || target.id}`,
          placeholder: "Type a message",
          onCancel: () => dialog.clear(),
          onConfirm: async message => {
            const text = message.trim();
            if (!text) return;
            dialog.clear();
            const sent = await requestOpenCodeControl(
              sessionId,
              { type: "send", to: target.id, message: text },
              12_000,
            );
            if (!sent.ok) {
              toastError(api, sent.error ?? `Could not send to ${target.name || target.id}.`);
              return;
            }
            api.ui.toast({
              title: "Intercom",
              message: `Message sent to ${target.name || target.id}.`,
              variant: "success",
              duration: 4000,
            });
          },
        }));
      },
    }));
  });
}

async function copyIntercomId(api: TuiPluginApi): Promise<void> {
  await withActiveSession(api, async sessionId => {
    const response = await requestOpenCodeControl(sessionId, { type: "whoami" });
    if (!response.ok || !response.value || typeof response.value !== "object") {
      toastError(api, response.error ?? "Could not read this session's intercom ID.");
      return;
    }
    const id = (response.value as { sessionId?: unknown }).sessionId;
    if (typeof id !== "string" || !id) {
      toastError(api, "The server plugin returned an invalid intercom ID.");
      return;
    }
    const contact = `Intercom send ID: ${id}`;
    api.ui.toast({
      title: "Intercom",
      message: copyText(contact) ? `Copied: ${contact}` : contact,
      variant: "success",
      duration: 5000,
    });
  });
}

const module: TuiPluginModule = {
  id: "opencode-intercom",
  tui: async api => {
    api.command?.register(() => [
      {
        title: "Send an intercom message",
        value: "intercom.send",
        description: "Choose a local agent and send it a message",
        category: "Intercom",
        keybind: "alt+m",
        slash: { name: "intercom" },
        onSelect: dialog => showIntercom(api, dialog ?? api.ui.dialog),
      },
      {
        title: "Copy intercom ID",
        value: "intercom.id.copy",
        description: "Copy this OpenCode session's stable intercom target",
        category: "Intercom",
        keybind: "alt+i",
        slash: { name: "intercom-id", aliases: ["intercom-contact"] },
        onSelect: () => copyIntercomId(api),
      },
    ]);
  },
};

export default module;
