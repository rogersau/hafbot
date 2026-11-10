export class WaitUntilRecorder {
  #pending: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.#pending.push(promise);
  }
  get pendingCount(): number {
    return this.#pending.length;
  }
  async flush(): Promise<void> {
    const pending = this.#pending.splice(0);
    await Promise.all(pending);
  }
  async rejects(): Promise<unknown[]> {
    const pending = this.#pending.splice(0);
    return (await Promise.allSettled(pending))
      .filter((item): item is PromiseRejectedResult => item.status === "rejected")
      .map((item) => item.reason);
  }
}
