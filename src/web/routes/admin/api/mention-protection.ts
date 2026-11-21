import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/mention-protection")({
  server: {
    handlers: {
      GET: handleAdminOperation("mentionProtection.get"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
