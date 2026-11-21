import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/member-verification/send-welcome-dm")({
  server: {
    handlers: {
      POST: handleAdminOperation("memberVerificationSendWelcomeDm.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
