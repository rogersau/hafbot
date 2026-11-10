export class RecordingDiscordApi {
  readonly calls: Array<{ operation: string; input: unknown }> = [];
  #results = new Map<string, unknown[]>();

  respond(operation: string, result: unknown): void {
    const values = this.#results.get(operation) ?? [];
    values.push(result);
    this.#results.set(operation, values);
  }

  async call<T>(operation: string, input: unknown): Promise<T> {
    this.calls.push({ operation, input: structuredClone(input) });
    const result = this.#results.get(operation)?.shift();
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error(`Unexpected Discord operation: ${operation}`);
    return result as T;
  }
}
