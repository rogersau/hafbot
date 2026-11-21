import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/offboarding/complete")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceOffboardingComplete.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
