import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIntercomDirPath, restrictIntercomRuntimeFile } from "../broker/paths.ts";

export type OpenCodeControlAction =
  | { type: "whoami" }
  | { type: "list" }
  | { type: "send"; to: string; message: string };

export interface OpenCodeControlRequest {
  id: string;
  sessionId: string;
  action: OpenCodeControlAction;
  createdAt: number;
}

export interface OpenCodeControlResponse {
  ok: boolean;
  value?: unknown;
  error?: string;
}

const CONTROL_DIR_NAME = "opencode-control";

function controlDir(): string {
  const directory = join(getIntercomDirPath(), CONTROL_DIR_NAME);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function requestName(sessionId: string, requestId: string): string {
  return `${safeSessionId(sessionId)}.${requestId}.request.json`;
}

function responseName(sessionId: string, requestId: string): string {
  return `${safeSessionId(sessionId)}.${requestId}.response.json`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  restrictIntercomRuntimeFile(temporary);
  renameSync(temporary, path);
  restrictIntercomRuntimeFile(path);
}

export async function requestOpenCodeControl(
  sessionId: string,
  action: OpenCodeControlAction,
  timeoutMs = 5000,
): Promise<OpenCodeControlResponse> {
  const directory = controlDir();
  const id = randomUUID();
  const requestPath = join(directory, requestName(sessionId, id));
  const responsePath = join(directory, responseName(sessionId, id));
  const request: OpenCodeControlRequest = { id, sessionId, action, createdAt: Date.now() };
  writeJsonAtomic(requestPath, request);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(readFileSync(responsePath, "utf8")) as OpenCodeControlResponse;
        return response;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { ok: false, error: "The OpenCode intercom server plugin did not respond. Check that dist/plugin.mjs is enabled." };
  } finally {
    rmSync(requestPath, { force: true });
    rmSync(responsePath, { force: true });
  }
}

export function startOpenCodeControlServer(options: {
  acceptsSession: (sessionId: string) => boolean;
  handle: (action: OpenCodeControlAction) => Promise<unknown>;
}): () => void {
  const directory = controlDir();
  let processing = false;

  const timer = setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      const files = readdirSync(directory).filter(file => file.endsWith(".request.json"));
      for (const file of files) {
        const requestPath = join(directory, file);
        let request: OpenCodeControlRequest;
        try {
          request = JSON.parse(readFileSync(requestPath, "utf8")) as OpenCodeControlRequest;
        } catch {
          continue;
        }
        if (!request?.id || !request.sessionId || !options.acceptsSession(request.sessionId)) continue;

        const responsePath = join(directory, responseName(request.sessionId, request.id));
        let response: OpenCodeControlResponse;
        try {
          response = { ok: true, value: await options.handle(request.action) };
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        writeJsonAtomic(responsePath, response);
        rmSync(requestPath, { force: true });
      }
    } finally {
      processing = false;
    }
  }, 100);
  timer.unref();
  return () => clearInterval(timer);
}
