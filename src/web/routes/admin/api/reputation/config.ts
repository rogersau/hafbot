import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/reputation/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("reputation.config.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
