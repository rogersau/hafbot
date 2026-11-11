import { type Intent, type Operation, type Projection } from "./model";

export interface EnforcementStore {
  prepare(intent: Intent): Promise<Intent>;
  confirmation(id: string, guildId: string, actorId: string): Promise<Intent | null>;
  confirm(operation: Operation): Promise<Operation>;
  read(id: string): Promise<Operation | null>;
  list(guildId: string): Promise<Operation[]>;
  due(now: number): Promise<Operation[]>;
  save(operation: Operation, expected: number): Promise<Operation | null>;
  notifications(now: number): Promise<Operation[]>;
  projection(id: string): Promise<Projection | null>;
  saveProjection(projection: Projection, expectedToken: string): Promise<Projection | null>;
}
