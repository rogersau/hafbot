import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/support")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceSupport.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
