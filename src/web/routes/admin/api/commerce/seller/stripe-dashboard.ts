import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/seller/stripe-dashboard")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceSellerStripeDashboard.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
