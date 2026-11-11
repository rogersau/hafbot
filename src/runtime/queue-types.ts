export interface QueueSendOptions {
  delaySeconds?: number;
}
export interface QueueRetryOptions {
  delaySeconds?: number;
}

export interface QueueProducer<Body = unknown> {
  send(message: Body, options?: QueueSendOptions): Promise<unknown>;
  sendBatch(
    messages: Iterable<{ body: Body; delaySeconds?: number }>,
    options?: QueueSendOptions,
  ): Promise<unknown>;
}

export interface QueueMessage<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

export interface QueueBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<Body>[];
  ackAll(): void;
  retryAll(options?: QueueRetryOptions): void;
}
