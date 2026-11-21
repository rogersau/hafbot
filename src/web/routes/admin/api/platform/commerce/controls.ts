import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/platform/commerce/controls")({
  server: {
    handlers: {
      POST: handleAdminOperation("platformCommerceControls.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
