import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/workspace-guilds")({
  server: {
    handlers: {
      GET: handleAdminOperation("workspaceGuilds.get"),
      POST: handleAdminOperation("workspaceGuilds.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
