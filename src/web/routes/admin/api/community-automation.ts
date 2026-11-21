import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/community-automation")({
  server: {
    handlers: {
      GET: handleAdminOperation("communityAutomation.get"),
      POST: handleAdminOperation("communityAutomation.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
