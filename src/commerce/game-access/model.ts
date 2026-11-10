export class GameAccessError extends Error {}
export interface Fulfillment {
  offeringId: string;
  guildId: string;
  targetId: string;
  physicalTarget: string;
  origin: string;
  capability: "reserved-slot";
  allocationCeiling: number;
  acceptingSales: boolean;
  updatedAtMs: number;
}
export interface Selection {
  platform: "steam";
  checkoutId: string;
  offeringId: string;
  guildId: string;
  buyerId: string;
  userId: string;
  subject: string;
  assignmentId: string;
  createdAtMs: number;
}
export type DeliveryState =
  | "pending"
  | "managed"
  | "externally-managed"
  | "withheld"
  | "removal-pending"
  | "removed"
  | "needs-attention";
export interface Assignment {
  platform: "steam";
  id: string;
  guildId: string;
  userId: string;
  targetId: string;
  physicalTarget: string;
  origin: string;
  subject: string;
  ownership: "none" | "external" | "haf" | "uncertain";
  generation: number;
  revision: number;
  desired: boolean;
  state: DeliveryState;
  reason: string;
  entitlementIds: string[];
  attempts: number;
  nextAtMs: number;
  updatedAtMs: number;
  transmitted: {
    // Local marker identity only; this is not upstream idempotency. Optional for older records.
    operationId?: string;
    action: "grant" | "remove";
    acknowledged: boolean;
    atMs: number;
    generation: number;
  } | null;
  observed: boolean | null;
  obligation: boolean;
  slot: number | null;
}
export function steamId(value: string) {
  return /^7656119\d{10}$/.test(value);
}

export interface GameAccessMessage {
  assignments: { assignmentId: string; generation: number; revision: number }[];
}
export interface GameAccessQueue {
  send(message: GameAccessMessage): Promise<unknown>;
}
