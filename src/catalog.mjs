import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  DEEPSEEK_AUTO_COMPACT_TOKEN_LIMIT,
  DEEPSEEK_CONTEXT_WINDOW,
  DEEPSEEK_PICKER_SLUG,
} from "./constants.mjs";

const HIGH = {
  effort: "high",
  description: "Extra high reasoning depth for complex problems",
};
const LOW = {
  effort: "low",
  description: "Fast responses with lighter reasoning",
};
const MAX = {
  effort: "max",
  description: "Maximum reasoning depth for the hardest problems",
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Codex version bumps can turn previously optional catalog fields into
// required ones faster than the app rewrites models_cache.json, and a single
// unparseable entry breaks the whole model_catalog_json (app-server fails to
// start). Backfill known-required fields on native entries with safe
// defaults; the DeepSeek entry sets its own values explicitly.
const NATIVE_ENTRY_DEFAULTS = {
  supports_reasoning_summaries: false,
};

function backfillNativeEntry(model) {
  const entry = clone(model);
  for (const [key, value] of Object.entries(NATIVE_ENTRY_DEFAULTS)) {
    if (entry[key] === undefined) entry[key] = value;
  }
  return entry;
}

function replaceIdentity(value) {
  if (typeof value !== "string") return value;
  return value
    .replaceAll("You are Codex, an agent based on GPT-5.", "You are Codex, powered by DeepSeek V4.1 Flash.")
    .replaceAll("You are Codex, based on GPT-5.", "You are Codex, powered by DeepSeek V4.1 Flash.");
}

export function buildDeepSeekCatalogEntry(template) {
  const entry = clone(template);
  entry.slug = DEEPSEEK_PICKER_SLUG;
  entry.display_name = "DeepSeek V4.1 Flash";
  entry.description = "DeepSeek V4.1 Flash via the native Responses API.";
  entry.default_reasoning_level = "high";
  entry.supported_reasoning_levels = [LOW, HIGH, MAX];
  entry.priority = 0;
  entry.visibility = "list";
  entry.supported_in_api = true;
  entry.prefer_websockets = false;
  entry.support_verbosity = true;
  entry.default_verbosity = "low";
  entry.apply_patch_tool_type = "freeform";
  entry.web_search_tool_type = "text";
  // V4.1 accepts images natively, so declaring the modality is enough: images
  // ride along to api.deepseek.com unchanged and no second provider is involved.
  entry.input_modalities = ["text", "image"];
  entry.supports_image_detail_original = false;
  entry.supports_parallel_tool_calls = true;
  entry.supports_search_tool = true;
  entry.tool_mode = null;
  entry.multi_agent_version = "v2";
  entry.use_responses_lite = false;
  entry.include_skills_usage_instructions = false;
  entry.context_window = DEEPSEEK_CONTEXT_WINDOW;
  entry.max_context_window = DEEPSEEK_CONTEXT_WINDOW;
  entry.effective_context_window_percent = 95;
  // DeepSeek documents a 1M context window and shows an 840K prompt setting
  // for an agent integration with 128K output. Compact at 700K so a large final
  // tool result and the handoff summary still have comfortable headroom.
  entry.auto_compact_token_limit = DEEPSEEK_AUTO_COMPACT_TOKEN_LIMIT;
  entry.default_reasoning_summary = "none";
  entry.supports_reasoning_summaries = false;
  entry.minimal_client_version = "0.144.0";
  entry.availability_nux = null;
  entry.upgrade = null;
  entry.experimental_supported_tools = [];
  entry.base_instructions = replaceIdentity(entry.base_instructions);
  if (entry.model_messages?.instructions_template) {
    entry.model_messages.instructions_template = replaceIdentity(entry.model_messages.instructions_template);
  }

  delete entry.additional_speed_tiers;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  return entry;
}

export function buildCatalog(cache) {
  if (!Array.isArray(cache?.models) || cache.models.length === 0) {
    throw new Error("Codex models_cache.json has no model templates; open Codex once, then retry");
  }
  const nativeModels = cache.models.filter((model) => model?.slug !== DEEPSEEK_PICKER_SLUG);
  const template = ["gpt-6-astra", "gpt-5.6-sol"]
    .map((slug) => nativeModels.find((model) => model?.slug === slug))
    .find(Boolean) ?? nativeModels[0];
  return {
    models: [buildDeepSeekCatalogEntry(template), ...nativeModels.map(backfillNativeEntry)],
  };
}

export function writeCatalog({ catalogPath, catalog }) {
  const temporary = `${catalogPath}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, catalogPath);
  return catalog;
}

export function syncCatalog({ cachePath, catalogPath }) {
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  return writeCatalog({ catalogPath, catalog: buildCatalog(cache) });
}
