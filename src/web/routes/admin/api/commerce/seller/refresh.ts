import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/seller/refresh")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceSellerRefresh.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
