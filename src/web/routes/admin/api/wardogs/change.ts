import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/wardogs/change")({
  server: {
    handlers: {
      POST: handleAdminOperation("wardogsChange.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
