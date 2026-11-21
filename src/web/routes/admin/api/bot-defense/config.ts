import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/bot-defense/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("botDefenseConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
