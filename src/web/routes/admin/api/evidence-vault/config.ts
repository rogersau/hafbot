import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/evidence-vault/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("evidenceVaultConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
