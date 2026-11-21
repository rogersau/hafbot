import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/managed-messages")({
  server: {
    handlers: {
      DELETE: handleAdminOperation("managedMessages.delete"),
      GET: handleAdminOperation("managedMessages.get"),
      POST: handleAdminOperation("managedMessages.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
