import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/ban-cases/config/forum-channel")({
  server: {
    handlers: {
      POST: handleAdminOperation("banCasesConfigForumChannel.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
