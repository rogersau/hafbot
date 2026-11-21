import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/message-templates")({
  server: {
    handlers: {
      DELETE: handleAdminOperation("messageTemplates.delete"),
      GET: handleAdminOperation("messageTemplates.get"),
      POST: handleAdminOperation("messageTemplates.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
