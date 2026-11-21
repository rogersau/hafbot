import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/marketplace/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("marketplacePublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
