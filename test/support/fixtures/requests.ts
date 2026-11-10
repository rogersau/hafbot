export function adminRequest(
  options: { path?: string; method?: string; body?: unknown; headers?: HeadersInit } = {},
): Request {
  const headers = new Headers(options.headers);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  return new Request(new URL(options.path ?? "/admin/api/health", "https://hafbot.test"), {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
}

export function publicWebhookRequest(
  options: { publicId?: string; body?: string; headers?: HeadersInit } = {},
): Request {
  return new Request(`https://hafbot.test/webhooks/${options.publicId ?? "webhook-1"}`, {
    method: "POST",
    headers: options.headers,
    body: options.body ?? "{}",
  });
}

export function memberVerificationRequest(
  options: {
    attemptId?: string;
    method?: "GET" | "POST";
    token?: string;
    body?: URLSearchParams;
  } = {},
): Request {
  const url = new URL(`/verify/${options.attemptId ?? "attempt-1"}`, "https://hafbot.test");
  if (options.token) url.searchParams.set("token", options.token);
  return new Request(url, { method: options.method ?? "GET", body: options.body });
}

export function discordInteractionRequest(
  options: { body?: unknown; headers?: HeadersInit } = {},
): Request {
  return new Request("https://hafbot.test/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(options.body ?? {}),
  });
}

export function queueBatch<T>(messages: readonly T[]) {
  return {
    queue: "test-queue",
    messages: messages.map((body, index) => ({
      id: `queue-${index + 1}`,
      body,
      attempts: 1,
      ack() {},
      retry() {},
    })),
  };
}

export function scheduledEvent(cron = "*/5 * * * *") {
  return { cron, scheduledTime: Date.now(), type: "scheduled" as const };
}
