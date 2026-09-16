import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.7.0";
export const DEFAULT_PORT = 10110;
export const HOST = "127.0.0.1";
export const DEEPSEEK_PICKER_SLUG = "deepseek/deepseek-flash";
export const DEEPSEEK_WIRE_MODEL = "deepseek-flash";
export const DEEPSEEK_CONTEXT_WINDOW = 1_048_576;
export const DEEPSEEK_AUTO_COMPACT_TOKEN_LIMIT = 700_000;
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const MANAGED_MARKER = "# DSCodex managed; remove with `dscodex uninstall`";

export function resolveCodexHome(env = process.env) {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

// Windows cannot spawn .cmd/.bat directly (CreateProcess needs an .exe), so those
// launchers must go through the command interpreter. POSIX scripts need no shell.
export function needsShellSpawn(executablePath, platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(executablePath);
}

export function pathsFor(codexHome) {
  return {
    config: join(codexHome, "config.toml"),
    cache: join(codexHome, "models_cache.json"),
    catalog: join(codexHome, "dscodex-models.json"),
    backup: join(codexHome, "config.toml.pre-dscodex.bak"),
    stateDir: join(codexHome, "dscodex"),
    keyFile: join(codexHome, "dscodex", "config.json"),
    selectionState: join(codexHome, "dscodex", "model-selections.json"),
    bridgeShim: join(codexHome, "dscodex", "codex-cli-bridge.sh"),
    pid: join(codexHome, "dscodex", "server.pid"),
    log: join(codexHome, "dscodex", "server.log"),
  };
}
