import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/wardogs/community")({
  server: {
    handlers: {
      GET: handleAdminOperation("wardogsCommunity.get"),
      POST: handleAdminOperation("wardogsCommunity.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
