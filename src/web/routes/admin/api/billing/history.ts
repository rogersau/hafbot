import { createFileRoute } from "@tanstack/react-router";
import { handleBillingOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/billing/history")({
  server: {
    handlers: {
      GET: handleBillingOperation("billingHistory.get"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
