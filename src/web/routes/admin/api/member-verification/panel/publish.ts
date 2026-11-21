import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/member-verification/panel/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("memberVerificationPanelPublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
