import { createFileRoute } from "@tanstack/react-router";
import { handleBillingOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/billing-support/operation")({
  server: {
    handlers: {
      POST: handleBillingOperation("billingSupportOperation.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
