import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/wardogs/test")({
  server: {
    handlers: {
      POST: handleAdminOperation("wardogsTest.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
