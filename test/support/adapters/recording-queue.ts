export class RecordingQueue<T> {
  readonly messages: T[] = [];
  #nextFailure: unknown;
  failNext(reason: unknown): void {
    this.#nextFailure = reason;
  }
  async send(message: T): Promise<void> {
    if (this.#nextFailure !== undefined) {
      const reason = this.#nextFailure;
      this.#nextFailure = undefined;
      throw reason;
    }
    this.messages.push(structuredClone(message));
  }
  async sendBatch(messages: readonly { body: T }[]): Promise<void> {
    for (const { body } of messages) await this.send(body);
  }
  drain(): T[] {
    return this.messages.splice(0);
  }
}
