import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/panel/unpublish")({
  server: {
    handlers: {
      POST: handleAdminOperation("commercePanelUnpublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
