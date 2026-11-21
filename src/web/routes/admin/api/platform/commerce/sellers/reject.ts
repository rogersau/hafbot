import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/platform/commerce/sellers/reject")({
  server: {
    handlers: {
      POST: handleAdminOperation("platformCommerceSellersReject.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
