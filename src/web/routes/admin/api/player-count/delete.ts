import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/player-count/delete")({
  server: {
    handlers: {
      POST: handleAdminOperation("playerCountDelete.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
