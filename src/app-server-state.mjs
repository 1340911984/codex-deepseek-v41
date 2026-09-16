import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEEPSEEK_PICKER_SLUG, DEEPSEEK_WIRE_MODEL } from "./constants.mjs";

const VERSION = 1;
const STANDARD_TIER = "default";
const MAX_TRACKED_THREADS = 500;
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

function providerFor(model) {
  return model === DEEPSEEK_PICKER_SLUG || model === DEEPSEEK_WIRE_MODEL ? "deepseek" : "openai";
}

function normalizeEffort(provider, effort) {
  if (!VALID_EFFORTS.has(effort)) return null;
  if (provider === "deepseek") return effort === "high" ? "high" : "max";
  return effort;
}

function rootString(content, key) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const end = lines.findIndex((line) => /^\s*\[/.test(line));
  const root = end === -1 ? lines : lines.slice(0, end);
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`);
  for (const line of root) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return null;
}

function initialState(configPath) {
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const model = rootString(config, "model") ?? "gpt-5.6-sol";
  const activeProvider = providerFor(model);
  const effort = rootString(config, "model_reasoning_effort");
  const state = {
    version: VERSION,
    activeProvider,
    openai: {
      reasoningEffort: "high",
      serviceTier: rootString(config, "service_tier") ?? STANDARD_TIER,
    },
    deepseek: { reasoningEffort: "max" },
    // True when a model-only config write left config.toml's effort line belonging
    // to the other provider; thread/start must then restore the slot, not adopt it.
    staleEffort: false,
    threads: {},
  };
  const normalized = normalizeEffort(activeProvider, effort);
  if (normalized) state[activeProvider].reasoningEffort = normalized;
  return state;
}

function loadState(statePath, configPath) {
  if (!existsSync(statePath)) return initialState(configPath);
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    if (value?.version !== VERSION) return initialState(configPath);
    return {
      version: VERSION,
      activeProvider: value.activeProvider === "deepseek" ? "deepseek" : "openai",
      openai: {
        reasoningEffort: normalizeEffort("openai", value.openai?.reasoningEffort) ?? "high",
        serviceTier: typeof value.openai?.serviceTier === "string"
          ? value.openai.serviceTier
          : STANDARD_TIER,
      },
      deepseek: {
        reasoningEffort: normalizeEffort("deepseek", value.deepseek?.reasoningEffort) ?? "max",
      },
      staleEffort: value.staleEffort === true,
      threads: value.threads && typeof value.threads === "object" ? value.threads : {},
    };
  } catch {
    return initialState(configPath);
  }
}

function reviveThreads(value) {
  const entries = Object.entries(value).slice(-MAX_TRACKED_THREADS);
  const map = new Map();
  for (const [threadId, entry] of entries) {
    if (!entry || typeof entry !== "object") continue;
    map.set(threadId, {
      activeProvider: entry.activeProvider === "deepseek" ? "deepseek" : "openai",
      model: typeof entry.model === "string" ? entry.model : null,
    });
  }
  return map;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function requestKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function keyName(keyPath) {
  return keyPath.split(".").at(-1);
}

function tierForThread(value) {
  return value === STANDARD_TIER ? null : value;
}

export function createAppServerState({ statePath, configPath }) {
  const { threads: persistedThreads, ...state } = loadState(statePath, configPath);
  const threads = reviveThreads(persistedThreads);
  const pending = new Map();

  function save() {
    const persisted = {
      ...state,
      threads: Object.fromEntries([...threads].slice(-MAX_TRACKED_THREADS)),
    };
    atomicWrite(statePath, `${JSON.stringify(persisted, null, 2)}\n`);
  }

  function trackThread(threadId, value) {
    threads.delete(threadId);
    threads.set(threadId, value);
    if (threads.size > MAX_TRACKED_THREADS) threads.delete(threads.keys().next().value);
  }

  function rememberEffort(provider, effort) {
    const normalized = normalizeEffort(provider, effort);
    if (normalized) state[provider].reasoningEffort = normalized;
    return normalized;
  }

  function switchDefaults(model, incomingEffort) {
    const provider = providerFor(model);
    if (provider !== state.activeProvider) {
      state.activeProvider = provider;
      return state[provider].reasoningEffort;
    }
    return rememberEffort(provider, incomingEffort) ?? state[provider].reasoningEffort;
  }

  function rewriteConfigBatch(params) {
    if (!Array.isArray(params?.edits)) return;
    const modelEdit = params.edits.find((edit) => keyName(edit.keyPath) === "model");
    const effortEdit = params.edits.find((edit) => keyName(edit.keyPath) === "model_reasoning_effort");
    const tierEdit = params.edits.find((edit) => keyName(edit.keyPath) === "service_tier");
    if (modelEdit && typeof modelEdit.value === "string") {
      const effort = switchDefaults(modelEdit.value, effortEdit?.value);
      if (effortEdit) effortEdit.value = effort;
      else params.edits.push({
        keyPath: modelEdit.keyPath.replace(/model$/, "model_reasoning_effort"),
        value: effort,
        mergeStrategy: "upsert",
      });
    } else if (effortEdit) {
      const effort = rememberEffort(state.activeProvider, effortEdit.value);
      if (effort) effortEdit.value = effort;
    }
    // A batch write pushes the corrected effort into config.toml, re-syncing the file.
    if (modelEdit || effortEdit) state.staleEffort = false;
    if (tierEdit && state.activeProvider === "openai" && typeof tierEdit.value === "string") {
      state.openai.serviceTier = tierEdit.value;
    }
    save();
  }

  function rewriteConfigValue(params) {
    if (!params?.keyPath) return;
    const name = keyName(params.keyPath);
    if (name === "model" && typeof params.value === "string") {
      const previous = state.activeProvider;
      switchDefaults(params.value, null);
      // A model-only write leaves the other provider's effort line in config.toml;
      // anything reading that line later must not adopt it. Cleared once an
      // explicit effort write (or a batch model write) re-syncs the file.
      if (state.activeProvider !== previous) state.staleEffort = true;
    } else if (name === "model_reasoning_effort") {
      const effort = rememberEffort(state.activeProvider, params.value);
      if (effort) {
        params.value = effort;
        state.staleEffort = false;
      }
    } else if (name === "service_tier" && state.activeProvider === "openai" && typeof params.value === "string") {
      state.openai.serviceTier = params.value;
    }
    save();
  }

  function rewriteThreadSettings(params) {
    if (!params?.threadId) return;
    // Threads this bridge never saw (started before a restart, another window, a
    // fork) default to the last active provider, not to the incoming model's
    // provider — otherwise a cross-provider switch looks like an in-provider
    // effort change and the carried-over effort (e.g. DeepSeek Max) is adopted.
    const thread = threads.get(params.threadId) ?? {
      activeProvider: state.activeProvider,
      model: null,
    };
    const provider = params.model ? providerFor(params.model) : thread.activeProvider;
    if (provider !== thread.activeProvider) {
      params.effort = state[provider].reasoningEffort;
      params.serviceTier = provider === "openai" ? tierForThread(state.openai.serviceTier) : null;
    } else {
      const effort = rememberEffort(provider, params.effort);
      if (effort) params.effort = effort;
      if (provider === "openai" && params.serviceTier !== undefined) {
        state.openai.serviceTier = params.serviceTier ?? STANDARD_TIER;
      }
    }
    thread.activeProvider = provider;
    if (params.model) thread.model = params.model;
    trackThread(params.threadId, thread);
    save();
  }

  function rewriteThreadStart(message) {
    const params = message.params ?? {};
    const model = params.model ?? params.config?.model;
    if (!model) return;
    const provider = providerFor(model);
    const incomingEffort = params.config?.model_reasoning_effort;
    // With a stale config effort line, the GUI echoes the other provider's value
    // on every new session; restore this provider's slot instead of adopting it.
    const effort = provider === state.activeProvider && state.staleEffort
      ? state[provider].reasoningEffort
      : switchDefaults(model, incomingEffort);
    params.config = { ...(params.config ?? {}), model_reasoning_effort: effort };
    params.serviceTier = provider === "openai" ? tierForThread(state.openai.serviceTier) : null;
    pending.set(requestKey(message.id), {
      kind: "thread",
      activeProvider: provider,
      model,
    });
    save();
  }

  function trackThreadRequest(message) {
    const params = message.params ?? {};
    if (!params.threadId) return;
    pending.set(requestKey(message.id), { kind: "resume", threadId: params.threadId });
  }

  function rewriteClient(message) {
    if (!message || typeof message !== "object") return message;
    switch (message.method) {
      case "config/batchWrite": rewriteConfigBatch(message.params); break;
      case "config/value/write": rewriteConfigValue(message.params); break;
      case "thread/start": rewriteThreadStart(message); break;
      case "thread/resume":
      case "thread/fork": trackThreadRequest(message); break;
      case "thread/settings/update": rewriteThreadSettings(message.params); break;
    }
    return message;
  }

  function rewriteServer(message) {
    if (!message || typeof message !== "object" || message.id === undefined) return message;
    const tracked = pending.get(requestKey(message.id));
    if (!tracked) return message;
    pending.delete(requestKey(message.id));
    if (message.error || !message.result) return message;
    const result = message.result;
    const threadId = result.thread?.id ?? tracked.threadId;
    const model = result.model ?? tracked.model;
    if (threadId && model) {
      const provider = providerFor(model);
      trackThread(threadId, { activeProvider: provider, model });
      rememberEffort(provider, result.reasoningEffort);
      if (provider === "openai" && result.serviceTier !== undefined) {
        state.openai.serviceTier = result.serviceTier ?? STANDARD_TIER;
      }
      save();
    }
    return message;
  }

  save();
  return { rewriteClient, rewriteServer };
}
