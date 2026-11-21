import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/marketplace/disable")({
  server: {
    handlers: {
      POST: handleAdminOperation("marketplaceDisable.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
