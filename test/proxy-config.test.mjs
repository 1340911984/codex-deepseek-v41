import assert from "node:assert/strict";
import test from "node:test";
import {
  envProxySupported,
  proxyEnvFor,
  proxySource,
  resolveProxy,
  usesEnvProxy,
} from "../src/proxy-config.mjs";

test("resolveProxy precedence: DSCODEX, then generic env, then stored", () => {
  assert.equal(
    resolveProxy({ DSCODEX_HTTPS_PROXY: "http://ds:1", HTTPS_PROXY: "http://generic:2" }, "http://stored:3"),
    "http://ds:1",
  );
  assert.equal(
    resolveProxy({ DSCODEX_HTTP_PROXY: "http://ds:1", HTTP_PROXY: "http://generic:2" }, "http://stored:3"),
    "http://ds:1",
  );
  assert.equal(resolveProxy({ HTTPS_PROXY: "http://generic:2" }, "http://stored:3"), "http://generic:2");
  assert.equal(resolveProxy({ HTTP_PROXY: "http://generic:2" }, "http://stored:3"), "http://generic:2");
  assert.equal(resolveProxy({ https_proxy: "http://lower:4" }, "http://stored:3"), "http://lower:4");
  assert.equal(resolveProxy({ HTTPS_PROXY: "http://upper:5", https_proxy: "http://lower:4" }, "http://stored:3"), "http://lower:4");
  assert.equal(resolveProxy({}, "  http://stored:3  "), "http://stored:3");
  assert.equal(resolveProxy({}, ""), "");
  assert.equal(resolveProxy({ HTTPS_PROXY: "   " }, ""), "");
});

test("proxySource names the winning source", () => {
  assert.equal(proxySource({ DSCODEX_HTTPS_PROXY: "x" }, ""), "DSCODEX_*_PROXY env");
  assert.equal(proxySource({ HTTPS_PROXY: "x" }, ""), "HTTP(S)_PROXY env");
  assert.equal(proxySource({}, "http://stored"), "stored in config.json");
  assert.equal(proxySource({}, ""), "");
});

test("envProxySupported requires Node 24.5+", () => {
  assert.equal(envProxySupported("v24.2.9"), false);
  assert.equal(envProxySupported("v24.3.0"), false);
  assert.equal(envProxySupported("v24.4.9"), false);
  assert.equal(envProxySupported("v24.5.0"), true);
  assert.equal(envProxySupported("v24.11.1"), true);
  assert.equal(envProxySupported("v25.0.0"), true);
  assert.equal(envProxySupported("v22.15.0"), false);
  assert.equal(envProxySupported("garbage"), false);
});

test("proxyEnvFor sets proxy env, loopback NO_PROXY, and the env-proxy flag", () => {
  const env = proxyEnvFor("http://127.0.0.1:10808", {
    NO_PROXY: "example.com",
    NODE_OPTIONS: "--max-old-space-size=512",
  });
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:10808");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.equal(env.http_proxy, "http://127.0.0.1:10808");
  assert.equal(env.https_proxy, "http://127.0.0.1:10808");
  assert.ok(env.NO_PROXY.includes("127.0.0.1"));
  assert.ok(env.NO_PROXY.includes("localhost"));
  assert.ok(env.NO_PROXY.includes("example.com"));
  assert.ok(env.NO_PROXY.includes("api.deepseek.com"));
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=512 --use-env-proxy");
  const existingFlag = proxyEnvFor("http://127.0.0.1:10808", {
    no_proxy: "API.DEEPSEEK.COM",
    NODE_OPTIONS: "--use-env-proxy",
  });
  assert.equal(existingFlag.NODE_OPTIONS, "--use-env-proxy");
  assert.equal(existingFlag.NO_PROXY.toLowerCase().split(",").filter((value) => value === "api.deepseek.com").length, 1);
});

test("usesEnvProxy detects the flag without matching lookalikes", () => {
  assert.equal(usesEnvProxy({ NODE_OPTIONS: "--use-env-proxy" }), true);
  assert.equal(usesEnvProxy({ NODE_OPTIONS: "--trace-warnings --use-env-proxy" }), true);
  assert.equal(usesEnvProxy({ NODE_OPTIONS: "--use-env-proxy-extra" }), false);
  assert.equal(usesEnvProxy({ NODE_USE_ENV_PROXY: "1" }), true);
  assert.equal(usesEnvProxy({}), false);
});

test("validates and redacts credentialed proxy URLs", async () => {
  const { redactProxyUrl, validateProxyUrl } = await import("../src/proxy-config.mjs");
  assert.equal(validateProxyUrl(" https://user:pass@example.test:8443 "), "https://user:pass@example.test:8443");
  assert.match(redactProxyUrl("https://user:pass@example.test:8443"), /redacted/);
  assert.doesNotMatch(redactProxyUrl("https://user:pass@example.test:8443"), /pass/);
  assert.doesNotMatch(redactProxyUrl("https://example.test/?token=secret"), /secret/);
  assert.throws(() => validateProxyUrl("file:///tmp/proxy"), /Invalid proxy URL/);
});
