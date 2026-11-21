import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/wardogs/targets")({
  server: {
    handlers: {
      POST: handleAdminOperation("wardogsTargets.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
