import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/mention-protection/delete")({
  server: {
    handlers: {
      POST: handleAdminOperation("mentionProtectionDelete.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
