import { createTestRuntimeApp, type TestRuntimeAppOptions } from "./create-runtime-app";
import { RecordingDiscordApi } from "./adapters/recording-discord";
import { RecordingFetch } from "./adapters/recording-fetch";
import { RecordingQueue } from "./adapters/recording-queue";
import { MemoryKv } from "./adapters/memory-kv";
import { MemoryR2 } from "./adapters/memory-r2";
import { WaitUntilRecorder } from "./wait-until-recorder";

/** Per-test runtime composition root with observable, deterministic adapters. */
export class RuntimeTestBuilder {
  readonly fetch = new RecordingFetch();
  readonly discord = new RecordingDiscordApi();
  readonly kv = new MemoryKv();
  readonly r2 = new MemoryR2();
  readonly waitUntil = new WaitUntilRecorder();
  readonly queues = new Map<string, RecordingQueue<unknown>>();
  #options: TestRuntimeAppOptions;

  constructor(options: TestRuntimeAppOptions) {
    this.#options = {
      ...options,
      waitUntil: (promise: Promise<unknown>) => this.waitUntil.waitUntil(promise),
    };
  }

  with(options: Partial<TestRuntimeAppOptions>): this {
    this.#options = { ...this.#options, ...options };
    return this;
  }

  queue<T>(name: string): RecordingQueue<T> {
    const existing = this.queues.get(name);
    if (existing) return existing as RecordingQueue<T>;
    const queue = new RecordingQueue<T>();
    this.queues.set(name, queue as RecordingQueue<unknown>);
    return queue;
  }

  build(): ReturnType<typeof createTestRuntimeApp> {
    return createTestRuntimeApp(this.#options);
  }
}
