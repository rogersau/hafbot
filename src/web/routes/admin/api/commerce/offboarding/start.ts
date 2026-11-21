import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/offboarding/start")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceOffboardingStart.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
