import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/community-moderation")({
  server: {
    handlers: {
      GET: handleAdminOperation("communityModeration.get"),
      POST: handleAdminOperation("communityModeration.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
