/** Connection and capacity failures that can recover without changing a request. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  if (
    /^(08|53)/.test(code) ||
    ["57P01", "57P02", "57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code)
  )
    return true;
  if (error.name === "TimeoutError") return true;
  return error.cause !== error && error.cause !== undefined && isDatabaseUnavailable(error.cause);
}
