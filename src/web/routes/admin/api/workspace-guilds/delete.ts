import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/workspace-guilds/delete")({
  server: {
    handlers: {
      POST: handleAdminOperation("workspaceGuildsDelete.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
