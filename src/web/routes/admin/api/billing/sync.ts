import { createFileRoute } from "@tanstack/react-router";
import { handleBillingOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/billing/sync")({
  server: {
    handlers: {
      POST: handleBillingOperation("billingSync.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
