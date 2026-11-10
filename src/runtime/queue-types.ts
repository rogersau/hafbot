/** Queue operations shared by Cloudflare and the portable PostgreSQL runtime. */
export interface QueueProducer<Body = unknown> {
  send(message: Body, options?: QueueSendOptions): Promise<unknown>;
  sendBatch(
    messages: Iterable<MessageSendRequest<Body>>,
    options?: QueueSendBatchOptions,
  ): Promise<unknown>;
}

/** Consumers use message settlement, without requiring provider-specific backlog metrics. */
export type QueueBatch<Body = unknown> = Pick<
  MessageBatch<Body>,
  "queue" | "messages" | "ackAll" | "retryAll"
>;
