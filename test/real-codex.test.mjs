import assert from "node:assert/strict";
import test from "node:test";
import { resolveRealCodex } from "../src/real-codex.mjs";

const FAKE_WRAPPER = "/tmp/dscodex/src/codex-wrapper.mjs";
const existsNone = () => false;
const existsAll = () => true;
const noLaunchctl = () => "";
const noWhich = () => "";

test("resolveRealCodex prefers the launchctl login session value", () => {
  const resolved = resolveRealCodex({
    env: { DSCODEX_REAL_CODEX: "/env/codex" },
    self: FAKE_WRAPPER,
    exists: existsAll,
    getenv: (name) => (name === "DSCODEX_REAL_CODEX" ? "/session/codex" : ""),
    which: noWhich,
  });
  assert.equal(resolved, "/session/codex");
});

test("resolveRealCodex falls back to env, bundled app, then PATH", () => {
  const fromEnv = resolveRealCodex({
    env: { DSCODEX_REAL_CODEX: "/env/codex" },
    self: FAKE_WRAPPER,
    exists: existsAll,
    getenv: noLaunchctl,
    which: noWhich,
  });
  assert.equal(fromEnv, "/env/codex");

  const bundled = resolveRealCodex({
    env: {},
    self: FAKE_WRAPPER,
    exists: (path) => path === "/Applications/ChatGPT.app/Contents/Resources/codex",
    getenv: noLaunchctl,
    which: noWhich,
  });
  assert.equal(bundled, "/Applications/ChatGPT.app/Contents/Resources/codex");

  const fromPath = resolveRealCodex({
    env: {},
    self: FAKE_WRAPPER,
    exists: (path) => path === "/usr/local/bin/codex",
    getenv: noLaunchctl,
    which: () => "/usr/local/bin/codex",
  });
  assert.equal(fromPath, "/usr/local/bin/codex");
});

test("resolveRealCodex survives a rebooted session with no env overrides", () => {
  // After a reboot launchctl/env are empty; only the bundled binary exists.
  const resolved = resolveRealCodex({
    env: {},
    self: FAKE_WRAPPER,
    exists: (path) => path === "/Applications/ChatGPT.app/Contents/Resources/codex",
    getenv: noLaunchctl,
    which: noWhich,
  });
  assert.equal(resolved, "/Applications/ChatGPT.app/Contents/Resources/codex");
});

test("resolveRealCodex never targets the wrapper itself", () => {
  const resolved = resolveRealCodex({
    env: { DSCODEX_REAL_CODEX: FAKE_WRAPPER },
    self: FAKE_WRAPPER,
    exists: existsAll,
    getenv: noLaunchctl,
    which: () => FAKE_WRAPPER,
  });
  assert.equal(resolved, "/Applications/ChatGPT.app/Contents/Resources/codex");
});

test("resolveRealCodex returns empty when no candidate exists", () => {
  const resolved = resolveRealCodex({
    env: {},
    self: FAKE_WRAPPER,
    exists: existsNone,
    getenv: noLaunchctl,
    which: noWhich,
  });
  assert.equal(resolved, "");
});
