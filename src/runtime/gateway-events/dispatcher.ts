export type GatewayHandlerOutcome = "continue" | "stop";

export interface GatewayEventHandler<TEnvelope, TCapabilities> {
  readonly key: string;
  readonly eventTypes: readonly string[];
  readonly order: number;
  readonly scope?: {
    readonly capabilityKeys: readonly string[];
    readonly storeKeys: readonly string[];
  };
  isEnabled?(capabilities: TCapabilities, envelope: TEnvelope): boolean;
  handle(capabilities: TCapabilities, envelope: TEnvelope): Promise<GatewayHandlerOutcome | void>;
}

export interface GatewayHandlerResult {
  handlerKey: string;
  outcome: GatewayHandlerOutcome;
}

export async function dispatchGatewayEventHandlers<
  TEnvelope extends { type: string },
  TCapabilities,
>(
  handlers: readonly GatewayEventHandler<TEnvelope, TCapabilities>[],
  capabilities: TCapabilities,
  envelope: TEnvelope,
  observe?: (result: GatewayHandlerResult) => void,
): Promise<GatewayHandlerResult[]> {
  const results: GatewayHandlerResult[] = [];
  const matching = handlers
    .filter(
      (handler) =>
        handler.eventTypes.includes(envelope.type) &&
        (handler.isEnabled?.(capabilities, envelope) ?? true),
    )
    .sort((left, right) => left.order - right.order);

  for (const handler of matching) {
    const outcome = (await handler.handle(capabilities, envelope)) ?? "continue";
    const result = { handlerKey: handler.key, outcome } satisfies GatewayHandlerResult;
    results.push(result);
    observe?.(result);
    if (outcome === "stop") break;
  }
  return results;
}
