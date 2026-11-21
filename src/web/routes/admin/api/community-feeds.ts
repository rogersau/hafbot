import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/community-feeds")({
  server: {
    handlers: {
      GET: handleAdminOperation("communityFeeds.get"),
      POST: handleAdminOperation("communityFeeds.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
