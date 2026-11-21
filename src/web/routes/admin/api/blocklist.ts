import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/blocklist")({
  server: {
    handlers: {
      GET: handleAdminOperation("blocklist.get"),
      POST: handleAdminOperation("blocklist.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
