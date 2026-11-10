import type { Target } from "./model";

export interface WardogsStore {
  list(guildId: string): Promise<Target[]>;
  read(guildId: string, targetId: string): Promise<Target | null>;
  create(target: Target): Promise<boolean>;
  save(target: Target, expectedGeneration: number): Promise<boolean>;
  claim(
    origin: string,
    token: string,
    nowMs: number,
    leaseMs: number,
    spacingMs: number,
  ): Promise<boolean>;
  release(origin: string, token: string, cooldownUntilMs: number): Promise<void>;
}
