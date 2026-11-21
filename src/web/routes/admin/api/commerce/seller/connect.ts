import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/seller/connect")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceSellerConnect.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
