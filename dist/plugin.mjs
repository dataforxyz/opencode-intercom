// opencode/plugin.ts
import { appendFileSync } from "fs";
import { tool } from "@opencode-ai/plugin";

// opencode/runtime.ts
import { randomUUID as randomUUID2, createHash } from "crypto";
import { spawnSync } from "child_process";
import { basename } from "path";
import { cwd as processCwd } from "process";

// broker/client.ts
import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";

// broker/framing.ts
var MAX_FRAME_BYTES = 1024 * 1024;
function writeMessage(socket, msg) {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}
function createMessageReader(onMessage, onError, maxFrameBytes = MAX_FRAME_BYTES) {
  let buffer = Buffer.alloc(0);
  function reportMessage(payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf-8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error }));
      return false;
    }
    try {
      onMessage(msg);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error }));
      return false;
    }
  }
  return (data) => {
    let remaining = data;
    while (remaining.length > 0) {
      if (buffer.length < 4) {
        const headerBytes = Math.min(4 - buffer.length, remaining.length);
        buffer = Buffer.concat([buffer, remaining.subarray(0, headerBytes)]);
        remaining = remaining.subarray(headerBytes);
        if (buffer.length < 4) {
          return;
        }
      }
      const length = buffer.readUInt32BE(0);
      if (length > maxFrameBytes) {
        buffer = Buffer.alloc(0);
        onError(new Error(`Intercom frame length ${length} exceeds maximum ${maxFrameBytes} bytes`));
        return;
      }
      const missingPayloadBytes = length - Math.max(0, buffer.length - 4);
      const payloadBytes = Math.min(missingPayloadBytes, remaining.length);
      if (payloadBytes > 0) {
        buffer = Buffer.concat([buffer, remaining.subarray(0, payloadBytes)]);
        remaining = remaining.subarray(payloadBytes);
      }
      if (buffer.length < 4 + length) {
        return;
      }
      const payload = buffer.subarray(4, 4 + length);
      buffer = Buffer.alloc(0);
      if (!reportMessage(payload)) {
        return;
      }
    }
  };
}

// broker/paths.ts
import { chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var INTERCOM_DIR_MODE = 448;
var INTERCOM_RUNTIME_FILE_MODE = 384;
function sanitizePipeSegment(value) {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
}
function getIntercomDirPath(homeDir = homedir()) {
  return join(homeDir, ".pi/agent/intercom");
}
function getBrokerSocketPath(platform = process.platform, homeDir = homedir()) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(homeDir)}`;
  }
  return join(getIntercomDirPath(homeDir), "broker.sock");
}
function ensureIntercomRuntimeDir(intercomDir = getIntercomDirPath(), platform = process.platform) {
  mkdirSync(intercomDir, { recursive: true, mode: INTERCOM_DIR_MODE });
  if (platform !== "win32") {
    chmodSync(intercomDir, INTERCOM_DIR_MODE);
  }
}
function restrictIntercomRuntimeFile(filePath, platform = process.platform) {
  if (platform !== "win32") {
    chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
  }
}

// broker/client.ts
var BROKER_SOCKET = getBrokerSocketPath();
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
function isAttachment(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const attachment = value;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") {
    return false;
  }
  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }
  return attachment.language === void 0 || typeof attachment.language === "string";
}
function isMessage(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value;
  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }
  if (message.replyTo !== void 0 && typeof message.replyTo !== "string") {
    return false;
  }
  if (message.expectsReply !== void 0 && typeof message.expectsReply !== "boolean") {
    return false;
  }
  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }
  const content = message.content;
  if (typeof content.text !== "string") {
    return false;
  }
  return content.attachments === void 0 || Array.isArray(content.attachments) && content.attachments.every(isAttachment);
}
function isSessionInfo(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const session = value;
  if (typeof session.id !== "string" || typeof session.cwd !== "string" || typeof session.model !== "string" || typeof session.pid !== "number" || typeof session.startedAt !== "number" || typeof session.lastActivity !== "number") {
    return false;
  }
  if (session.name !== void 0 && typeof session.name !== "string") {
    return false;
  }
  return session.status === void 0 || typeof session.status === "string";
}
var IntercomClient = class extends EventEmitter {
  socket = null;
  _sessionId = null;
  pendingSends = /* @__PURE__ */ new Map();
  pendingLists = /* @__PURE__ */ new Map();
  disconnecting = false;
  disconnectError = null;
  failPending(error) {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error);
    }
    this.pendingLists.clear();
  }
  get sessionId() {
    return this._sessionId;
  }
  isConnected() {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }
  requireActiveSocket() {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }
    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }
    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new Error("Client disconnected");
    }
    return socket;
  }
  connect(session, sessionId) {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }
    return new Promise((resolve2, reject) => {
      const socket = net.connect(BROKER_SOCKET);
      this.socket = socket;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 1e4);
      let connectionEstablished = false;
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve2();
      };
      const onError = (err) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };
      const onSocketError = (err) => {
        if (connectionEstablished) {
          this.disconnectError = err;
          this.emit("error", err);
        }
      };
      const onReaderError = (error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };
      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };
      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      try {
        writeMessage(socket, { type: "register", session, ...sessionId ? { sessionId } : {} });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error));
      }
    });
  }
  handleBrokerMessage(msg) {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }
    const brokerMessage = msg;
    if (this._sessionId === null && brokerMessage.type !== "registered") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }
    switch (brokerMessage.type) {
      case "registered": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid registered message");
        }
        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }
        this._sessionId = brokerMessage.sessionId;
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }
      case "sessions": {
        const { requestId, sessions } = brokerMessage;
        if (typeof requestId !== "string" || !Array.isArray(sessions) || !sessions.every(isSessionInfo)) {
          throw new Error("Invalid sessions message");
        }
        const pending = this.pendingLists.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingLists.delete(requestId);
        pending.resolve(sessions);
        break;
      }
      case "message": {
        const { from, message } = brokerMessage;
        if (!isSessionInfo(from) || !isMessage(message)) {
          throw new Error("Invalid message event");
        }
        this.emit("message", from, message);
        break;
      }
      case "delivered": {
        const { messageId } = brokerMessage;
        if (typeof messageId !== "string") {
          throw new Error("Invalid delivered message");
        }
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          return;
        }
        this.pendingSends.delete(messageId);
        pending.resolve({ id: messageId, delivered: true });
        break;
      }
      case "delivery_failed": {
        const { messageId, reason } = brokerMessage;
        if (typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid delivery_failed message");
        }
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          return;
        }
        this.pendingSends.delete(messageId);
        pending.resolve({ id: messageId, delivered: false, reason });
        break;
      }
      case "session_joined": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid session_joined message");
        }
        this.emit("session_joined", brokerMessage.session);
        break;
      }
      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }
        this.emit("session_left", brokerMessage.sessionId);
        break;
      }
      case "presence_update": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid presence_update message");
        }
        this.emit("presence_update", brokerMessage.session);
        break;
      }
      case "error": {
        if (typeof brokerMessage.error !== "string") {
          throw new Error("Invalid error message");
        }
        this.emit("error", new Error(brokerMessage.error));
        break;
      }
      default:
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }
  async disconnect() {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new Error("Client disconnected"));
    await new Promise((resolve2) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve2();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2e3);
      socket.once("close", onClose);
      socket.once("error", onError);
      try {
        writeMessage(socket, { type: "unregister" });
        socket.end();
      } catch {
        socket.destroy();
      }
    });
  }
  listSessions() {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return new Promise((resolve2, reject) => {
      const requestId = randomUUID();
      const wrappedResolve = (sessions) => {
        clearTimeout(timeout);
        resolve2(sessions);
      };
      const wrappedReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, 5e3);
      this.pendingLists.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "list", requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error));
      }
    });
  }
  send(to, options) {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const messageId = options.messageId ?? randomUUID();
    const message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      content: {
        text: options.text,
        attachments: options.attachments
      }
    };
    return new Promise((resolve2, reject) => {
      const wrappedResolve = (result) => {
        clearTimeout(timeout);
        resolve2(result);
      };
      const wrappedReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Send timeout"));
        }
      }, 1e4);
      this.pendingSends.set(messageId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "send", to, message });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error));
      }
    });
  }
  cancelAsk(messageId) {
    if (this.disconnecting) {
      return;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }
    try {
      writeMessage(socket, { type: "cancel_ask", messageId });
    } catch {
    }
  }
  updatePresence(updates) {
    if (this.disconnecting) {
      return;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }
    writeMessage(socket, { type: "presence", ...updates });
  }
};

// broker/spawn.ts
import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join as join2, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import net2 from "net";
var INTERCOM_DIR = getIntercomDirPath();
var EXTENSION_DIR = join2(dirname(fileURLToPath(import.meta.url)), "..");
var BROKER_SOCKET2 = getBrokerSocketPath();
var BROKER_PID = join2(INTERCOM_DIR, "broker.pid");
var BROKER_SPAWN_LOCK = join2(INTERCOM_DIR, "broker.spawn.lock");
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function getTsxCliPath(extensionDir = EXTENSION_DIR) {
  try {
    const requireFromExtension = createRequire(import.meta.url);
    const tsxMain = requireFromExtension.resolve("tsx");
    return join2(dirname(tsxMain), "cli.mjs");
  } catch {
    return join2(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
  }
}
function quoteWindowsArg(value) {
  return `"${value.replace(/"/g, '""')}"`;
}
function getWindowsHiddenLauncherPath(intercomDir = INTERCOM_DIR) {
  return join2(intercomDir, "broker-launch.vbs");
}
function usesDefaultBrokerCommand(brokerCommand, brokerArgs) {
  return brokerCommand === "npx" && brokerArgs.length === 2 && brokerArgs[0] === "--no-install" && brokerArgs[1] === "tsx";
}
function getBrokerScriptPath(moduleUrl = import.meta.url) {
  const currentDir = dirname(fileURLToPath(moduleUrl));
  const bundledBrokerPath = join2(currentDir, "broker.mjs");
  if (existsSync(bundledBrokerPath)) {
    return bundledBrokerPath;
  }
  return join2(currentDir, "broker.ts");
}
function getEffectiveBrokerCommand(brokerPath, brokerCommand, brokerArgs, nodePath = process.execPath) {
  if (brokerPath.endsWith(".mjs") && usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return { command: nodePath, args: [] };
  }
  return { command: brokerCommand, args: brokerArgs };
}
function getWindowsBrokerCommandLine(brokerPath, extensionDir = EXTENSION_DIR, nodePath = process.execPath, brokerCommand = "npx", brokerArgs = ["--no-install", "tsx"]) {
  const effective = getEffectiveBrokerCommand(brokerPath, brokerCommand, brokerArgs, nodePath);
  if (effective.command === nodePath && effective.args.length === 0) {
    return [quoteWindowsArg(nodePath), quoteWindowsArg(brokerPath)].join(" ");
  }
  if (usesDefaultBrokerCommand(effective.command, effective.args)) {
    return [quoteWindowsArg(nodePath), quoteWindowsArg(getTsxCliPath(extensionDir)), quoteWindowsArg(brokerPath)].join(" ");
  }
  return [quoteWindowsArg(effective.command), ...effective.args.map(quoteWindowsArg), quoteWindowsArg(brokerPath)].join(" ");
}
function getWindowsHiddenLauncherScript(commandLine) {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    "Set WshShell = Nothing",
    ""
  ].join("\r\n");
}
function writeWindowsHiddenLauncher(commandLine, launcherPath = getWindowsHiddenLauncherPath()) {
  ensureIntercomRuntimeDir(dirname(launcherPath));
  writeFileSync(launcherPath, getWindowsHiddenLauncherScript(commandLine), {
    encoding: "utf-8",
    mode: INTERCOM_RUNTIME_FILE_MODE
  });
  restrictIntercomRuntimeFile(launcherPath);
  return launcherPath;
}
function getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs, extensionDir = EXTENSION_DIR, platform = process.platform, intercomDir = INTERCOM_DIR, nodePath = process.execPath) {
  const effective = getEffectiveBrokerCommand(brokerPath, brokerCommand, brokerArgs, nodePath);
  if (platform === "win32") {
    const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
    return {
      kind: "windows-launcher",
      command: "wscript.exe",
      args: [launcherPath],
      launcherPath,
      launcherCommandLine: getWindowsBrokerCommandLine(brokerPath, extensionDir, nodePath, effective.command, effective.args)
    };
  }
  return {
    kind: "direct",
    command: effective.command,
    args: [...effective.args, brokerPath]
  };
}
function getBrokerSpawnOptions(extensionDir = EXTENSION_DIR) {
  return {
    detached: true,
    stdio: "ignore",
    cwd: extensionDir,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    windowsHide: true
  };
}
function toError2(error) {
  return error instanceof Error ? error : new Error(String(error));
}
async function spawnBrokerIfNeeded(brokerCommand, brokerArgs) {
  ensureIntercomRuntimeDir(INTERCOM_DIR);
  if (await isBrokerRunning()) {
    return;
  }
  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }
  try {
    if (await isBrokerRunning()) {
      return;
    }
    const brokerPath = getBrokerScriptPath();
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs);
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
    }
    const child = spawn(launch.command, launch.args, getBrokerSpawnOptions());
    child.unref();
    await new Promise((resolve2, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = (error) => {
        cleanup();
        reject(new Error(`Failed to spawn intercom broker: ${error.message}`, { cause: error }));
      };
      const onExit = (code, signal) => {
        if (launch.kind === "windows-launcher" && code === 0 && signal === null) {
          return;
        }
        cleanup();
        if (signal) {
          reject(new Error(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };
      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker().then(() => {
        cleanup();
        resolve2();
      }, (error) => {
        cleanup();
        reject(toError2(error));
      });
    });
  } finally {
    releaseSpawnLock();
  }
}
async function isBrokerRunning() {
  if (await checkSocketConnectable()) {
    return true;
  }
  if (!existsSync(BROKER_PID)) return false;
  try {
    const pid = parseInt(readFileSync(BROKER_PID, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable();
  } catch {
    return false;
  }
}
function checkSocketConnectable() {
  return new Promise((resolve2) => {
    const socket = net2.connect(BROKER_SOCKET2);
    const finish = (isConnected) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolve2(isConnected);
    };
    const onConnect = () => {
      socket.end();
      finish(true);
    };
    const onError = () => {
      socket.destroy();
      finish(false);
    };
    socket.on("connect", onConnect);
    socket.on("error", onError);
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, 1e3);
  });
}
function acquireSpawnLock() {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}
${Date.now()}
`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE
      });
      restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
        }
        continue;
      }
      return false;
    }
  }
  return false;
}
function isSpawnLockStale() {
  if (!existsSync(BROKER_SPAWN_LOCK)) {
    return false;
  }
  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
    }
    return !Number.isFinite(createdAt) || ageMs > 1e4;
  } catch {
    return true;
  }
}
function releaseSpawnLock() {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
  }
}
async function waitForBroker(timeoutMs = 5e3) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}

// config.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { join as join3, resolve } from "path";
import { homedir as homedir2 } from "os";
var DEFAULT_ASK_TIMEOUT_MS = 45 * 1e3;
var MAX_ASK_TIMEOUT_MS = 120 * 1e3;
function validateAskTimeoutMs(value, name = "timeout_ms") {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  if (value > MAX_ASK_TIMEOUT_MS) {
    throw new Error(`${name} must be ${MAX_ASK_TIMEOUT_MS} ms or less; use intercom_send plus intercom_pending for longer-running work`);
  }
  return value;
}
function getAskTimeoutMs() {
  const raw = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  if (raw === void 0 || raw.trim() === "") {
    return DEFAULT_ASK_TIMEOUT_MS;
  }
  const value = Number(raw);
  return validateAskTimeoutMs(value, "PI_INTERCOM_ASK_TIMEOUT_MS");
}
function getConfigPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join3(homedir2(), ".pi", "agent");
  return join3(agentDir, "intercom", "opencode-config.json");
}
var defaults = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  enabled: true
};
function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync2(configPath)) {
    return { ...defaults };
  }
  try {
    const raw = readFileSync2(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }
    const parsedConfig = parsed;
    const config = { ...defaults };
    if (Object.hasOwn(parsedConfig, "brokerCommand")) {
      if (typeof parsedConfig.brokerCommand !== "string") {
        throw new Error(`"brokerCommand" must be a string`);
      }
      const brokerCommand = parsedConfig.brokerCommand.trim();
      if (!brokerCommand) {
        throw new Error(`"brokerCommand" must not be empty`);
      }
      config.brokerCommand = brokerCommand;
    }
    if (Object.hasOwn(parsedConfig, "brokerArgs")) {
      if (!Array.isArray(parsedConfig.brokerArgs)) {
        throw new Error(`"brokerArgs" must be an array`);
      }
      const brokerArgs = [];
      for (const arg of parsedConfig.brokerArgs) {
        if (typeof arg !== "string") {
          throw new Error(`"brokerArgs" items must be strings`);
        }
        brokerArgs.push(arg);
      }
      config.brokerArgs = brokerArgs;
    }
    if (Object.hasOwn(parsedConfig, "enabled")) {
      if (typeof parsedConfig.enabled !== "boolean") {
        throw new Error(`"enabled" must be a boolean`);
      }
      config.enabled = parsedConfig.enabled;
    }
    return config;
  } catch (error) {
    console.error(`Failed to load intercom config at ${configPath}:`, error);
    return { ...defaults };
  }
}

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
function formatAttachments(attachments) {
  if (!attachments?.length) return "";
  return attachments.map((attachment) => {
    if (attachment.language) {
      return `

---
Attachment: ${attachment.name}
~~~${attachment.language}
${attachment.content}
~~~`;
    }
    return `

---
Attachment: ${attachment.name}
${attachment.content}`;
  }).join("");
}
function resolveSessionTarget(sessions, nameOrId) {
  const byId = sessions.find((session) => session.id === nameOrId);
  if (byId) return byId.id;
  const lowerName = nameOrId.toLowerCase();
  const byName = sessions.filter((session) => session.name?.toLowerCase() === lowerName);
  if (byName.length > 1) {
    throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
  }
  if (byName[0]) return byName[0].id;
  if (nameOrId.length >= 4) {
    const byPrefix = sessions.filter((session) => session.id.startsWith(nameOrId));
    if (byPrefix.length > 1) {
      throw new Error(`Multiple sessions match the ID prefix "${nameOrId}". Use the full session ID or a unique name.`);
    }
    if (byPrefix[0]) return byPrefix[0].id;
  }
  return null;
}
function formatSessionList(sessions, currentSessionId, currentCwd) {
  if (!sessions.length) return "No intercom sessions connected.";
  return sessions.map((session) => {
    const tags = [
      session.id === currentSessionId ? "self" : void 0,
      session.cwd === currentCwd ? "same cwd" : void 0,
      session.status
    ].filter((tag) => Boolean(tag));
    const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
    return `- ${session.name || "unnamed"} (${session.id.slice(0, 8)}) - ${session.cwd} (${session.model})${suffix}`;
  }).join("\n");
}
function detectGitRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}
function textResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...structuredContent ? { structuredContent } : {},
    ...isError ? { isError: true } : {}
  };
}
var OpenCodeIntercomRuntime = class {
  client = null;
  identity;
  unread = [];
  unresolvedAsks = /* @__PURE__ */ new Map();
  replyWaiters = /* @__PURE__ */ new Map();
  onInboundMessage;
  constructor(identity, cwd, onInboundMessage) {
    this.identity = identity ?? buildOpenCodeRuntimeIdentity(process.env, cwd);
    this.onInboundMessage = onInboundMessage;
  }
  getIdentity() {
    return this.identity;
  }
  async connect() {
    if (this.client?.isConnected()) return this.client;
    const config = loadConfig();
    if (!config.enabled) throw new Error("Intercom disabled");
    await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    const client = new IntercomClient();
    client.on("message", (from, message) => {
      this.handleIncomingMessage(from, message);
    });
    client.on("disconnected", (error) => {
      for (const waiter of this.replyWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.reject(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      }
      this.replyWaiters.clear();
      if (this.client === client) this.client = null;
    });
    await client.connect({
      name: this.identity.name,
      cwd: this.identity.cwd,
      model: this.identity.model,
      pid: process.pid,
      startedAt: this.identity.startedAt,
      lastActivity: Date.now(),
      status: "idle"
    }, this.identity.sessionId);
    this.client = client;
    return client;
  }
  async disconnect() {
    if (!this.client) return;
    await this.client.disconnect();
    this.client = null;
  }
  handleIncomingMessage(from, message) {
    const waiter = this.replyWaiters.get(message.replyTo ?? "");
    if (waiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
      if (fromMatches) {
        this.replyWaiters.delete(waiter.replyTo);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.resolve(message);
        return;
      }
    }
    const entry = { from, message, receivedAt: Date.now(), read: false };
    this.unread.push(entry);
    if (message.expectsReply) {
      this.unresolvedAsks.set(message.id, entry);
    }
    void Promise.resolve(this.onInboundMessage?.(entry)).catch((error) => {
      console.error("Failed to inject inbound intercom message:", error);
    });
  }
  waitForReply(from, replyTo, timeoutMs = getAskTimeoutMs(), signal) {
    return new Promise((resolve2, reject) => {
      if (signal?.aborted) {
        reject(new Error("intercom_ask cancelled"));
        return;
      }
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        this.replyWaiters.delete(replyTo);
        cleanup();
        this.client?.cancelAsk(replyTo);
        reject(new Error("intercom_ask cancelled"));
      };
      timeout = setTimeout(() => {
        this.replyWaiters.delete(replyTo);
        this.client?.cancelAsk(replyTo);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 1e3)} seconds`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.replyWaiters.set(replyTo, { from, replyTo, resolve: resolve2, reject, timeout, cleanup });
    });
  }
  async resolveTarget(to) {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }
  async whoami() {
    const client = await this.connect();
    const sessionId = client.sessionId ?? this.identity.sessionId;
    return textResult(
      `session_id: ${sessionId}
name: ${this.identity.name}
cwd: ${this.identity.cwd}`,
      { session_id: sessionId, name: this.identity.name, cwd: this.identity.cwd, model: this.identity.model }
    );
  }
  async status() {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return textResult(
      `Connected: ${client.isConnected() ? "Yes" : "No"}
Session ID: ${client.sessionId ?? "unknown"}
Active sessions: ${sessions.length}
Unread messages: ${this.unread.filter((entry) => !entry.read).length}
Pending asks: ${this.unresolvedAsks.size}`,
      {
        connected: client.isConnected(),
        session_id: client.sessionId,
        active_sessions: sessions.length,
        unread_messages: this.unread.filter((entry) => !entry.read).length,
        pending_asks: this.unresolvedAsks.size
      }
    );
  }
  async list(scope = "machine", includeSelf = false) {
    const client = await this.connect();
    let sessions = await client.listSessions();
    if (scope === "directory") {
      sessions = sessions.filter((session) => session.cwd === this.identity.cwd);
    } else if (scope === "repo") {
      const currentRoot = detectGitRoot(this.identity.cwd);
      sessions = currentRoot ? sessions.filter((session) => detectGitRoot(session.cwd) === currentRoot) : [];
    }
    if (!includeSelf) {
      sessions = sessions.filter((session) => session.id !== client.sessionId);
    }
    return textResult(formatSessionList(sessions, client.sessionId, this.identity.cwd), { sessions });
  }
  async setSummary(summary) {
    const client = await this.connect();
    client.updatePresence({ status: summary.trim() || "idle" });
    return textResult("Summary updated.", { ok: true, summary });
  }
  async send(to, message, attachments, replyTo) {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const result = await client.send(sendTo, { text: message, attachments, replyTo });
    if (!result.delivered) {
      return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
    }
    if (replyTo) this.unresolvedAsks.delete(replyTo);
    return textResult(`Message sent to ${to}.`, { ok: true, message_id: result.id, to });
  }
  async ask(to, message, attachments, timeoutMs = getAskTimeoutMs(), signal) {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const questionId = randomUUID2();
    const replyPromise = this.waitForReply(sendTo, questionId, timeoutMs, signal);
    void replyPromise.catch(() => void 0);
    try {
      const result = await client.send(sendTo, {
        messageId: questionId,
        text: message,
        attachments,
        expectsReply: true
      });
      if (!result.delivered) {
        this.replyWaiters.get(questionId)?.reject(new Error(result.reason ?? "Session may not exist or has disconnected."));
        this.replyWaiters.delete(questionId);
        client.cancelAsk(questionId);
        return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
      }
      const reply = await replyPromise;
      const replyText = `${reply.content.text}${formatAttachments(reply.content.attachments)}`;
      return textResult(`Reply from ${to}:
${replyText}`, { ok: true, message_id: result.id, reply });
    } catch (error) {
      client.cancelAsk(questionId);
      return textResult(error instanceof Error ? error.message : String(error), { ok: false }, true);
    }
  }
  async pending(markRead = false) {
    const unreadMessages = this.unread.filter((entry) => !entry.read);
    if (markRead) {
      for (const entry of unreadMessages) entry.read = true;
    }
    const pendingAsks = Array.from(this.unresolvedAsks.values());
    const lines = [
      unreadMessages.length ? unreadMessages.map((entry) => `- ${entry.from.name || entry.from.id}: ${entry.message.content.text}${formatAttachments(entry.message.content.attachments)}`).join("\n") : "No unread messages.",
      pendingAsks.length ? `
Pending asks:
${pendingAsks.map((entry) => `- ${entry.message.id} from ${entry.from.name || entry.from.id}: ${entry.message.content.text}`).join("\n")}` : ""
    ].filter(Boolean);
    return textResult(lines.join("\n"), { unread_messages: unreadMessages, pending_asks: pendingAsks });
  }
  async reply(message, to, replyTo) {
    let target;
    if (replyTo) {
      target = this.unresolvedAsks.get(replyTo);
    } else if (to) {
      const lowerTo = to.toLowerCase();
      const matches = Array.from(this.unresolvedAsks.values()).filter(
        (entry) => entry.from.id === to || entry.from.name?.toLowerCase() === lowerTo || entry.from.id.startsWith(to)
      );
      if (matches.length > 1) {
        return textResult(`Multiple pending asks match "${to}". Call intercom_pending and reply with reply_to.`, { ok: false }, true);
      }
      target = matches[0];
    } else if (this.unresolvedAsks.size === 1) {
      target = Array.from(this.unresolvedAsks.values())[0];
    }
    if (!target) {
      return textResult("No matching pending ask. Call intercom_pending to inspect unresolved asks.", { ok: false }, true);
    }
    const result = await this.send(target.from.id, message, void 0, target.message.id);
    if (!result.isError) {
      this.unresolvedAsks.delete(target.message.id);
    }
    return result;
  }
};

// opencode/plugin.ts
var INJECT_LOG_PATH = "/tmp/intercom-inject.log";
function resultText(result) {
  const text = result.content.map((part) => part.text).join("\n");
  if (result.isError) {
    throw new Error(text);
  }
  return text;
}
function listScope(value) {
  if (value === void 0 || value === "machine" || value === "directory" || value === "repo") {
    return value ?? "machine";
  }
  throw new Error('scope must be one of "machine", "directory", or "repo"');
}
var OpenCodeIntercomPlugin = async ({ client, directory }) => {
  let activeSessionID = process.env.OPENCODE_SESSION_ID?.trim() || void 0;
  let activeSessionStatus = "idle";
  let flushingInjectQueue = false;
  const pendingInjectQueue = [];
  const deliveredMessageIDs = /* @__PURE__ */ new Set();
  const canUseTuiInjection = Boolean(process.stdin.isTTY || process.stdout.isTTY);
  const debugInject = process.env.OPENCODE_INTERCOM_DEBUG === "1";
  function logInject(step, details) {
    if (!debugInject) {
      return;
    }
    try {
      appendFileSync(INJECT_LOG_PATH, `${JSON.stringify({ time: (/* @__PURE__ */ new Date()).toISOString(), step, ...details })}
`);
    } catch {
    }
  }
  function formatError(error) {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause
      };
    }
    return { value: error };
  }
  async function logResult(step, result, details = {}) {
    const responseBody = result.response ? await result.response.clone().text().catch(() => void 0) : void 0;
    logInject(step, {
      ...details,
      ok: result.error === void 0,
      status: result.response?.status,
      data: result.data,
      error: result.error,
      responseBody
    });
  }
  function setActiveSession(sessionID) {
    if (typeof sessionID === "string" && sessionID.trim()) {
      activeSessionID = sessionID;
    }
  }
  function formatInboundPrompt(entry) {
    const from = entry.from.name || entry.from.id;
    const replyHint = entry.message.expectsReply ? `

This message expects a reply. Use intercom_reply with reply_to "${entry.message.id}" after you respond.` : "";
    return [
      `Incoming intercom message from ${from} (${entry.from.model}, ${entry.from.cwd}):`,
      "",
      entry.message.content.text + formatAttachments(entry.message.content.attachments),
      replyHint
    ].join("\n");
  }
  async function resolveActiveSessionID() {
    if (activeSessionID) {
      return activeSessionID;
    }
    const sessionList = await client.session.list({ query: { directory } }).catch((error) => {
      logInject("session.list.error", { error: formatError(error) });
      return void 0;
    });
    if (sessionList) {
      await logResult("session.list", sessionList);
    }
    const sessions = sessionList?.data;
    if (!sessions?.length) {
      return void 0;
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
  function enqueuePendingInject(entry, reason) {
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
  function markDelivered(messageID, path) {
    deliveredMessageIDs.add(messageID);
    const queueIndex = pendingInjectQueue.findIndex((queued) => queued.entry.message.id === messageID);
    if (queueIndex >= 0) {
      pendingInjectQueue.splice(queueIndex, 1);
    }
    logInject("message.delivered", { messageID, path, queueLength: pendingInjectQueue.length });
  }
  async function flushPendingInjectQueue(trigger) {
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
              parts: [{ type: "text", text: prompt }]
            }
          });
        } catch (error) {
          logInject("queue.flush.prompt.throw", {
            trigger,
            sessionID,
            messageID: entry.message.id,
            error: formatError(error)
          });
          break;
        }
        await logResult("queue.flush.prompt", result, {
          trigger,
          sessionID,
          messageID: entry.message.id
        });
        if (result.error !== void 0) {
          break;
        }
        markDelivered(entry.message.id, "queue.flush.prompt");
      }
    } finally {
      logInject("queue.flush.end", { trigger, remaining: pendingInjectQueue.length });
      flushingInjectQueue = false;
    }
  }
  async function injectInbound(entry) {
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
      activeSessionStatus
    });
    if (busy) {
      enqueuePendingInject(entry, "session_busy_pre_tui");
    }
    logInject("inject.mode", {
      messageID: entry.message.id,
      canUseTuiInjection,
      busy
    });
    try {
      const toastResult = await client.tui.showToast({
        body: {
          title: `Intercom from ${from}`,
          message: entry.message.content.text.slice(0, 240),
          variant: entry.message.expectsReply ? "warning" : "info",
          duration: 8e3
        },
        query: { directory }
      });
      await logResult("inject.toast", toastResult, { messageID: entry.message.id });
    } catch (error) {
      logInject("inject.toast.throw", { messageID: entry.message.id, error: formatError(error) });
    }
    if (canUseTuiInjection) {
      try {
        const appended = await client.tui.appendPrompt({
          body: { text: prompt },
          query: { directory }
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
      busy
    });
    if (busy) {
      try {
        const asyncResult = await client.session.promptAsync({
          path: { id: sessionID },
          query: { directory },
          body: {
            parts: [{ type: "text", text: prompt }]
          }
        });
        await logResult("inject.promptAsync", asyncResult, { messageID: entry.message.id, sessionID });
        if (asyncResult.error === void 0 && asyncResult.response?.ok) {
          markDelivered(entry.message.id, "session.promptAsync");
        }
      } catch (error) {
        logInject("inject.promptAsync.throw", {
          messageID: entry.message.id,
          sessionID,
          error: formatError(error)
        });
      }
      return;
    }
    try {
      const promptResult = await client.session.prompt({
        path: { id: sessionID },
        query: { directory },
        body: {
          parts: [{ type: "text", text: prompt }]
        }
      });
      await logResult("inject.prompt", promptResult, { messageID: entry.message.id, sessionID });
      if (promptResult.error !== void 0) {
        enqueuePendingInject(entry, "prompt_error");
      } else if (promptResult.response?.ok) {
        markDelivered(entry.message.id, "session.prompt");
      }
    } catch (error) {
      logInject("inject.prompt.throw", {
        messageID: entry.message.id,
        sessionID,
        error: formatError(error)
      });
      enqueuePendingInject(entry, "prompt_throw");
    }
  }
  const runtime = new OpenCodeIntercomRuntime(void 0, directory, injectInbound);
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
        }
      }),
      intercom_status: tool({
        description: "Show local intercom connection status and pending message counts.",
        args: {},
        async execute(_args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.status());
        }
      }),
      intercom_list: tool({
        description: "List local Pi, Codex, Claude, and OpenCode intercom sessions.",
        args: {
          scope: tool.schema.string().optional().describe('Filter sessions: "machine", "directory", or "repo".'),
          include_self: tool.schema.boolean().optional().describe("Include this OpenCode session in the result.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.list(listScope(args.scope), args.include_self ?? false));
        }
      }),
      intercom_set_summary: tool({
        description: "Publish a short discoverable status for this OpenCode session.",
        args: {
          summary: tool.schema.string().describe("Short status shown to other intercom sessions.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.setSummary(args.summary));
        }
      }),
      intercom_send: tool({
        description: "Send a non-blocking message to another local intercom session.",
        args: {
          to: tool.schema.string().describe("Target session name, id, or unique id prefix."),
          message: tool.schema.string().describe("Message text to send.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.send(args.to, args.message));
        }
      }),
      intercom_ask: tool({
        description: "Ask another local intercom session a blocking question and wait briefly for a reply.",
        args: {
          to: tool.schema.string().describe("Target session name, id, or unique id prefix."),
          message: tool.schema.string().describe("Question text to send."),
          timeout_ms: tool.schema.number().optional().describe("Reply timeout in milliseconds, max 120000.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          const timeoutMs = args.timeout_ms === void 0 ? void 0 : validateAskTimeoutMs(args.timeout_ms);
          return resultText(await runtime.ask(args.to, args.message, void 0, timeoutMs));
        }
      }),
      intercom_pending: tool({
        description: "Read queued inbound intercom messages and unresolved asks.",
        args: {
          mark_read: tool.schema.boolean().optional().describe("Mark unread messages as read after returning them.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.pending(args.mark_read ?? false));
        }
      }),
      intercom_reply: tool({
        description: "Reply to a pending inbound intercom ask.",
        args: {
          message: tool.schema.string().describe("Reply text."),
          to: tool.schema.string().optional().describe("Optional sender name/id if there are multiple pending asks."),
          reply_to: tool.schema.string().optional().describe("Optional message id from intercom_pending.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.reply(args.message, args.to, args.reply_to));
        }
      })
    },
    event: async ({ event }) => {
      const properties = event.properties;
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = properties?.info;
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
    }
  };
};
var plugin_default = OpenCodeIntercomPlugin;
export {
  OpenCodeIntercomPlugin,
  plugin_default as default
};
