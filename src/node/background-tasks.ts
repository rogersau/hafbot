export interface BackgroundTaskTrackerOptions {
  maxPending?: number;
  onError?: (error: unknown) => void;
}

export interface BackgroundDrainResult {
  completed: boolean;
  pending: number;
}

/**
 * Node equivalent of ExecutionContext.waitUntil with an explicit capacity and
 * bounded shutdown drain. Rejections are observed so they cannot become
 * process-level unhandled rejections.
 */
export class BackgroundTaskTracker {
  readonly #pending = new Set<Promise<void>>();
  readonly #maxPending: number;
  readonly #onError: (error: unknown) => void;
  #accepting = true;

  constructor(options: BackgroundTaskTrackerOptions = {}) {
    this.#maxPending = options.maxPending ?? 100;
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1) {
      throw new Error("Background task capacity must be a positive integer.");
    }
    this.#onError = options.onError ?? (() => undefined);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  waitUntil = (task: Promise<unknown>): void => {
    // The caller has already started this task, even when capacity or shutdown
    // prevents us from tracking it. Always observe its rejection.
    const observed = Promise.resolve(task)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#onError(error);
      });
    if (!this.#accepting) throw new Error("Background task tracker is draining.");
    if (this.#pending.size >= this.#maxPending) {
      throw new Error(`Background task capacity of ${this.#maxPending} was reached.`);
    }

    let tracked: Promise<void>;
    tracked = observed.finally(() => {
      this.#pending.delete(tracked);
    });
    this.#pending.add(tracked);
  };

  stopAccepting(): void {
    this.#accepting = false;
  }

  async drain(timeoutMs: number): Promise<BackgroundDrainResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("Background task drain timeout must be non-negative.");
    }
    this.stopAccepting();
    if (this.#pending.size === 0) return { completed: true, pending: 0 };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const drained = Promise.allSettled(this.#pending).then(() => true);
    const expired = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref?.();
    });
    const completed = await Promise.race([drained, expired]);
    if (timeout) clearTimeout(timeout);
    return { completed, pending: this.#pending.size };
  }
}
