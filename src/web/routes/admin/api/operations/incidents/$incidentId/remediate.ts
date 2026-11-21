import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/operations/incidents/$incidentId/remediate")({
  server: {
    handlers: {
      POST: handleAdminOperation("operationsIncidents.remediate"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
