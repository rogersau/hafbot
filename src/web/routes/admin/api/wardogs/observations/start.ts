import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/wardogs/observations/start")({
  server: {
    handlers: {
      POST: handleAdminOperation("wardogsObservationsStart.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
