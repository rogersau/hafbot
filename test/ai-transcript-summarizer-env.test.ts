/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import type { Env } from "./support/test-env";
import { parseAiTranscriptSummarizerEnv } from "../src/services/tickets/ai-transcript-summarizer-env";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_USER_ID: "bot-user-id",
    DISCORD_PUBLIC_KEY: "9113b842d4ade29e412959490d5a7dff2e74c41b12500c73612285bf4ca0e6b5",
    GATEWAY_SESSION_DO: {} as DurableObjectNamespace,
    GATEWAY_EVENT_QUEUE: {} as Queue<unknown>,
    HAF_DB: {} as D1Database,
    IMAGE_RULES_API_BASE_URL: "https://api.example.com",
    IMAGE_RULES_API_KEY: "shared-secret-key",
    ...overrides,
  };
}

test("parseAiTranscriptSummarizerEnv reuses image rules provider config by default", () => {
  const env = createEnv({
    TRANSCRIPT_AI_MODEL: "gpt-5.4-nano",
    TRANSCRIPT_AI_TIMEOUT_MS: "12000",
  });

  const parsed = parseAiTranscriptSummarizerEnv(env);

  assert.ok(parsed);
  assert.equal(parsed.apiBaseUrl, "https://api.example.com");
  assert.equal(parsed.apiKey, "shared-secret-key");
  assert.equal(parsed.model, "gpt-5.4-nano");
  assert.equal(parsed.timeoutMs, 12_000);
});

test("parseAiTranscriptSummarizerEnv lets transcript provider config override shared defaults", () => {
  const env = createEnv({
    TRANSCRIPT_AI_API_BASE_URL: "https://transcript.example.com",
    TRANSCRIPT_AI_API_KEY: "transcript-secret-key",
  });

  const parsed = parseAiTranscriptSummarizerEnv(env);

  assert.ok(parsed);
  assert.equal(parsed.apiBaseUrl, "https://transcript.example.com");
  assert.equal(parsed.apiKey, "transcript-secret-key");
});

test("parseAiTranscriptSummarizerEnv returns undefined when no provider key is configured", () => {
  const env = createEnv({ IMAGE_RULES_API_KEY: undefined });

  const parsed = parseAiTranscriptSummarizerEnv(env);

  assert.equal(parsed, undefined);
});
