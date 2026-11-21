import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/evidence-vault/enabled")({
  server: {
    handlers: {
      POST: handleAdminOperation("evidenceVaultEnabled.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
