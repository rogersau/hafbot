import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/guilds/$guildId/channel-permission-copy/apply")({
  server: {
    handlers: {
      POST: handleAdminOperation("channelPermissionCopy.apply.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
