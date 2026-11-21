import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/timed-role-channel")({
  server: {
    handlers: {
      POST: handleAdminOperation("timedRoleChannel.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
