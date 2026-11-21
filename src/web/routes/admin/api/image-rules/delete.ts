import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/image-rules/delete")({
  server: {
    handlers: {
      POST: handleAdminOperation("imageRulesDelete.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
