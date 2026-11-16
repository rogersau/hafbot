import type { QueueJobMetadata } from "../../src/runtime/queue-types";

export function queueJobMetadata(overrides: Partial<QueueJobMetadata> = {}): QueueJobMetadata {
  return {
    jobId: "job-1",
    queueName: "test-queue",
    attempts: 1,
    maxAttempts: 4,
    signal: new AbortController().signal,
    ...overrides,
  };
}
