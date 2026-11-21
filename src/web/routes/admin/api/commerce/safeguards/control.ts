import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/safeguards/control")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceSafeguardsControl.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
