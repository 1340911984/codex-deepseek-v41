import { homedir } from "node:os";
import { join, win32 } from "node:path";

export const LAUNCHD_LABEL = "com.dscodex.router";
export const SYSTEMD_UNIT = "dscodex.service";
export const WINDOWS_TASK = "DSCodex";

export function autostartKind(platform = process.platform) {
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "schtasks";
  return "systemd";
}

export function launchdPlistPath(home = homedir()) {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(home = homedir()) {
  return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// KeepAlive.SuccessfulExit=false: crashes are relaunched, but a graceful SIGTERM
// (`dscodex stop` exits 0) stays down — a manual stop must never be resurrected.
export function buildLaunchdPlist({ nodePath, cliPath, port, logPath }) {
  const args = [nodePath, cliPath, "serve", "--port", String(port)]
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// Restart=on-failure mirrors the launchd semantics above: the router exits 0 on
// SIGTERM, so only crashes are restarted.
export function buildSystemdUnit({ nodePath, cliPath, port, logPath }) {
  return `[Unit]
Description=DSCodex loopback router (DeepSeek V4.1 Flash for Codex)

[Service]
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} serve --port ${port}
Restart=on-failure
RestartSec=2
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function winQuote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function powershellPath() {
  return win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function psPath(value, homeDir) {
  const path = String(value);
  const homePrefix = String(homeDir).replace(/[\\/]+$/, "");
  const lowerPath = path.toLowerCase();
  const lowerHome = homePrefix.toLowerCase();
  if (homePrefix && lowerPath === lowerHome) return "$env:USERPROFILE";
  if (homePrefix && (lowerPath.startsWith(`${lowerHome}\\`) || lowerPath.startsWith(`${lowerHome}/`))) {
    // wscript reads generated .vbs files through the active ANSI code page.
    // Keep non-ASCII user names out of the VBS source and resolve them at run time.
    return `($env:USERPROFILE + ${psQuote(path.slice(homePrefix.length))})`;
  }
  return psQuote(path);
}

// The task runs wscript.exe on this one-liner so no console window flashes at
// logon. It deliberately avoids `cmd /c`: a cmd string would need escaping for
// `&`, `^`, `|`, `<`, `>` etc., so paths (which may contain those characters)
// are passed to PowerShell as single-quoted arguments instead and the router
// log is appended with PowerShell's `*>>`.
export function buildWindowsVbs({ nodePath, cliPath, port, logPath, homeDir = homedir() }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  const script = `$ErrorActionPreference='Stop'; & ${psPath(nodePath, homeDir)} ${psPath(cliPath, homeDir)} serve --port ${port} *>> ${psPath(logPath, homeDir)}`;
  const commandLine = `${winQuote(powershellPath())} -NoProfile -NonInteractive -WindowStyle Hidden -Command ${winQuote(script)}`;
  return `CreateObject("Wscript.Shell").Run "${commandLine.replaceAll('"', '""')}", 0, False\r\n`;
}
