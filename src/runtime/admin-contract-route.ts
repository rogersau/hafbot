import { adminErrorEnvelopeSchema } from "../contracts/admin/errors";
import type { AdminOperationContract } from "../contracts/admin/core";

type BoundAdminContract<C extends AdminOperationContract> = {
  readonly operationId: C["operationId"];
  readonly method: C["method"];
  readonly path: C["path"];
  readonly query: C["query"];
  readonly body: C["body"];
  readonly success: C["success"]["schema"];
  readonly errors: typeof adminErrorEnvelopeSchema;
};

export function bindAdminContract<C extends AdminOperationContract>(
  contract: C,
): BoundAdminContract<C> {
  return {
    operationId: contract.operationId,
    method: contract.method,
    path: contract.path,
    query: contract.query,
    body: contract.body,
    success: contract.success.schema,
    errors: adminErrorEnvelopeSchema,
  } as const;
}
