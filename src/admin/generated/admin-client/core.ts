import { z } from "zod";
import { adminErrorEnvelopeSchema } from "../../../contracts/admin/errors";
import type { AdminOperationContract } from "../../../contracts/admin/core";
import { AdminApiError } from "../../lib/api";

type AdminContractInput<C extends AdminOperationContract> = {
  query?: z.input<NonNullable<C["query"]>>;
  body?: z.input<NonNullable<C["body"]>>;
  signal?: AbortSignal;
};

export class AdminContractViolationError extends Error {
  constructor(
    readonly operationId: string,
    readonly status: number,
    message: string,
    readonly correlationId?: string,
  ) {
    super(`Invalid response for ${operationId}: ${message}`);
    this.name = "AdminContractViolationError";
  }
}

export type AdminContractTelemetryEvent = {
  operationId: string;
  status: number;
  code?: string;
  correlationId?: string;
};

export function emitAdminContractTelemetry(event: AdminContractTelemetryEvent): void {
  if (typeof globalThis.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  globalThis.dispatchEvent(new CustomEvent("admin_contract_undeclared_error", { detail: event }));
}

export async function callAdminContract<C extends AdminOperationContract>(
  contract: C,
  input: AdminContractInput<C> = {},
): Promise<z.output<C["success"]["schema"]>> {
  const query = contract.query?.parse(input.query);
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
  }
  const response = await fetch(params.size ? `${contract.path}?${params}` : contract.path, {
    method: contract.method,
    headers: input.body ? { "content-type": "application/json" } : undefined,
    body: input.body ? JSON.stringify(contract.body?.parse(input.body)) : undefined,
    signal: input.signal,
  });
  if (!response.ok) throw await parseContractError(contract, response);
  if (response.status !== contract.success.status) {
    throw new AdminContractViolationError(
      contract.operationId,
      response.status,
      `expected status ${contract.success.status}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AdminContractViolationError(
      contract.operationId,
      response.status,
      "expected an application/json success body",
    );
  }
  const result = contract.success.schema.safeParse(await readJson(contract, response));
  if (!result.success) {
    throw new AdminContractViolationError(
      contract.operationId,
      response.status,
      result.error.message,
    );
  }
  return result.data as z.output<C["success"]["schema"]>;
}

async function parseContractError(
  contract: AdminOperationContract,
  response: Response,
): Promise<AdminApiError | AdminContractViolationError> {
  const result = adminErrorEnvelopeSchema.safeParse(await readJson(contract, response));
  if (!result.success) {
    return new AdminContractViolationError(
      contract.operationId,
      response.status,
      `malformed Admin error envelope: ${result.error.message}`,
    );
  }
  const body = result.data;
  const declared = contract.errors.find((spec) => spec.status === response.status);
  const statusDeclared = declared !== undefined;
  const codeDeclared = declared?.codes.includes(body.code) ?? false;
  const universallyAllowedInternalError = response.status === 500 && body.code === "internal_error";
  if (!statusDeclared || (!codeDeclared && !universallyAllowedInternalError)) {
    emitAdminContractTelemetry({
      operationId: contract.operationId,
      status: response.status,
      code: body.code,
      correlationId: body.correlationId,
    });
    return new AdminContractViolationError(
      contract.operationId,
      response.status,
      !statusDeclared
        ? `undeclared error status ${response.status}`
        : `undeclared error code ${body.code}`,
      body.correlationId,
    );
  }
  const correlationHeader = response.headers.get("x-correlation-id");
  if (correlationHeader && correlationHeader !== body.correlationId) {
    return new AdminContractViolationError(
      contract.operationId,
      response.status,
      "error correlation ID does not match the response header",
      body.correlationId,
    );
  }
  return new AdminApiError(
    body.error,
    response.status,
    body.code,
    body.correlationId,
    body.retryable,
    body.retryAfterSeconds,
    body.fieldIssues,
    body.action,
    body.staleReason,
  );
}

async function readJson(contract: AdminOperationContract, response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AdminContractViolationError(
      contract.operationId,
      response.status,
      "response body is not valid JSON",
    );
  }
}
