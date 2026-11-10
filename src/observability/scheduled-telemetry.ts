export function logScheduledCompletion(
  operation: string,
  context: { environment?: string; workerVersion?: string },
  identityCount?: number,
): void {
  try {
    console.info({
      event: "haf.metric",
      metric: "scheduled_operation",
      operation,
      outcome: "completed",
      environment: context.environment ?? "unknown",
      workerVersion: context.workerVersion ?? "unknown",
      ...(identityCount === undefined ? {} : { identityCount }),
    });
  } catch {
    // Completion evidence must never change the scheduled operation's result.
  }
}
