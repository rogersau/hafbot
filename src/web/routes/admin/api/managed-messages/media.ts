import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/managed-messages/media")({
  server: {
    handlers: {
      POST: handleAdminOperation("managedMessages.media.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
