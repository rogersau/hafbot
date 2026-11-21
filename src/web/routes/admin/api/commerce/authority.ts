import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/authority")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceAuthority.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
