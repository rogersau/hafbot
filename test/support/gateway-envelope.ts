import { deriveGatewayEventKey } from "../../src/runtime/gateway-event-idempotency";

/** Build a current envelope explicitly when a test describes a Discord dispatch. */
export function gatewayEnvelope<T extends { type: string; data: unknown }>(value: T) {
  const envelope = { ...value, version: 2 as const };
  return { ...envelope, eventKey: deriveGatewayEventKey(envelope) };
}
