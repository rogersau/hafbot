/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { classifyImage, type ClassifierFetch } from "../src/services/image-rules/classifier";
import type { ImageRulesClassifierEnv } from "../src/services/image-rules/env";

function createEnv(overrides: Partial<ImageRulesClassifierEnv> = {}): ImageRulesClassifierEnv {
  return {
    apiBaseUrl: "https://api.example.com",
    apiKey: "secret-key",
    model: "gpt-4o",
    maxImageBytes: 20_971_520,
    maxImageDimension: 4096,
    timeoutMs: 5000,
    maxRetries: 1,
    ...overrides,
  };
}

function createJsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function createChatCompletionResponse(content: string): Response {
  return createJsonResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  });
}

function createClassifierContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    image_description: "A Windows desktop screenshot with icons and a taskbar.",
    classification_reason: "The image is a screen capture and plausibly matches the topic.",
    off_topic_confidence: 0.2,
    on_topic_confidence: 0.8,
    ...overrides,
  });
}

test("classifyImage returns parsed confidences from a successful response", async () => {
  const env = createEnv();
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: ClassifierFetch = async (input, init) => {
    fetchCalls.push({ url: String(input), init });
    return createChatCompletionResponse(createClassifierContent());
  };

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, {
    image_description: "A Windows desktop screenshot with icons and a taskbar.",
    classification_reason: "The image is a screen capture and plausibly matches the topic.",
    off_topic_confidence: 0.2,
    on_topic_confidence: 0.8,
  });
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0]?.url ?? "", /\/chat\/completions$/);
  assert.equal(fetchCalls[0]?.init?.method, "POST");
  const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers?.Authorization, "Bearer secret-key");
  assert.equal(headers?.["Content-Type"], "application/json");
  const body = JSON.parse((fetchCalls[0]?.init?.body as string) ?? "{}");
  assert.equal(body.model, "gpt-4o");
  assert.equal(body.reasoning_effort, "medium");
  assert.equal(body.messages[0]?.role, "user");
  assert.ok(
    body.messages[0]?.content?.some(
      (item: unknown) => (item as { type: string }).type === "image_url",
    ),
  );
});

test("classifyImage strips markdown fences from response content", async () => {
  const env = createEnv();
  const fetchImpl: ClassifierFetch = async () =>
    createChatCompletionResponse(
      `\`\`\`json\n${createClassifierContent({ off_topic_confidence: 0.1, on_topic_confidence: 0.9 })}\n\`\`\``,
    );

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, {
    image_description: "A Windows desktop screenshot with icons and a taskbar.",
    classification_reason: "The image is a screen capture and plausibly matches the topic.",
    off_topic_confidence: 0.1,
    on_topic_confidence: 0.9,
  });
});

test("classifyImage includes the topic description in the prompt", async () => {
  const env = createEnv();
  const fetchCalls: Array<{ body: string }> = [];
  const fetchImpl: ClassifierFetch = async (_input, init) => {
    fetchCalls.push({ body: (init?.body as string) ?? "" });
    return createChatCompletionResponse(
      createClassifierContent({ off_topic_confidence: 0.5, on_topic_confidence: 0.5 }),
    );
  };

  await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ base building", env },
    fetchImpl,
  );

  assert.match(fetchCalls[0]?.body ?? "", /DayZ base building/);
  assert.match(fetchCalls[0]?.body ?? "", /give it the benefit of the doubt/);
  assert.match(fetchCalls[0]?.body ?? "", /desktop UI, taskbars, icons/);
});

test("classifyImage retries on 5xx and returns success when the retry succeeds", async () => {
  const env = createEnv();
  let calls = 0;
  const fetchImpl: ClassifierFetch = async () => {
    calls++;
    if (calls === 1) {
      return createJsonResponse({ error: "Internal Server Error" }, 500);
    }
    return createChatCompletionResponse(
      createClassifierContent({ off_topic_confidence: 0.3, on_topic_confidence: 0.7 }),
    );
  };

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, {
    image_description: "A Windows desktop screenshot with icons and a taskbar.",
    classification_reason: "The image is a screen capture and plausibly matches the topic.",
    off_topic_confidence: 0.3,
    on_topic_confidence: 0.7,
  });
  assert.equal(calls, 2);
});

test("classifyImage returns 5xx after exhausting retries", async () => {
  const env = createEnv({ maxRetries: 1 });
  let calls = 0;
  const fetchImpl: ClassifierFetch = async () => {
    calls++;
    return createJsonResponse({ error: "Internal Server Error" }, 500);
  };

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, { error: "5xx" });
  assert.equal(calls, 2);
});

test("classifyImage returns rate_limited on 429 without retry", async () => {
  const env = createEnv({ maxRetries: 1 });
  let calls = 0;
  const fetchImpl: ClassifierFetch = async () => {
    calls++;
    return createJsonResponse({ error: "Too Many Requests" }, 429);
  };

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, { error: "rate_limited" });
  assert.equal(calls, 1);
});

test("classifyImage returns parse_error on 4xx without retry", async () => {
  const env = createEnv({ maxRetries: 1 });
  let calls = 0;
  const fetchImpl: ClassifierFetch = async () => {
    calls++;
    return createJsonResponse({ error: "Bad Request" }, 400);
  };

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, { error: "parse_error" });
  assert.equal(calls, 1);
});

test("classifyImage retries on timeout and returns timeout after exhausting retries", async () => {
  const env = createEnv({ timeoutMs: 1, maxRetries: 1 });
  let calls = 0;
  const fetchImpl: ClassifierFetch = async (_input, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort);
    });
  };

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, { error: "timeout" });
  assert.equal(calls, 2);
});

test("classifyImage returns parse_error when response content is invalid JSON", async () => {
  const env = createEnv();
  const fetchImpl: ClassifierFetch = async () => createChatCompletionResponse("not valid json");

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, { error: "parse_error" });
});

test("classifyImage returns parse_error when confidences do not sum to 1", async () => {
  const env = createEnv();
  const fetchImpl: ClassifierFetch = async () =>
    createChatCompletionResponse(
      createClassifierContent({ off_topic_confidence: 0.2, on_topic_confidence: 0.7 }),
    );

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, { error: "parse_error" });
});

test("classifyImage returns parse_error when confidence fields are missing", async () => {
  const env = createEnv();
  const fetchImpl: ClassifierFetch = async () => createChatCompletionResponse('{"other": 0.5}');

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, { error: "parse_error" });
});

test("classifyImage normalizes trailing slash on base URL", async () => {
  const env = createEnv({ apiBaseUrl: "https://api.example.com/" });
  const fetchCalls: Array<string> = [];
  const fetchImpl: ClassifierFetch = async (input) => {
    fetchCalls.push(String(input));
    return createChatCompletionResponse(
      createClassifierContent({ off_topic_confidence: 0, on_topic_confidence: 1 }),
    );
  };

  await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.equal(fetchCalls[0], "https://api.example.com/chat/completions");
});

test("classifyImage does not retry on parse_error", async () => {
  const env = createEnv({ maxRetries: 1 });
  let calls = 0;
  const fetchImpl: ClassifierFetch = async () => {
    calls++;
    return createChatCompletionResponse("invalid");
  };

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, { error: "parse_error" });
  assert.equal(calls, 1);
});

test("classifyImage returns parse_error when choices array is empty", async () => {
  const env = createEnv();
  const fetchImpl: ClassifierFetch = async () => createJsonResponse({ choices: [] });

  const result = await classifyImage(
    { imageUrl: "https://example.com/image.png", topicDescription: "DayZ screenshots", env },
    fetchImpl,
  );

  assert.deepEqual(result, { error: "parse_error" });
});
