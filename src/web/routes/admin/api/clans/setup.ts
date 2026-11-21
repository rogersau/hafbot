import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/clans/setup")({
  server: {
    handlers: {
      POST: handleAdminOperation("clansSetup.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
