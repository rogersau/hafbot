import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/clans/panel/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("clansPanelPublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
