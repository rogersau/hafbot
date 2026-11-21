import type { RouteParams } from "../runtime/admin-route-registry";
import type { WebRequestContext } from "./request-context";

type RequestContext = { request: Request; context: WebRequestContext };
const BILLING_API_PREFIX = "/admin/api/billing";

export function handleAdminOperation(operationId: string) {
  return ({ request, params, context }: RequestContext & { params: RouteParams }) => {
    if (!new URL(request.url).pathname.startsWith("/admin/api/")) {
      return new Response("Not found", { status: 404 });
    }
    return context.haf?.adminApi?.(operationId, request, params) ?? adminApiNotFound(context);
  };
}

export function handleBillingOperation(operationId: string) {
  return ({ request, context }: RequestContext) => {
    if (!new URL(request.url).pathname.startsWith(BILLING_API_PREFIX)) {
      return handleUnknownAdminApiRequest({ request, context });
    }
    return context.haf?.billingApi?.(operationId, request) ?? adminApiNotFound(context);
  };
}

export function handleUnknownAdminApiRequest(input: RequestContext) {
  const pathname = new URL(input.request.url).pathname;
  if (pathname.startsWith(BILLING_API_PREFIX) && input.context.haf?.billingApi) {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (pathname.startsWith("/admin/api/")) return adminApiNotFound(input.context);
  return new Response("Not found", { status: 404 });
}

function adminApiNotFound(context: WebRequestContext): Response {
  return context.haf?.adminApi
    ? Response.json({ error: "Not found" }, { status: 404 })
    : new Response("Not found", { status: 404 });
}
