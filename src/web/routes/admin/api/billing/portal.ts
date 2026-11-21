import { createFileRoute } from "@tanstack/react-router";
import { handleBillingOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/billing/portal")({
  server: {
    handlers: {
      POST: handleBillingOperation("billingPortal.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
