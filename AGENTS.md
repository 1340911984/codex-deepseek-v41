# DSCodex install instructions for coding agents

This repository adds DeepSeek V4.1 Flash to the stock ChatGPT / Codex app through a loopback router.
If a user asks you to install it, follow the "Install by a coding agent" section in `README.md`.
The non-negotiable details:

1. Never print or commit the DeepSeek API key. Persist it with `node src/cli.mjs key set`
   (`DEEPSEEK_API_KEY` env or the hidden prompt); it is stored at
   `~/.codex/dscodex/config.json` with mode 0600 (DPAPI-encrypted on Windows) and survives logout/reboot. Resolution order at
   runtime: `DEEPSEEK_API_KEY` env (one-off override), then the stored file, then the legacy macOS
   login-session value. Never store the key in `~/.codex/config.toml`; `uninstall` deletes the
   stored key file.
2. Run `node src/cli.mjs install`, then `node src/cli.mjs start`, then
   `node src/cli.mjs doctor`. Doctor must report `ok` for config, catalog, router token, proxy, key,
   and the app-server bridge state. The app-server bridge is opt-in (`node src/cli.mjs bridge enable`)
   because a global `CODEX_CLI_PATH` demotes the app from its local daemon websocket (which
   supports reconnect) to stdio and breaks Computer Use; `install` therefore never sets it and
   actively removes DSCodex-owned copies left by older versions, including any `CODEX_CLI_PATH`
   the Codex app snapshotted into `[mcp_servers.*.env]`. When enabled, `bridge enable` must refuse
   a user-owned `CODEX_CLI_PATH`; the variable must point at the generated shim
   `~/.codex/dscodex/codex-cli-bridge.sh`, never directly at `src/codex-wrapper.mjs`: GUI apps get
   a bare launchd PATH without Homebrew, so a `#!/usr/bin/env node` shebang fails there. The shim
   resolves node from PATH at runtime and only falls back to the absolute path baked at install
   time. The wrapper must resolve the stock Codex binary through the shared fallback chain
   (`src/real-codex.mjs`) instead of exiting when `DSCODEX_REAL_CODEX` is missing: launchctl login
   variables do not survive reboots, and a stale `CODEX_CLI_PATH` must degrade to stock Codex, not
   hard-fail every spawn. The bridge is macOS-only: Windows desktop apps spawn `CODEX_CLI_PATH`
   directly and cannot run a script shim (CreateProcess requires an `.exe`), so on Windows the
   bridge is unavailable and the `doctor` bridge check passes trivially.
3. Run `npm test`; all tests must pass.
4. The ChatGPT desktop app must be fully quit (`⌘Q`) and relaunched, and the user must start a NEW
   task to see `DeepSeek V4.1 Flash`. Existing tasks keep their old model state.
5. Verify with a real tool loop using
   `codex -m deepseek/deepseek-flash -c 'model_reasoning_effort="high"' -a never exec
   --skip-git-repo-check 'call a shell tool exactly once …'`.
6. Do not edit `~/.codex/config.toml` by hand unless the user asks; the CLI owns its two
   marker-owned root keys. GUI-written `model` / `model_reasoning_effort` lines are user-owned and
   must be preserved.
7. Provider selection memory lives in `~/.codex/dscodex/model-selections.json`. OpenAI and
   DeepSeek have separate reasoning-effort slots; only OpenAI owns the saved service tier. The
   file also persists per-thread provider memory (bounded, last 500 threads) so resumed threads
   switch like live ones, and a `staleEffort` marker so a model-only config write never leaks the
   other provider's effort into a new session. The wrapper must forward all other app-server
   JSONL RPC unchanged to the stock Codex binary. When a task switches from DeepSeek back to GPT,
   the HTTP router must remove only plaintext DeepSeek `reasoning` items that lack OpenAI
   `encrypted_content`; preserve messages, tool history, and genuine encrypted OpenAI reasoning.
   Re-serialized compressed requests must not retain their original `content-encoding` header.
8. DeepSeek V4.1 accepts images natively, so the router forwards `input_image` parts in
   DeepSeek-bound bodies (message content and `view_image` `function_call_output` results) to
   `api.deepseek.com` unchanged. No second provider may be asked to describe them. Keep
   `input_modalities = ["text", "image"]` on the catalog entry, or the desktop `view_image` gate
   rejects calls before images ever reach the router.
   A DeepSeek-bound request must not carry ChatGPT credentials: `copyRequestHeaders` forwards only
   `user-agent` on that route and injects the DeepSeek key, while the ChatGPT route keeps the
   caller's `authorization`, `chatgpt-account-id` and attestation headers.
9. Autostart is opt-in: `node src/cli.mjs autostart enable` (launchd `com.dscodex.router` on
   macOS, systemd user service `dscodex.service` on Linux, Task Scheduler `DSCodex` plus a hidden
   wscript shim on Windows). The generated plist/unit/VBS must never embed the DeepSeek API key —
   the router resolves it from the stored key file at runtime. KeepAlive/Restart only cover
    crashes: `stop` uses the authenticated shutdown endpoint, the router exits 0 gracefully, and it must stay down. The
   `serve` process owns `~/.codex/dscodex/server.pid` no matter who launched it, so `stop` works
   for autostarted instances too. `uninstall` must disable autostart and delete the generated
   artifacts.
10. The router must reach chatgpt.com for GPT passthrough. Node's fetch ignores
    proxy environment variables by default, so DSCodex resolves a proxy itself — order:
    `DSCODEX_HTTPS_PROXY` / `DSCODEX_HTTP_PROXY`, then standard proxy variables (Node gives
    lowercase names precedence), then the
    stored `proxy_url` written by `node src/cli.mjs proxy set <url>` in
    `~/.codex/dscodex/config.json` — and re-execs itself with Node's `--use-env-proxy`
    (requires Node >= 24.5; uppercase and lowercase proxy variables are synchronized, and
    `NO_PROXY` always includes loopback plus `api.deepseek.com`). Proxy credentials are redacted
    in CLI output and DPAPI-protected on Windows; the proxy URL must never be confused with the
    DeepSeek key, which stays DPAPI/0600-protected and is never printed or committed.
11. `install` generates a 256-bit router token and writes it into the managed `openai_base_url`;
    `start` / `serve` must reconcile that marker-owned URL with the persisted token and selected
    port, and `doctor` must verify the exact binding. The proxy must reject requests without that
    path token. `serve` owns a 0600 pid-state file with a per-instance shutdown token. `stop` may
    only use the authenticated shutdown endpoint and must atomically preserve replacement-instance
    state; it must never terminate an unverified or recycled PID. Cap both compressed request bytes
    and decompressed request bytes before parsing JSON.
12. DeepSeek does not implement Codex remote compaction v2. For a DeepSeek-bound request containing
    `compaction_trigger`, the router must remove tools and the trigger, ask the same DeepSeek model
    for a compact handoff summary, and return exactly one synthetic `compaction` output item before
    `response.completed`. Encrypt the summary with AES-256-GCM using a key derived from the stable
    router token; on later DeepSeek requests, decrypt only DSCodex-prefixed compaction items and
    restore them as assistant summary context. Never route compaction through GPT or store the
    summary as plaintext in the rollout file.
