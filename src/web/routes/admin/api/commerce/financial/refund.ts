import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/financial/refund")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceFinancialRefund.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
