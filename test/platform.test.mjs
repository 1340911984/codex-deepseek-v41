import assert from "node:assert/strict";
import test from "node:test";
import { needsShellSpawn } from "../src/constants.mjs";

test("Windows batch launchers require the command interpreter", () => {
  assert.equal(needsShellSpawn(String.raw`C:\Users\me\AppData\Roaming\npm\codex.cmd`, "win32"), true);
  assert.equal(needsShellSpawn(String.raw`C:\Tools\CODEX.BAT`, "win32"), true);
  assert.equal(needsShellSpawn(String.raw`C:\Users\me\.codex\bin\codex.exe`, "win32"), false);
});

test("POSIX executables and scripts never need a shell", () => {
  assert.equal(needsShellSpawn("/Applications/ChatGPT.app/Contents/Resources/codex", "darwin"), false);
  assert.equal(needsShellSpawn("/usr/local/bin/codex", "linux"), false);
});
