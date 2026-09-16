import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppServerState } from "../src/app-server-state.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dscodex-app-server-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "dscodex", "model-selections.json");
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "xhigh"\nservice_tier = "priority"\n');
  return { configPath, statePath };
}

test("rewrites default picker transitions with independent provider slots", () => {
  const paths = fixture();
  const bridge = createAppServerState(paths);
  const toDeepSeek = {
    id: 1,
    method: "config/batchWrite",
    params: {
      edits: [
        { keyPath: "model", value: "deepseek/deepseek-flash", mergeStrategy: "upsert" },
        { keyPath: "model_reasoning_effort", value: "xhigh", mergeStrategy: "upsert" },
      ],
    },
  };
  bridge.rewriteClient(toDeepSeek);
  assert.equal(toDeepSeek.params.edits[1].value, "max");

  const deepSeekHigh = {
    id: 2,
    method: "config/batchWrite",
    params: { edits: [{ keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" }] },
  };
  bridge.rewriteClient(deepSeekHigh);
  assert.equal(deepSeekHigh.params.edits[0].value, "high");

  const toOpenAi = {
    id: 3,
    method: "config/batchWrite",
    params: {
      edits: [
        { keyPath: "model", value: "gpt-5.6-sol", mergeStrategy: "upsert" },
        { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
      ],
    },
  };
  bridge.rewriteClient(toOpenAi);
  assert.equal(toOpenAi.params.edits[1].value, "xhigh");

  const persisted = JSON.parse(readFileSync(paths.statePath, "utf8"));
  assert.equal(persisted.openai.reasoningEffort, "xhigh");
  assert.equal(persisted.openai.serviceTier, "priority");
  assert.equal(persisted.deepseek.reasoningEffort, "high");
});

test("rewrites live thread switches and restores GPT-only speed", () => {
  const paths = fixture();
  const bridge = createAppServerState(paths);
  const start = {
    id: 10,
    method: "thread/start",
    params: { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, serviceTier: "priority" },
  };
  bridge.rewriteClient(start);
  bridge.rewriteServer({
    id: 10,
    result: {
      thread: { id: "thread-1" },
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      serviceTier: "priority",
    },
  });

  const toDeepSeek = {
    id: 11,
    method: "thread/settings/update",
    params: { threadId: "thread-1", model: "deepseek/deepseek-flash", effort: "xhigh" },
  };
  bridge.rewriteClient(toDeepSeek);
  assert.equal(toDeepSeek.params.effort, "max");
  assert.equal(toDeepSeek.params.serviceTier, null);

  const deepSeekHigh = {
    id: 12,
    method: "thread/settings/update",
    params: { threadId: "thread-1", effort: "high" },
  };
  bridge.rewriteClient(deepSeekHigh);
  assert.equal(deepSeekHigh.params.effort, "high");

  const toOpenAi = {
    id: 13,
    method: "thread/settings/update",
    params: { threadId: "thread-1", model: "gpt-5.6-sol", effort: "high" },
  };
  bridge.rewriteClient(toOpenAi);
  assert.equal(toOpenAi.params.effort, "xhigh");
  assert.equal(toOpenAi.params.serviceTier, "priority");

  const backToDeepSeek = {
    id: 14,
    method: "thread/settings/update",
    params: { threadId: "thread-1", model: "deepseek/deepseek-flash", effort: "xhigh" },
  };
  bridge.rewriteClient(backToDeepSeek);
  assert.equal(backToDeepSeek.params.effort, "high");
  assert.equal(backToDeepSeek.params.serviceTier, null);
});

test("persists slots across app-server bridge restarts", () => {
  const paths = fixture();
  const first = createAppServerState(paths);
  first.rewriteClient({
    id: 1,
    method: "config/batchWrite",
    params: { edits: [
      { keyPath: "model", value: "deepseek/deepseek-flash", mergeStrategy: "upsert" },
      { keyPath: "model_reasoning_effort", value: "xhigh", mergeStrategy: "upsert" },
    ] },
  });
  first.rewriteClient({
    id: 2,
    method: "config/batchWrite",
    params: { edits: [{ keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" }] },
  });

  const second = createAppServerState(paths);
  const toOpenAi = {
    id: 3,
    method: "config/batchWrite",
    params: { edits: [
      { keyPath: "model", value: "gpt-5.6-sol", mergeStrategy: "upsert" },
      { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
    ] },
  };
  second.rewriteClient(toOpenAi);
  assert.equal(toOpenAi.params.edits[1].value, "xhigh");
});

test("learns the saved provider effort when an existing thread resumes", () => {
  const paths = fixture();
  const bridge = createAppServerState(paths);
  bridge.rewriteClient({ id: 1, method: "thread/resume", params: { threadId: "thread-old" } });
  bridge.rewriteServer({
    id: 1,
    result: {
      thread: { id: "thread-old" },
      model: "deepseek/deepseek-flash",
      reasoningEffort: "high",
      serviceTier: null,
    },
  });

  const toOpenAi = {
    id: 2,
    method: "thread/settings/update",
    params: { threadId: "thread-old", model: "gpt-5.6-sol", effort: "high" },
  };
  bridge.rewriteClient(toOpenAi);
  const backToDeepSeek = {
    id: 3,
    method: "thread/settings/update",
    params: { threadId: "thread-old", model: "deepseek/deepseek-flash", effort: "xhigh" },
  };
  bridge.rewriteClient(backToDeepSeek);
  assert.equal(backToDeepSeek.params.effort, "high");
});

test("untracked thread switches restore the slot instead of adopting the carried effort", () => {
  const paths = fixture();
  const bridge = createAppServerState(paths);
  bridge.rewriteClient({
    id: 1,
    method: "config/batchWrite",
    params: { edits: [
      { keyPath: "model", value: "deepseek/deepseek-flash", mergeStrategy: "upsert" },
      { keyPath: "model_reasoning_effort", value: "max", mergeStrategy: "upsert" },
    ] },
  });

  // A thread this bridge never tracked (started before a restart, another window,
  // a fork) switches to GPT while echoing the thread's current DeepSeek Max effort.
  const update = {
    id: 2,
    method: "thread/settings/update",
    params: { threadId: "ghost-thread", model: "gpt-5.6-sol", effort: "max" },
  };
  bridge.rewriteClient(update);
  assert.equal(update.params.effort, "xhigh");
  assert.equal(update.params.serviceTier, "priority");

  const persisted = JSON.parse(readFileSync(paths.statePath, "utf8"));
  assert.equal(persisted.openai.reasoningEffort, "xhigh");
  assert.equal(persisted.deepseek.reasoningEffort, "max");
});

test("thread provider memory survives bridge restarts", () => {
  const paths = fixture();
  const first = createAppServerState(paths);
  first.rewriteClient({
    id: 1,
    method: "thread/start",
    params: { model: "deepseek/deepseek-flash", config: {} },
  });
  first.rewriteServer({
    id: 1,
    result: {
      thread: { id: "thread-9" },
      model: "deepseek/deepseek-flash",
      reasoningEffort: "max",
      serviceTier: null,
    },
  });

  const second = createAppServerState(paths);
  const update = {
    id: 2,
    method: "thread/settings/update",
    params: { threadId: "thread-9", model: "gpt-5.6-sol", effort: "max" },
  };
  second.rewriteClient(update);
  assert.equal(update.params.effort, "xhigh");
  assert.equal(update.params.serviceTier, "priority");
});

test("model-only config writes mark the effort stale so new sessions restore the slot", () => {
  const paths = fixture();
  const bridge = createAppServerState(paths);
  bridge.rewriteClient({
    id: 1,
    method: "config/batchWrite",
    params: { edits: [
      { keyPath: "model", value: "deepseek/deepseek-flash", mergeStrategy: "upsert" },
      { keyPath: "model_reasoning_effort", value: "max", mergeStrategy: "upsert" },
    ] },
  });

  // A model-only write leaves model_reasoning_effort = "max" in config.toml.
  bridge.rewriteClient({
    id: 2,
    method: "config/value/write",
    params: { keyPath: "model", value: "gpt-5.6-sol", mergeStrategy: "upsert" },
  });

  // New sessions echo the stale config effort; the bridge restores the OpenAI slot.
  const start = {
    id: 3,
    method: "thread/start",
    params: { model: "gpt-5.6-sol", config: { model_reasoning_effort: "max" } },
  };
  bridge.rewriteClient(start);
  assert.equal(start.params.config.model_reasoning_effort, "xhigh");

  // The file is still stale, so the next new session is corrected again.
  const again = {
    id: 4,
    method: "thread/start",
    params: { model: "gpt-5.6-sol", config: { model_reasoning_effort: "max" } },
  };
  bridge.rewriteClient(again);
  assert.equal(again.params.config.model_reasoning_effort, "xhigh");

  // An explicit effort write re-syncs config.toml and re-enables adopting.
  bridge.rewriteClient({
    id: 5,
    method: "config/batchWrite",
    params: { edits: [{ keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" }] },
  });
  const adopt = {
    id: 6,
    method: "thread/start",
    params: { model: "gpt-5.6-sol", config: { model_reasoning_effort: "max" } },
  };
  bridge.rewriteClient(adopt);
  assert.equal(adopt.params.config.model_reasoning_effort, "max");
});
