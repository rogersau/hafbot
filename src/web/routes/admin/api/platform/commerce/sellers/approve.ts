import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/platform/commerce/sellers/approve")({
  server: {
    handlers: {
      POST: handleAdminOperation("platformCommerceSellersApprove.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
