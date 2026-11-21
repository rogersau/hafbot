import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/blocklist-channel")({
  server: {
    handlers: {
      POST: handleAdminOperation("blocklistChannel.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
