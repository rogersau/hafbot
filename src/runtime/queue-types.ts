export interface QueueSendOptions {
  delaySeconds?: number;
}

export interface QueueProducer<Body = unknown> {
  send(message: Body, options?: QueueSendOptions): Promise<unknown>;
  sendBatch(
    messages: Iterable<{ body: Body; delaySeconds?: number }>,
    options?: QueueSendOptions,
  ): Promise<unknown>;
}

/**
 * Native delivery metadata supplied by the PostgreSQL job worker for one claimed job.
 * Consumers use this directly instead of a broker-shaped message envelope.
 */
export interface QueueJobMetadata {
  readonly jobId: string;
  readonly queueName: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
}
