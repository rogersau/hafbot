export class IdSequence {
  #next = 1;
  constructor(private readonly prefix = "test") {}
  next(label = "id"): string {
    return `${this.prefix}-${label}-${this.#next++}`;
  }
}
