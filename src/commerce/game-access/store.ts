import { type Fulfillment, type Selection, type Assignment } from "./model";

export interface GameAccessStore {
  canChangeOrigin(guildId: string, targetId: string): Promise<boolean>;
  config(offeringId: string): Promise<Fulfillment | null>;
  configs(guildId?: string): Promise<Fulfillment[]>;
  configure(config: Fulfillment): Promise<void>;
  select(selection: Selection): Promise<void>;
  selection(checkoutId: string): Promise<Selection | null>;
  selections(id: string): Promise<Selection[]>;
  read(id: string): Promise<Assignment | null>;
  list(guildId?: string): Promise<Assignment[]>;
  due(now: number): Promise<Assignment[]>;
  reserve(candidate: Assignment, available: number): Promise<Assignment>;
  deferPublication(value: Assignment, nextAtMs: number): Promise<Assignment | null>;
  save(value: Assignment, expected: number): Promise<Assignment | null>;
}
