/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  summarizeTicket,
  type SummarizeTicketInput,
  type SummarizerFetch,
} from "../src/services/tickets/ai-transcript-summarizer";

function createValidInput(): SummarizeTicketInput {
  return {
    ticketTypeLabel: "Support",
    ticketTypeId: "support",
    answers: [{ label: "Issue", value: "Cannot log in" }],
    messages: [
      {
        authorId: "user-1",
        authorTag: "Member",
        content: "I cannot log in to the game.",
        createdAtMs: 1_700_000_000_000,
      },
      {
        authorId: "staff-1",
        authorTag: "Staff",
        content: "Try resetting your password. Let us know if it works.",
        createdAtMs: 1_700_000_000_001,
      },
    ],
    closerDisplayName: "Staff",
  };
}

function createFetchReturning(content: string): SummarizerFetch {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function createEnv() {
  return {
    apiBaseUrl: "https://api.example.com",
    apiKey: "key-123",
    model: "gpt-4o-mini",
    timeoutMs: 10_000,
  };
}

async function captureConsoleErrors(run: () => Promise<void>): Promise<string[]> {
  const messages: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.error = originalConsoleError;
  }
  return messages;
}

test("summarizeTicket omits response_format from the AI request body", async () => {
  const capturedBodies: unknown[] = [];
  const fetchImpl: SummarizerFetch = async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    capturedBodies.push(body);
    return createFetchReturning(
      JSON.stringify({
        summary: "Member could not log in.",
        keywords: ["login issue"],
      }),
    )(_input, init);
  };

  await summarizeTicket(createValidInput(), createEnv(), fetchImpl);

  const body = capturedBodies[0] as Record<string, unknown> | undefined;
  assert.equal(body?.response_format, undefined);
  assert.equal(body?.reasoning_effort, "medium");
  assert.equal(typeof body?.model, "string");
  assert.ok(Array.isArray(body?.messages));
});

test("summarizeTicket returns summary and keywords from valid structured response", async () => {
  const fetchImpl = createFetchReturning(
    JSON.stringify({
      summary: "Member could not log in and was advised to reset their password.",
      keywords: ["login issue", "password reset"],
    }),
  );

  const result = await summarizeTicket(createValidInput(), createEnv(), fetchImpl);

  assert.equal(result?.summary, "Member could not log in and was advised to reset their password.");
  assert.deepEqual(result?.keywords, ["login issue", "password reset"]);
});

test("summarizeTicket returns null when AI configuration is missing", async () => {
  const fetchImpl = createFetchReturning(
    JSON.stringify({
      summary: "Should not be used.",
      keywords: ["ignored"],
    }),
  );

  const result = await summarizeTicket(createValidInput(), undefined, fetchImpl);

  assert.equal(result, null);
});

test("summarizeTicket returns null when the AI provider returns an error", async () => {
  const privateProviderBody = "private ticket provider detail";
  const fetchImpl: SummarizerFetch = async () =>
    new Response(privateProviderBody, { status: 500, statusText: "Internal Server Error" });

  let result: Awaited<ReturnType<typeof summarizeTicket>>;
  const errors = await captureConsoleErrors(async () => {
    result = await summarizeTicket(createValidInput(), createEnv(), fetchImpl);
  });

  assert.equal(result!, null);
  assert.match(errors.join("\n"), /500 Internal Server Error/);
  assert.doesNotMatch(errors.join("\n"), new RegExp(privateProviderBody));
});

test("summarizeTicket returns null when the AI request times out", async () => {
  const env = { ...createEnv(), timeoutMs: 10 };
  const fetchImpl: SummarizerFetch = async (_input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (init?.signal?.aborted) {
      throw new Error("Aborted");
    }
    return new Response("{}");
  };

  const result = await summarizeTicket(createValidInput(), env, fetchImpl);

  assert.equal(result, null);
});

test("summarizeTicket returns null when the AI response is not valid JSON", async () => {
  const privateModelOutput = "private ticket model output";
  const fetchImpl = createFetchReturning(privateModelOutput);

  let result: Awaited<ReturnType<typeof summarizeTicket>>;
  const errors = await captureConsoleErrors(async () => {
    result = await summarizeTicket(createValidInput(), createEnv(), fetchImpl);
  });

  assert.equal(result!, null);
  assert.match(errors.join("\n"), /Failed to parse AI response content/);
  assert.doesNotMatch(errors.join("\n"), new RegExp(privateModelOutput));
});

test("summarizeTicket returns summary only when keywords are invalid", async () => {
  const fetchImpl = createFetchReturning(
    JSON.stringify({
      summary: "Member could not log in and was advised to reset their password.",
      keywords: "not an array",
    }),
  );

  const result = await summarizeTicket(createValidInput(), createEnv(), fetchImpl);

  assert.equal(result?.summary, "Member could not log in and was advised to reset their password.");
  assert.deepEqual(result?.keywords, null);
});

test("summarizeTicket returns keywords only when summary is invalid", async () => {
  const fetchImpl = createFetchReturning(
    JSON.stringify({
      summary: "",
      keywords: ["login issue", "password reset"],
    }),
  );

  const result = await summarizeTicket(createValidInput(), createEnv(), fetchImpl);

  assert.equal(result?.summary, null);
  assert.deepEqual(result?.keywords, ["login issue", "password reset"]);
});

test("summarizeTicket returns null when transcript has only opening answers", async () => {
  const fetchImpl = createFetchReturning(
    JSON.stringify({
      summary: "Should not be generated.",
      keywords: ["ignored"],
    }),
  );

  const input: SummarizeTicketInput = {
    ...createValidInput(),
    messages: [],
  };
  const result = await summarizeTicket(input, createEnv(), fetchImpl);

  assert.equal(result, null);
});

test("summarizeTicket is eligible for attachment-only human messages", async () => {
  const capturedBodies: unknown[] = [];
  const fetchImpl: SummarizerFetch = async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    capturedBodies.push(body);
    return createFetchReturning(
      JSON.stringify({
        summary: "Member shared a screenshot.",
        keywords: ["screenshot"],
      }),
    )(_input, init);
  };

  const input: SummarizeTicketInput = {
    ...createValidInput(),
    messages: [
      {
        authorId: "user-1",
        authorTag: "Member",
        content: "",
        createdAtMs: 1_700_000_000_000,
        attachments: [
          {
            id: "att-1",
            filename: "screenshot.png",
            url: "https://example.com/a.png",
            proxyUrl: null,
            contentType: "image/png",
            size: 1024,
            width: null,
            height: null,
          },
        ],
      },
    ],
  };

  const result = await summarizeTicket(input, createEnv(), fetchImpl);

  assert.equal(result?.summary, "Member shared a screenshot.");
  const body = capturedBodies[0] as { messages?: Array<{ content: string }> } | undefined;
  const userContent = body?.messages?.find((message) => message.content.includes("screenshot.png"));
  assert.ok(userContent);
});

test("summarizeTicket shapes large transcripts with start, end, and omission note", async () => {
  const capturedBodies: unknown[] = [];
  const fetchImpl: SummarizerFetch = async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    capturedBodies.push(body);
    return createFetchReturning(
      JSON.stringify({
        summary: "Large ticket discussion.",
        keywords: ["long thread"],
      }),
    )(_input, init);
  };

  const messages = Array.from({ length: 45 }, (_, index) => ({
    authorId: `user-${index % 2 === 0 ? "1" : "2"}`,
    authorTag: `User ${index % 2 === 0 ? "One" : "Two"}`,
    content: `Message ${index}`,
    createdAtMs: 1_700_000_000_000 + index,
  }));

  const input: SummarizeTicketInput = {
    ...createValidInput(),
    messages,
  };

  await summarizeTicket(input, createEnv(), fetchImpl);

  const body = capturedBodies[0] as
    | { messages?: Array<{ role?: string; content: string }> }
    | undefined;
  const userContent = body?.messages?.find((message) => message.role === "user")?.content;
  assert.ok(userContent?.includes("Message 0"));
  assert.ok(userContent?.includes("Message 44"));
  assert.ok(userContent?.includes("middle messages were omitted"));
  assert.ok(!userContent?.includes("Message 22"));
});
