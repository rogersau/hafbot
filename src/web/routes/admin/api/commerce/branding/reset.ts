import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/branding/reset")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceBrandingReset.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
