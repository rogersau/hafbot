export interface AdminRequestContext {
  correlationId: string;
  operationId: string;
  method: string;
  routePath: string;
  startedAtMs: number;
  cfRay?: string;
  sentryTrace?: string;
  parentCorrelationId?: string;
  guildId?: string;
  workspaceId?: string;
  environment?: string;
}

const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createAdminRequestContext(
  request: Request,
  route: { operationId: string; path: string },
  environment?: string,
): AdminRequestContext {
  const parent = request.headers.get("x-correlation-id") ?? undefined;
  return {
    correlationId: crypto.randomUUID(),
    operationId: route.operationId,
    method: request.method,
    routePath: route.path,
    startedAtMs: Date.now(),
    cfRay: request.headers.get("cf-ray") ?? undefined,
    sentryTrace: request.headers.get("sentry-trace") ?? undefined,
    parentCorrelationId: parent && CORRELATION_PATTERN.test(parent) ? parent : undefined,
    environment,
  };
}
