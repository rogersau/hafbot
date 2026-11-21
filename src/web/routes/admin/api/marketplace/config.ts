import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/marketplace/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("marketplaceConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
