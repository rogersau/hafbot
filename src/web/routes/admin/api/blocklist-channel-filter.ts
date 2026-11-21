import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/blocklist-channel-filter")({
  server: {
    handlers: {
      POST: handleAdminOperation("blocklistChannelFilter.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
