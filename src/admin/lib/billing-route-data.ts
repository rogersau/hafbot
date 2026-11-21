import { billingClient } from "../generated/admin-client/billing";

type BillingRead<T> = { ok: true; data: T } | { ok: false; error: unknown };

async function read<T>(request: Promise<T>): Promise<BillingRead<T>> {
  try {
    return { ok: true, data: await request };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function loadBillingRouteData(signal: AbortSignal) {
  const summary = await read(billingClient.get({}, signal));
  if (!summary.ok) return summary;

  const assignments =
    summary.data.subscription && summary.data.subscription.plan !== "free"
      ? read(billingClient.assignments({}, signal))
      : null;

  return {
    ok: true as const,
    data: summary.data,
    assignments,
    history: read(billingClient.history({}, signal)),
  };
}

export type BillingRouteData = Awaited<ReturnType<typeof loadBillingRouteData>>;
export type BillingSectionRead<T> = Promise<BillingRead<T>>;
