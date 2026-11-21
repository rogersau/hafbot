import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/branding")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceBranding.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
