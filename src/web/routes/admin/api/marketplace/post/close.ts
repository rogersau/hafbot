import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/marketplace/post/close")({
  server: {
    handlers: {
      POST: handleAdminOperation("marketplacePostClose.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
