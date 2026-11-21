import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/managed-messages/resources")({
  server: {
    handlers: {
      GET: handleAdminOperation("managedMessagesResources.get"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
