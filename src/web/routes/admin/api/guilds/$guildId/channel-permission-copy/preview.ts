import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/guilds/$guildId/channel-permission-copy/preview")({
  server: {
    handlers: {
      POST: handleAdminOperation("channelPermissionCopy.preview.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
