import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/operations/incidents/$incidentId")({
  server: {
    handlers: {
      GET: handleAdminOperation("operationsIncidents.getById"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
