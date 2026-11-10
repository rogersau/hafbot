export class TestClock {
  #now: number;
  constructor(now = Date.UTC(2026, 0, 1)) {
    this.#now = now;
  }
  now(): number {
    return this.#now;
  }
  date(): Date {
    return new Date(this.#now);
  }
  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new RangeError("Clock advances must be finite and non-negative.");
    this.#now += milliseconds;
  }
}
