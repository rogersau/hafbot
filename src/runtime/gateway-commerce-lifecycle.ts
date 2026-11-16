export interface GatewayCommerceLifecycle {
  guildRemoved(guildId: string, eventKey: string): Promise<void>;
  memberChanged(
    guildId: string,
    userId: string,
    state: "left" | "rejoined" | "banned",
    eventKey: string,
  ): Promise<void>;
}

interface CommerceLifecycleStore {
  enqueueGuildDeletion(guildId: string, eventKey: string, nowMs: number): Promise<unknown>;
  enqueueMemberLifecycle(
    guildId: string,
    userId: string,
    state: "left" | "rejoined" | "banned",
    eventKey: string,
    nowMs: number,
  ): Promise<unknown>;
}

export function createGatewayCommerceLifecycle(
  store: CommerceLifecycleStore,
  processProviderActions?: () => Promise<unknown>,
  now: () => number = Date.now,
): GatewayCommerceLifecycle {
  return {
    async guildRemoved(guildId, eventKey) {
      await store.enqueueGuildDeletion(guildId, eventKey, now());
      await processProviderActions?.();
    },
    async memberChanged(guildId, userId, state, eventKey) {
      await store.enqueueMemberLifecycle(guildId, userId, state, eventKey, now());
    },
  };
}
