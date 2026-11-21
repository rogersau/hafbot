import { createFileRoute } from "@tanstack/react-router";
import { handleBillingOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/billing/cancellation")({
  server: {
    handlers: {
      POST: handleBillingOperation("billingCancellation.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
