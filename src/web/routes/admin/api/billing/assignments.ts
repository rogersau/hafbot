import { createFileRoute } from "@tanstack/react-router";
import { handleBillingOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/billing/assignments")({
  server: {
    handlers: {
      GET: handleBillingOperation("billingAssignments.get"),
      POST: handleBillingOperation("billingAssignments.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
