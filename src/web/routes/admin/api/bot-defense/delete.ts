import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/bot-defense/delete")({
  server: {
    handlers: {
      POST: handleAdminOperation("botDefenseDelete.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
