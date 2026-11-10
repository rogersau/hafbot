/**
 * An application-authored diagnostic that may be retained inside an error chain.
 * Use fixed wording and approved identifiers only, never upstream messages,
 * response bodies, credentials, customer details or arbitrary thrown values.
 * The cause is evaluated independently; this does not make its contents safe.
 */
export class SafeDiagnosticError extends Error {}
