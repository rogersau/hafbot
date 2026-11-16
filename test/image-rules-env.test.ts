/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { parseImageRulesEnv } from "../src/services/image-rules/env";
import type { Env } from "./support/test-env";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_USER_ID: "bot-user-id",
    DISCORD_PUBLIC_KEY: "9113b842d4ade29e412959490d5a7dff2e74c41b12500c73612285bf4ca0e6b5",
    GATEWAY_SESSION_DO: {} as DurableObjectNamespace,
    GATEWAY_EVENT_QUEUE: {} as Queue<unknown>,
    HAF_DB: {} as D1Database,
    IMAGE_RULES_API_BASE_URL: "https://api.example.com",
    IMAGE_RULES_API_KEY: "secret-key",
    ...overrides,
  };
}

test("parseImageRulesEnv returns undefined when base URL is missing", () => {
  const env = createEnv({ IMAGE_RULES_API_BASE_URL: undefined });
  assert.equal(parseImageRulesEnv(env), undefined);
});

test("parseImageRulesEnv returns undefined when API key is missing", () => {
  const env = createEnv({ IMAGE_RULES_API_KEY: undefined });
  assert.equal(parseImageRulesEnv(env), undefined);
});

test("parseImageRulesEnv returns undefined when base URL is empty", () => {
  const env = createEnv({ IMAGE_RULES_API_BASE_URL: "   " });
  assert.equal(parseImageRulesEnv(env), undefined);
});

test("parseImageRulesEnv returns undefined when API key is empty", () => {
  const env = createEnv({ IMAGE_RULES_API_KEY: "   " });
  assert.equal(parseImageRulesEnv(env), undefined);
});

test("parseImageRulesEnv applies PRD defaults for optional fields", () => {
  const env = createEnv();
  const parsed = parseImageRulesEnv(env);

  assert.ok(parsed);
  assert.equal(parsed.apiBaseUrl, "https://api.example.com");
  assert.equal(parsed.apiKey, "secret-key");
  assert.equal(parsed.model, "gpt-4o");
  assert.equal(parsed.maxImageBytes, 20_971_520);
  assert.equal(parsed.maxImageDimension, 4096);
  assert.equal(parsed.timeoutMs, 5000);
  assert.equal(parsed.maxRetries, 1);
});

test("parseImageRulesEnv reads explicit values", () => {
  const env = createEnv({
    IMAGE_RULES_MODEL: "claude-3-opus",
    IMAGE_RULES_MAX_IMAGE_BYTES: "1048576",
    IMAGE_RULES_MAX_IMAGE_DIMENSION: "2048",
    IMAGE_RULES_TIMEOUT_MS: "10000",
    IMAGE_RULES_MAX_RETRIES: "3",
  });
  const parsed = parseImageRulesEnv(env);

  assert.ok(parsed);
  assert.equal(parsed.model, "claude-3-opus");
  assert.equal(parsed.maxImageBytes, 1_048_576);
  assert.equal(parsed.maxImageDimension, 2048);
  assert.equal(parsed.timeoutMs, 10_000);
  assert.equal(parsed.maxRetries, 3);
});

test("parseImageRulesEnv ignores invalid numeric values and uses defaults", () => {
  const env = createEnv({
    IMAGE_RULES_MAX_IMAGE_BYTES: "not-a-number",
    IMAGE_RULES_MAX_IMAGE_DIMENSION: "-1",
    IMAGE_RULES_TIMEOUT_MS: "0",
    IMAGE_RULES_MAX_RETRIES: "1.5",
  });
  const parsed = parseImageRulesEnv(env);

  assert.ok(parsed);
  assert.equal(parsed.maxImageBytes, 20_971_520);
  assert.equal(parsed.maxImageDimension, 4096);
  assert.equal(parsed.timeoutMs, 5000);
  assert.equal(parsed.maxRetries, 1);
});

test("parseImageRulesEnv trims whitespace from string values", () => {
  const env = createEnv({
    IMAGE_RULES_API_BASE_URL: "  https://api.example.com  ",
    IMAGE_RULES_API_KEY: "  secret-key  ",
    IMAGE_RULES_MODEL: "  gpt-4o-mini  ",
  });
  const parsed = parseImageRulesEnv(env);

  assert.ok(parsed);
  assert.equal(parsed.apiBaseUrl, "https://api.example.com");
  assert.equal(parsed.apiKey, "secret-key");
  assert.equal(parsed.model, "gpt-4o-mini");
});
