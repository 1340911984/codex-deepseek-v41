#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { createAppServerState } from "./app-server-state.mjs";
import { needsShellSpawn } from "./constants.mjs";
import { resolveRealCodex } from "./real-codex.mjs";

// `launchctl setenv DSCODEX_REAL_CODEX` does not survive reboots, so the env
// override may be missing while a stale CODEX_CLI_PATH still points here.
// Fall back to the stock Codex locations instead of hard-failing: every
// spawn through this wrapper (app-server, Computer Use, MCP servers) must
// degrade to stock Codex rather than exit(1).
const realCodex = resolveRealCodex();
if (!realCodex) {
  console.error("dscodex: could not locate the stock Codex binary for the app-server bridge");
  process.exit(1);
}

const args = process.argv.slice(2);
const env = { ...process.env };
delete env.CODEX_CLI_PATH;
const child = spawn(realCodex, args, {
  env,
  stdio: ["pipe", "pipe", "inherit"],
  shell: needsShellSpawn(realCodex),
  windowsHide: true,
});
const appServer = args.includes("app-server");

if (!appServer) {
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
} else {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const state = createAppServerState({
    configPath: join(codexHome, "config.toml"),
    statePath: join(codexHome, "dscodex", "model-selections.json"),
  });
  const clientLines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const serverLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  clientLines.on("line", (line) => {
    try {
      child.stdin.write(`${JSON.stringify(state.rewriteClient(JSON.parse(line)))}\n`);
    } catch {
      child.stdin.write(`${line}\n`);
    }
  });
  clientLines.on("close", () => child.stdin.end());
  serverLines.on("line", (line) => {
    try {
      process.stdout.write(`${JSON.stringify(state.rewriteServer(JSON.parse(line)))}\n`);
    } catch {
      process.stdout.write(`${line}\n`);
    }
  });
}

const forwardedSignals = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => child.kill(signal);
  forwardedSignals.set(signal, handler);
  process.once(signal, handler);
}
child.once("error", (error) => {
  console.error(`dscodex: failed to start stock Codex: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.removeListener(signal, forwardedSignals.get(signal));
    process.kill(process.pid, signal);
  }
  else process.exit(code ?? 1);
});
