import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/events")({
  server: {
    handlers: {
      GET: handleAdminOperation("events.get"),
      POST: handleAdminOperation("events.post"),
      PUT: handleAdminOperation("events.put"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
