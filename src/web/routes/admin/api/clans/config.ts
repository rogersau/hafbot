import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/clans/config")({
  server: {
    handlers: {
      PUT: handleAdminOperation("clansConfig.put"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
