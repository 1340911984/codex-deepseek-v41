import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_SERVER_WRAPPER = fileURLToPath(new URL("./codex-wrapper.mjs", import.meta.url));
export const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

function launchctlGetenv(name) {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("/bin/launchctl", ["getenv", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function whichCodex() {
  try {
    return execFileSync("/usr/bin/which", ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// Locate the stock Codex binary the app-server bridge forwards to. Order:
// launchctl login session (macOS), process env, the ChatGPT app's bundled
// binary, then PATH. The wrapper itself is never a valid target.
//
// The fallback chain matters: `launchctl setenv` does not survive reboots, so
// a bridge reactivated from a stale CODEX_CLI_PATH must still find the stock
// binary instead of hard-failing every spawn (app-server, Computer Use, MCP).
export function resolveRealCodex({
  env = process.env,
  self = APP_SERVER_WRAPPER,
  exists = existsSync,
  getenv = launchctlGetenv,
  which = whichCodex,
} = {}) {
  const selfResolved = self ? resolve(self) : "";
  const candidates = [
    getenv("DSCODEX_REAL_CODEX"),
    env.DSCODEX_REAL_CODEX?.trim(),
    BUNDLED_CODEX,
    which(),
  ];
  return candidates.find(
    (candidate) => candidate && resolve(candidate) !== selfResolved && exists(candidate),
  ) ?? "";
}
