import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/player-count/test")({
  server: {
    handlers: {
      POST: handleAdminOperation("playerCountTest.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
