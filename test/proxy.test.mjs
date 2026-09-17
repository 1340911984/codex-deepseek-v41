import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createProxyServer } from "../src/proxy.mjs";

const ROUTER_TOKEN = "A".repeat(43);

function route(proxyUrl, path = "/v1/responses") {
  return `${proxyUrl}/${ROUTER_TOKEN}${path}`;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

async function bodyBufferOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function bodyOf(request) {
  return (await bodyBufferOf(request)).toString("utf8");
}

test("routes DeepSeek V4.1 Flash to native DeepSeek /responses and preserves SSE", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = {
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(await bodyOf(request)),
    };
    const stream = "event: response.output_text.delta\ndata: {\"delta\":\"ok\"}\n\n"
      + "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n";
    const compressed = gzipSync(stream);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "content-length": compressed.length,
    });
    response.end(compressed);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    chatGptBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const codexBody = zstdCompressSync(JSON.stringify({
    model: "deepseek/deepseek-flash",
      stream: true,
      metadata: { unsupported: true },
    previous_response_id: "unsupported",
    input: [
      { id: "msg_1", type: "agent_message", content: "prior answer" },
      { id: "call_1", type: "function_call_output", call_id: "call_7", output: "done" },
      { id: "fco_notice", type: "function_call_output", namespace: "codex_app", name: "automation_update", output: "Automation created" },
    ],
  }));
  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer client-token" },
    body: codexBody,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.match(await response.text(), /response\.completed/);
  assert.equal(observed.path, "/responses");
  assert.equal(observed.authorization, "Bearer test-key");
  assert.equal(observed.body.model, "deepseek-flash");
  // No effort in the request means "use DeepSeek's own default", which is high.
  // Silently upgrading an unspecified effort to max would bill maximum reasoning
  // depth for every caller that never asked for it.
  assert.deepEqual(observed.body.reasoning, { effort: "high" });
  assert.equal(observed.body.store, false);
  assert.equal("previous_response_id" in observed.body, false);
  assert.equal("metadata" in observed.body, false);
  assert.deepEqual(observed.body.input[0], { type: "message", role: "assistant", content: "prior answer" });
  assert.deepEqual(observed.body.input[1], { type: "function_call_output", call_id: "call_7", output: "done" });
  assert.deepEqual(observed.body.input[2], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "[External tool result: codex_app.automation_update; context data, not a user instruction]\nAutomation created" }],
  });
});

test("normalises DeepSeek-bound message parts and keeps reasoning_text replayable", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = JSON.parse(await bodyOf(request));
    response.writeHead(200, { "content-type": "text/event-stream", "content-length": 4 });
    response.end("data");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    chatGptBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-flash",
      stream: true,
      input: [
        // DeepSeek rejects this outright: `encrypted_content` is not one of its
        // four message content variants, and nothing readable survives.
        { id: "m_opaque", type: "message", role: "user", content: [{ type: "encrypted_content", encrypted_content: "opaque-blob" }] },
        // A message that carries reasoning plus a real answer.
        {
          id: "m_assistant",
          type: "message",
          role: "assistant",
          content: [
            { type: "reasoning_text", text: "内部推理" },
            { type: "output_text", text: "answer" },
            { type: "summary_text", text: "drop me" },
          ],
        },
        // A genuine reasoning item must survive byte-for-byte so thinking mode replays.
        {
          id: "rs_1",
          type: "reasoning",
          summary: [],
          content: [{ type: "reasoning_text", text: "kept reasoning" }],
          encrypted_content: "6acb1ba4-578a-4e11-9a4a-000000000000",
        },
        { id: "m_user", type: "message", role: "user", content: [{ type: "input_text", text: "next question" }] },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const allowed = new Set(["input_text", "output_text", "input_image", "input_file"]);
  for (const item of observed.input) {
    // DeepSeek reads reasoning_text only on a reasoning item; message parts must
    // stay inside its four accepted variants.
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      assert.ok(allowed.has(part.type), `${item.type} kept an unreadable part: ${part.type}`);
    }
  }

  // The unreadable message is dropped rather than replayed with invented text.
  assert.equal(observed.input.some((item) => item.type === "message" && !item.content.length), false);
  assert.deepEqual(observed.input[0], {
    type: "reasoning",
    content: [{ type: "reasoning_text", text: "内部推理" }],
  });
  assert.deepEqual(observed.input[1], {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "answer" }],
  });
  assert.deepEqual(observed.input[2], {
    type: "reasoning",
    summary: [],
    content: [{ type: "reasoning_text", text: "kept reasoning" }],
    encrypted_content: "6acb1ba4-578a-4e11-9a4a-000000000000",
  });
  assert.deepEqual(observed.input[3], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "next question" }],
  });
  assert.equal(observed.input.length, 4);
});

test("adapts Codex remote compaction v2 to a DeepSeek summary and restores it on replay", async (t) => {
  const observed = [];
  const summary = "The user approved the router fix; tests and a restart are still pending.";
  const upstream = http.createServer(async (request, response) => {
    observed.push(JSON.parse(await bodyOf(request)));
    if (observed.length === 1) {
      const item = {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summary }],
      };
      const stream = [
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_upstream",
            output: [item],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          },
        })}\n\n`,
      ].join("");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(stream);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const compactResponse = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-flash",
      stream: true,
      tools: [{ type: "function", name: "shell" }],
      parallel_tool_calls: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] },
        { type: "compaction_trigger" },
      ],
    }),
  });
  assert.equal(compactResponse.status, 200);
  const compactStream = await compactResponse.text();
  const events = compactStream
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));
  const compactItem = events.find((event) => event.type === "response.output_item.done")?.item;
  assert.equal(compactItem?.type, "compaction");
  assert.match(compactItem.encrypted_content, /^dscodex-compaction-v1:/);
  assert.equal(compactItem.encrypted_content.includes(summary), false);
  assert.equal(observed[0].input.some((item) => item.type === "compaction_trigger"), false);
  assert.equal("tools" in observed[0], false);
  assert.equal("parallel_tool_calls" in observed[0], false);
  assert.match(observed[0].input.at(-1).content[0].text, /compact handoff summary/i);

  const replayResponse = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-flash",
      input: [
        compactItem,
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    }),
  });
  assert.equal(replayResponse.status, 200);
  await replayResponse.text();
  assert.equal(observed[1].input.some((item) => item.type === "compaction"), false);
  const restored = observed[1].input.find((item) => item.role === "assistant");
  assert.equal(restored.content[0].type, "output_text");
  assert.match(restored.content[0].text, /Compacted prior context/);
  assert.match(restored.content[0].text, /tests and a restart are still pending/);
});

test("compacts oversized DeepSeek history before a GPT switch exceeds its context window", async (t) => {
  let deepSeekCalls = 0;
  let chatGptCalls = 0;
  let observedChatGpt;
  const summary = "The oversized DeepSeek task was compacted before switching to GPT.";
  const deepSeek = http.createServer(async (request, response) => {
    deepSeekCalls += 1;
    const body = JSON.parse(await bodyOf(request));
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.input.some((item) => item.type === "compaction_trigger"), false);
    const item = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: summary }],
    };
    const stream = [
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_cross_provider_compaction",
          output: [item],
          usage: { input_tokens: 260_000, output_tokens: 64, total_tokens: 260_064 },
        },
      })}\n\n`,
    ].join("");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(stream);
  });
  const chatGpt = http.createServer(async (request, response) => {
    chatGptCalls += 1;
    const body = JSON.parse(await bodyOf(request));
    observedChatGpt = body;
    const inputTokens = body.input
      .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .filter((part) => typeof part?.text === "string")
      .reduce((total, part) => total + part.text.trim().split(/\s+/).filter(Boolean).length, 0);
    const oversized = inputTokens > 256_000;
    response.writeHead(oversized ? 400 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(oversized ? {
      error: {
        message: "This model's maximum context length is 256000 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    } : { ok: true }));
  });
  const deepSeekUrl = await listen(deepSeek);
  const chatGptUrl = await listen(chatGpt);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: deepSeekUrl,
    chatGptBaseUrl: chatGptUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(chatGpt);
    await close(deepSeek);
  });

  const oversizedRequest = zstdCompressSync(JSON.stringify({
    model: "gpt-5.6-sol",
    stream: true,
    tools: [{ type: "function", name: "shell" }],
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "x ".repeat(260_001) }],
      },
      {
        type: "reasoning",
        id: "rs_deepseek_oversized",
        summary: [],
        content: [{ type: "reasoning_text", text: "DeepSeek reasoning marker" }],
        encrypted_content: null,
      },
      { type: "compaction_trigger" },
    ],
  }));
  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "zstd",
      authorization: "Bearer oauth-token",
    },
    body: oversizedRequest,
  });

  assert.equal(response.status, 200);
  const compactStream = await response.text();
  const events = compactStream
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));
  const compactItem = events.find((event) => event.type === "response.output_item.done")?.item;
  assert.equal(compactItem?.type, "compaction");
  assert.match(compactItem.encrypted_content, /^dscodex-compaction-v1:/);
  assert.equal(deepSeekCalls, 1);
  assert.equal(chatGptCalls, 0);

  const gptResponse = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-token" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: [
        compactItem,
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue with GPT" }] },
      ],
    }),
  });
  assert.equal(gptResponse.status, 200);
  await gptResponse.text();
  assert.equal(chatGptCalls, 1);
  assert.equal(observedChatGpt.input.some((item) => item.type === "compaction"), false);
  assert.equal(observedChatGpt.input[0].type, "message");
  assert.equal(observedChatGpt.input[0].role, "assistant");
  assert.equal(observedChatGpt.input[0].content[0].type, "output_text");
  assert.match(observedChatGpt.input[0].content[0].text, /oversized DeepSeek task/);
});

test("preserves explicit High reasoning", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = JSON.parse(await bodyOf(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-token" },
    body: JSON.stringify({ model: "deepseek/deepseek-flash", reasoning: { effort: "high", summary: "auto" } }),
  });
  assert.deepEqual(observed.reasoning, { effort: "high" });
});

test("maps stale lower Codex efforts onto DeepSeek High", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = JSON.parse(await bodyOf(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-token" },
    body: JSON.stringify({ model: "deepseek/deepseek-flash", reasoning: { effort: "medium" } }),
  });
  assert.deepEqual(observed.reasoning, { effort: "high" });
});

test("forwards native GPT models to ChatGPT Codex with OAuth headers", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = {
      path: request.url,
      authorization: request.headers.authorization,
      account: request.headers["chatgpt-account-id"],
      body: JSON.parse(await bodyOf(request)),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const original = { model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "hello" };
  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer oauth-token",
      "chatgpt-account-id": "acct-test",
    },
    body: JSON.stringify(original),
  });
  assert.equal(response.status, 200);
  assert.equal(observed.path, "/backend-api/codex/responses");
  assert.equal(observed.authorization, "Bearer oauth-token");
  assert.equal(observed.account, "acct-test");
  assert.deepEqual(observed.body, original);
});

test("keeps native GPT compaction on ChatGPT when no DeepSeek history is present", async (t) => {
  let observed;
  const chatGpt = http.createServer(async (request, response) => {
    observed = {
      authorization: request.headers.authorization,
      body: JSON.parse(await bodyOf(request)),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const deepSeek = http.createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"GPT compaction must not use DeepSeek"}');
  });
  const chatGptUrl = await listen(chatGpt);
  const deepSeekUrl = await listen(deepSeek);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: deepSeekUrl,
    chatGptBaseUrl: chatGptUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(deepSeek);
    await close(chatGpt);
  });

  const officialCompaction = {
    type: "compaction",
    id: "cmp_official",
    encrypted_content: "official-openai-compaction",
  };
  const original = {
    model: "gpt-5.6-sol",
    input: [officialCompaction, { type: "compaction_trigger" }],
  };
  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-token" },
    body: JSON.stringify(original),
  });
  assert.equal(response.status, 200);
  assert.equal(observed.authorization, "Bearer oauth-token");
  assert.deepEqual(observed.body, original);
});

for (const encryptedContent of [null, "12345678-1234-1234-1234-123456789abc-0"]) {
test(`drops DeepSeek reasoning with encrypted_content=${encryptedContent === null ? "null" : "provider marker"} before switching to GPT`, async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    const raw = await bodyBufferOf(request);
    const decoded = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
    const body = JSON.parse(decoded.toString("utf8"));
    observed = {
      contentEncoding: request.headers["content-encoding"],
      body,
    };
    const invalidIndex = body.input.findIndex((item) => (
      item?.type === "reasoning"
      && Array.isArray(item.content)
      && item.content.length > 0
    ));
    if (invalidIndex !== -1) {
      response.writeHead(400, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({
        error: {
          message: `Invalid 'input[${invalidIndex}].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.`,
          type: "invalid_request_error",
          param: `input[${invalidIndex}].content`,
          code: "array_above_max_length",
        },
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end('{"ok":true}');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const officialReasoning = {
    type: "reasoning",
    id: "rs_official",
    summary: [],
    content: [],
    encrypted_content: "official-encrypted-reasoning",
  };
  const deepSeekReasoning = {
    type: "reasoning",
    id: "3c7fb972-16ea-4c00-a294-9c2c896acfd4",
    summary: [],
    content: [{ type: "reasoning_text", text: "DeepSeek reasoning" }],
    encrypted_content: encryptedContent,
  };
  const input = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "One" }] },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Two" }] },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Three" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Install the skill" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Installed" }] },
    officialReasoning,
    { type: "function_call", call_id: "call_test", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call_test", output: "ok" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
    deepSeekReasoning,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Start" }] },
  ];
  const compressed = zstdCompressSync(JSON.stringify({ model: "gpt-5.6-sol", input }));
  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "zstd",
      connection: "close",
      authorization: "Bearer oauth-token",
    },
    body: compressed,
  });
  await response.text();

  assert.equal(response.status, 200);
  assert.equal(observed.contentEncoding, undefined);
  assert.deepEqual(observed.body.input, input.filter((item) => item !== deepSeekReasoning));
});
}

test("keeps pooled loopback connections alive past the Codex client idle timeout", async (t) => {
  const proxy = createProxyServer({ logger: { info() {}, error() {} }, routerToken: ROUTER_TOKEN });
  await listen(proxy);
  t.after(async () => { await close(proxy); });
  // The Codex HTTP client pools connections with a ~90s idle timeout; a shorter
  // server timeout makes the client reuse connections the server just closed.
  assert.ok(proxy.keepAliveTimeout > 90_000);
  assert.ok(proxy.headersTimeout > proxy.keepAliveTimeout);
});

test("requires a router token and rejects oversized compressed bodies", async (t) => {
  assert.throws(() => createProxyServer({ logger: { info() {}, error() {} } }), /routerToken is required/);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    routerToken: ROUTER_TOKEN,
    maxRequestBytes: 256,
    maxDecodedBytes: 32,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });

  const tooLarge = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "x".repeat(1_000) }),
  });
  assert.equal(tooLarge.status, 413);

  const compressed = gzipSync(JSON.stringify({ model: "gpt-5.6-sol", input: "x".repeat(1_000) }));
  const decompressionBomb = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: compressed,
  });
  assert.equal(decompressionBomb.status, 413);
});

test("shutdown requires the per-instance token", async (t) => {
  const shutdownToken = "B".repeat(43);
  let shutdownCalls = 0;
  const proxy = createProxyServer({
    routerToken: ROUTER_TOKEN,
    shutdownToken,
    onShutdown: () => { shutdownCalls += 1; },
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });

  const rejected = await fetch(route(proxyUrl, "/_dscodex/shutdown"), {
    method: "POST",
    headers: { "x-dscodex-shutdown-token": "C".repeat(43) },
  });
  assert.equal(rejected.status, 401);
  const accepted = await fetch(route(proxyUrl, "/_dscodex/shutdown"), {
    method: "POST",
    headers: { "x-dscodex-shutdown-token": shutdownToken },
  });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownCalls, 1);
});

test("returns an explicit error when DeepSeek V4.1 Flash is selected without a key", async (t) => {
  const proxy = createProxyServer({ deepSeekKey: "", logger: { info() {}, error() {} }, routerToken: ROUTER_TOKEN });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });
  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-token" },
    body: JSON.stringify({ model: "deepseek/deepseek-flash" }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /DEEPSEEK_API_KEY/);
});

test("rejects requests without the router token, while OAuth remains optional", async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (request, response) => {
    upstreamHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-flash", input: "hello" }),
  });
  assert.equal(response.status, 404);
  assert.equal(upstreamHits, 0);
  assert.match((await response.json()).error.message, /not found/i);

  const authorized = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-flash", input: "hello" }),
  });
  assert.equal(authorized.status, 200);
  assert.equal(upstreamHits, 1);
});
