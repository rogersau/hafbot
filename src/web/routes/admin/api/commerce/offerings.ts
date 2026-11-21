import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/offerings")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceOfferings.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
