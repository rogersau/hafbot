import type {
  GatewayEventCapabilities,
  GatewayEventEnvelope,
  GatewayEventStores,
} from "./contracts";
import type { GatewayEventHandler } from "./dispatcher";

type GatewayTopLevelCapability = Exclude<keyof GatewayEventCapabilities, "stores">;

export type ScopedGatewayEventCapabilities<
  TCapability extends GatewayTopLevelCapability,
  TStore extends keyof GatewayEventStores,
> = Pick<GatewayEventCapabilities, TCapability> & {
  readonly stores: Pick<GatewayEventStores, TStore>;
};

export function defineGatewayEventHandler<
  const TCapability extends GatewayTopLevelCapability,
  const TStore extends keyof GatewayEventStores,
>(
  capabilityKeys: readonly TCapability[],
  storeKeys: readonly TStore[],
  handler: GatewayEventHandler<
    GatewayEventEnvelope,
    ScopedGatewayEventCapabilities<TCapability, TStore>
  >,
): GatewayEventHandler<GatewayEventEnvelope, GatewayEventCapabilities> {
  const select = (capabilities: GatewayEventCapabilities) =>
    selectGatewayEventCapabilities(capabilities, capabilityKeys, storeKeys);
  return {
    ...handler,
    scope: { capabilityKeys, storeKeys },
    isEnabled: handler.isEnabled
      ? (capabilities, envelope) => handler.isEnabled!(select(capabilities), envelope)
      : undefined,
    handle: (capabilities, envelope) => handler.handle(select(capabilities), envelope),
  };
}

function selectGatewayEventCapabilities<
  const TCapability extends GatewayTopLevelCapability,
  const TStore extends keyof GatewayEventStores,
>(
  capabilities: GatewayEventCapabilities,
  capabilityKeys: readonly TCapability[],
  storeKeys: readonly TStore[],
): ScopedGatewayEventCapabilities<TCapability, TStore> {
  const selected = Object.fromEntries(
    capabilityKeys.map((key) => [key, capabilities[key]]),
  ) as Pick<GatewayEventCapabilities, TCapability>;
  const stores = Object.fromEntries(
    storeKeys.map((key) => [key, capabilities.stores[key]]),
  ) as Pick<GatewayEventStores, TStore>;
  return { ...selected, stores };
}
