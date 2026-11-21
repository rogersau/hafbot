import { createFileRoute } from "@tanstack/react-router";
import { handleBillingOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/billing/change-price")({
  server: {
    handlers: {
      POST: handleBillingOperation("billingChangePrice.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
