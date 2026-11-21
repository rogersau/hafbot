import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/member-verification/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("memberVerificationConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
