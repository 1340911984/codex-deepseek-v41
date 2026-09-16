import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FIELD = "deepseek_api_key";
const ENCODING_FIELD = "key_encoding";
const PROXY_FIELD = "proxy_url";
const PROXY_ENCODING_FIELD = "proxy_encoding";
const ROUTER_TOKEN_FIELD = "router_token";
const DPAPI = "dpapi";
const PLAIN = "plain";

function isConfigObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function powershellPath() {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runDpapi(operation, value) {
  const encoded = operation === "protect" ? Buffer.from(value, "utf8").toString("base64") : value;
  const script = [
    "$inputText = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($inputText)",
    "Add-Type -AssemblyName System.Security",
    operation === "protect"
      ? "$result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)"
      : "$result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($result))",
  ].join("; ");
  const result = execFileSync(
    powershellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: `${encoded}\n`, encoding: "utf8", windowsHide: true },
  ).trim();
  return result;
}

function dpapiProtect(plain) {
  return runDpapi("protect", plain);
}

function dpapiUnprotect(encoded) {
  return Buffer.from(runDpapi("unprotect", encoded), "base64").toString("utf8");
}

export function readStoredKey(keyFile) {
  if (!existsSync(keyFile)) return "";
  try {
    const parsed = readRouterConfig(keyFile);
    const stored = typeof parsed?.[FIELD] === "string" ? parsed[FIELD].trim() : "";
    if (!stored) return "";
    // Legacy files written before key_encoding existed store the plaintext.
    return parsed?.[ENCODING_FIELD] === DPAPI ? dpapiUnprotect(stored) : stored;
  } catch {
    return "";
  }
}

// Reads the whole router config file (DeepSeek key, proxy URL, ...) without
// touching the stored key ciphertext. Corrupt or missing files resolve to {}.
export function readRouterConfig(keyFile, { strict = false } = {}) {
  if (!existsSync(keyFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(keyFile, "utf8"));
    if (isConfigObject(parsed)) return parsed;
    if (strict) throw new Error("DSCodex config must contain a JSON object");
  } catch (error) {
    if (strict && error instanceof Error && error.message.startsWith("DSCodex config")) throw error;
    // JSON.parse includes a fragment of the rejected input in modern Node
    // versions. Never let that fragment (which may be an API key or proxy
    // credential) escape through the CLI's top-level error handler.
    if (strict) throw new Error(`Could not read or parse DSCodex config at ${keyFile}`);
  }
  return {};
}

export function writeRouterConfig(keyFile, config) {
  if (!isConfigObject(config)) throw new Error("DSCodex config must contain a JSON object");
  if (Object.keys(config).length === 0) {
    if (existsSync(keyFile)) unlinkSync(keyFile);
    return {};
  }
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const temporary = `${keyFile}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, keyFile);
  return config;
}

function configForWrite(keyFile) {
  return readRouterConfig(keyFile, { strict: true });
}

export function writeStoredKey(keyFile, key) {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Empty DeepSeek API key");
  const encoding = process.platform === "win32" ? DPAPI : PLAIN;
  const stored = encoding === DPAPI ? dpapiProtect(trimmed) : trimmed;
  const config = configForWrite(keyFile);
  config[FIELD] = stored;
  config[ENCODING_FIELD] = encoding;
  writeRouterConfig(keyFile, config);
}

export function readProxyUrl(keyFile) {
  const config = readRouterConfig(keyFile);
  const value = config[PROXY_FIELD];
  if (typeof value !== "string") return "";
  try {
    return config[PROXY_ENCODING_FIELD] === DPAPI ? dpapiUnprotect(value).trim() : value.trim();
  } catch {
    return "";
  }
}

export function writeProxyUrl(keyFile, proxyUrl) {
  const trimmed = (proxyUrl ?? "").trim();
  // Any state-changing command is also an opportunity to remove a legacy
  // plaintext Windows key, rather than waiting until the router next starts.
  migrateLegacyStoredKey(keyFile);
  const config = configForWrite(keyFile);
  if (trimmed) {
    const encoding = process.platform === "win32" ? DPAPI : PLAIN;
    config[PROXY_FIELD] = encoding === DPAPI ? dpapiProtect(trimmed) : trimmed;
    config[PROXY_ENCODING_FIELD] = encoding;
  } else {
    delete config[PROXY_FIELD];
    delete config[PROXY_ENCODING_FIELD];
  }
  writeRouterConfig(keyFile, config);
}

export function createRouterToken() {
  return randomBytes(32).toString("base64url");
}

export function readRouterToken(keyFile) {
  const value = readRouterConfig(keyFile)[ROUTER_TOKEN_FIELD];
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
}

export function writeRouterToken(keyFile, token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Invalid DSCodex router token");
  }
  migrateLegacyStoredKey(keyFile);
  const config = configForWrite(keyFile);
  config[ROUTER_TOKEN_FIELD] = token;
  writeRouterConfig(keyFile, config);
}

export function ensureRouterToken(keyFile, preferredToken = "") {
  const config = readRouterConfig(keyFile, { strict: true });
  const existing = config[ROUTER_TOKEN_FIELD];
  if (typeof existing === "string" && /^[A-Za-z0-9_-]{43}$/.test(existing)) {
    migrateLegacyStoredKey(keyFile);
    return existing;
  }
  const token = typeof preferredToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(preferredToken)
    ? preferredToken
    : createRouterToken();
  writeRouterToken(keyFile, token);
  return token;
}

export function migrateLegacyStoredKey(keyFile) {
  if (process.platform !== "win32") return false;
  const config = readRouterConfig(keyFile);
  if (config[ENCODING_FIELD] === DPAPI
    || (config[ENCODING_FIELD] && config[ENCODING_FIELD] !== PLAIN)
    || typeof config[FIELD] !== "string" || !config[FIELD].trim()) return false;
  writeStoredKey(keyFile, config[FIELD]);
  return true;
}

export function deleteStoredKey(keyFile) {
  const config = configForWrite(keyFile);
  delete config[FIELD];
  delete config[ENCODING_FIELD];
  if (Object.keys(config).length === 0) {
    if (existsSync(keyFile)) unlinkSync(keyFile);
  } else {
    writeRouterConfig(keyFile, config);
  }
}
