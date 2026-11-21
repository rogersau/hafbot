import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/financial/cancel")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceFinancialCancel.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
