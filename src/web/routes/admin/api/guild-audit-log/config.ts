import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/guild-audit-log/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("guildAuditLogConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
