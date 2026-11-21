import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/panel/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("commercePanelPublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
