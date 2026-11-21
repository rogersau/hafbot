import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/ban-cases/delete")({
  server: {
    handlers: {
      POST: handleAdminOperation("banCasesDelete.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
