import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/lfg/disable")({
  server: {
    handlers: {
      POST: handleAdminOperation("lfgDisable.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
