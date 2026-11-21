import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/wardogs/observations/stop")({
  server: {
    handlers: {
      POST: handleAdminOperation("wardogsObservationsStop.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
