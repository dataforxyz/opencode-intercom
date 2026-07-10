import { spawnSync } from "node:child_process";
import { buildOpenCodeRuntimeIdentity } from "./runtime.ts";

export function intercomContactText(): string {
  const identity = buildOpenCodeRuntimeIdentity();
  return `intercom send ID: ${identity.sessionId}`;
}

export function copyText(text: string, platform = process.platform): boolean {
  const candidates: Array<[string, string[]]> = platform === "darwin"
    ? [["pbcopy", []]]
    : platform === "win32"
      ? [["clip.exe", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  return candidates.some(([command, args]) => {
    const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    return result.status === 0;
  });
}
