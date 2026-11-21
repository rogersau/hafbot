import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/lfg/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("lfgConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
