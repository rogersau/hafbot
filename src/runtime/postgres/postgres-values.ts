export function readPostgresSafeInteger(value: unknown, column: string): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL column ${column} is not a safe integer.`);
  }
  return parsed;
}

export function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as { code?: unknown }).code === "23505"
  );
}
