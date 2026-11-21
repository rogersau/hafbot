import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/bot-defense/honeypot-channel")({
  server: {
    handlers: {
      POST: handleAdminOperation("botDefenseHoneypotChannel.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
