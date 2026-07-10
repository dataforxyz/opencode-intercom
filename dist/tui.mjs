// opencode/contact.ts
import { spawnSync } from "node:child_process";

// opencode/runtime.ts
import { randomUUID, createHash } from "crypto";
import { basename } from "path";
import { cwd as processCwd } from "process";

// broker/framing.ts
var MAX_FRAME_BYTES = 1024 * 1024;

// broker/paths.ts
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";
function getAgentDirPath(env = process.env, homeDir = homedir(), cwd = process.cwd()) {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    return join(homeDir, ".pi/agent");
  }
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}
function getIntercomDirPath(agentDir = getAgentDirPath()) {
  return join(agentDir, "intercom");
}

// broker/spawn.ts
import { join as join2, dirname } from "path";
import { fileURLToPath } from "url";
var INTERCOM_DIR = getIntercomDirPath();
var EXTENSION_DIR = join2(dirname(fileURLToPath(import.meta.url)), "..");
var BROKER_PID = join2(INTERCOM_DIR, "broker.pid");
var BROKER_SPAWN_LOCK = join2(INTERCOM_DIR, "broker.spawn.lock");

// config.ts
var DEFAULT_ASK_TIMEOUT_MS = 45 * 1e3;
var MAX_ASK_TIMEOUT_MS = 120 * 1e3;

// opencode/runtime.ts
function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
function buildOpenCodeRuntimeIdentity(env = process.env, cwd = env.PWD || processCwd(), pid = process.pid) {
  const sessionId = env.OPENCODE_INTERCOM_SESSION_ID?.trim() || env.OPENCODE_SESSION_ID?.trim() || `opencode-${pid}-${shortHash(cwd)}`;
  const cwdName = basename(cwd) || "workspace";
  const name = env.OPENCODE_INTERCOM_NAME?.trim() || env.OPENCODE_PEER_NAME?.trim() || `opencode-${cwdName}-${pid}`;
  return {
    sessionId,
    name,
    cwd,
    model: env.OPENCODE_INTERCOM_MODEL?.trim() || env.OPENCODE_MODEL?.trim() || "opencode",
    startedAt: Date.now()
  };
}

// opencode/contact.ts
function intercomContactText() {
  const identity = buildOpenCodeRuntimeIdentity();
  return `intercom send ID: ${identity.sessionId}`;
}
function copyText(text, platform = process.platform) {
  const candidates = platform === "darwin" ? [["pbcopy", []]] : platform === "win32" ? [["clip.exe", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  return candidates.some(([command, args]) => {
    const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    return result.status === 0;
  });
}

// opencode/tui.ts
var module = {
  id: "opencode-intercom-contact",
  tui: async (api) => {
    api.command?.register(() => [{
      title: "Copy intercom contact",
      value: "intercom.contact.copy",
      description: "Copy this OpenCode session's stable intercom target",
      category: "Intercom",
      keybind: "alt+i",
      slash: { name: "intercom-contact" },
      onSelect: () => {
        const contact = intercomContactText();
        api.ui.toast({
          title: "Intercom",
          message: copyText(contact) ? `Copied: ${contact}` : contact,
          variant: "success",
          duration: 5e3
        });
      }
    }]);
  }
};
var tui_default = module;
export {
  tui_default as default
};
