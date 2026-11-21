import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/blocklist/enabled")({
  server: {
    handlers: {
      POST: handleAdminOperation("blocklistEnabled.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
