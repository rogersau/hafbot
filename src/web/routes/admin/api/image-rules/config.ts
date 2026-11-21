import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/image-rules/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("imageRulesConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
