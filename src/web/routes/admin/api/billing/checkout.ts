import { createFileRoute } from "@tanstack/react-router";
import { handleBillingOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/billing/checkout")({
  server: {
    handlers: {
      POST: handleBillingOperation("billingCheckout.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
